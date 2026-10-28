// Inbound texts by polling, for hosts GoTo can't reach with a webhook. Follows the
// geeks-tracker `fetchInbound` pattern: list recent conversations on the sending number,
// then each conversation's messages since the cursor.
import type { ConfigResolver } from '../config.js';
import { GoToSmsError } from '../errors.js';
import { errorName, type GoToHttp } from '../http.js';
import { normalizePhone } from '../phone.js';
import type { GoToSmsStore } from '../store/types.js';
import type { InboundMessage, Logger } from '../types.js';
import type { InboundProcessor } from './processor.js';

const CONVERSATIONS = '/messaging/v1/conversations';
const MESSAGES = '/messaging/v1/messages';
const CURSOR_KEY = 'poll:cursor';
// Each poll reaches back this far before the cursor, to absorb clock and precision skew.
// Repeats are harmless: processor.persist() refuses ids it has already seen.
const OVERLAP_MS = 5 * 60_000;
const PAGE_SIZE = '100';

interface Conversation {
  contactPhoneNumbers?: unknown;
  lastMessageTimestamp?: unknown;
}
interface GoToMessage {
  id?: unknown;
  direction?: unknown;
  authorPhoneNumber?: unknown;
  ownerPhoneNumber?: unknown;
  body?: unknown;
  timestamp?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** GoTo mixes µs and ms precision, so timestamps are compared as parsed numbers, never strings. */
const ms = (v: unknown): number => {
  const t = Date.parse(str(v));
  return Number.isNaN(t) ? NaN : t;
};

export interface PollerOptions {
  http: GoToHttp;
  config: ConfigResolver;
  processor: InboundProcessor;
  store: GoToSmsStore;
  tenant: string;
  intervalMs: number;
  now: () => number;
  logger: Logger;
}

/**
 * Polls GoTo for inbound texts. Each tick persists new messages (oldest first) through the
 * processor, then runs `replayPending()`, which processes them in arrival order and also
 * retries any row an earlier attempt left pending (e.g. a failed opt-out write).
 */
export class Poller {
  private readonly o: PollerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The tick in flight; ticks never overlap, and close() waits for it. */
  private current: Promise<number> | undefined;

  constructor(o: PollerOptions) {
    this.o = o;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** One poll. Returns how many new messages were stored. Throws on API/store errors. */
  tick(): Promise<number> {
    this.current ??= this.poll().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  /** Polls now (to catch up from the cursor), then every intervalMs. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.safeTick(), this.o.intervalMs);
    // Never keep the host process alive just to poll.
    this.timer.unref();
    void this.safeTick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Resolves once no tick is in flight (used by close()). */
  async idle(): Promise<void> {
    await this.current?.catch(() => {});
  }

  // --- internals ---

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.o.logger.warn('goto-sms: polling for inbound texts failed', { error: errorName(err) });
    }
  }

  private async poll(): Promise<number> {
    const { http, config, processor, store, tenant, now, logger } = this.o;
    const owner = (await config.resolve()).fromNumber;
    if (!owner) {
      logger.debug('goto-sms: polling skipped; no sending number chosen');
      return 0;
    }

    // No cursor yet (first poll ever): start from now rather than replaying old history.
    const savedCursor = ms(await store.get(tenant, CURSOR_KEY));
    const cursor = Number.isNaN(savedCursor) ? now() : savedCursor;
    const oldestTimestamp = new Date(cursor - OVERLAP_MS).toISOString();

    const convs = await http.json<{ items?: Conversation[] }>('GET', CONVERSATIONS, undefined, {
      query: { ownerPhoneNumber: owner, oldestTimestamp, pageSize: PAGE_SIZE },
    });
    const batch: Array<{ at: number; m: GoToMessage }> = [];
    // The cursor follows all traffic, ours included (like geeks-tracker's use of
    // lastMessageTimestamp). Following only inbound texts would park it at the last reply,
    // and a busy sender would then re-list every contact texted since, every tick.
    // It's saved only after every new message is persisted, so a failed tick loses nothing.
    let newest = cursor;
    const seenAt = (t: number) => {
      if (!Number.isNaN(t) && t > newest) newest = t;
    };
    const oldest = cursor - OVERLAP_MS;
    for (const c of convs.items ?? []) {
      const last = ms(c.lastMessageTimestamp);
      // Nothing new in this conversation. Strictly older only: µs and ms stamps can parse equal.
      if (last < oldest) continue;
      const contacts = Array.isArray(c.contactPhoneNumbers) ? c.contactPhoneNumbers : [];
      const contact = str(contacts[0]);
      if (!contact) continue;
      seenAt(last);
      const msgs = await http.json<{ items?: GoToMessage[] }>('GET', MESSAGES, undefined, {
        query: { ownerPhoneNumber: owner, contactPhoneNumber: contact, oldestTimestamp },
      });
      for (const m of msgs.items ?? []) {
        const at = ms(m.timestamp);
        seenAt(at);
        if (m.direction !== 'IN' && m.direction !== 'INBOUND') continue;
        batch.push({ at, m });
      }
    }
    // Oldest first, so a START then a STOP from one number ends opted out. Unparseable
    // timestamps go last.
    const order = (t: number) => (Number.isNaN(t) ? Infinity : t);
    batch.sort((a, b) => order(a.at) - order(b.at));

    let added = 0;
    for (const { at, m } of batch) {
      const fromRaw = str(m.authorPhoneNumber);
      const from = normalizePhone(fromRaw) ?? fromRaw;
      if (from === owner) continue; // our own number: never treat our sends as inbound
      const msg: Omit<InboundMessage, 'keyword'> = {
        id: str(m.id),
        from,
        to: normalizePhone(str(m.ownerPhoneNumber)) ?? owner,
        text: str(m.body).trim(),
        receivedAt: Number.isNaN(at) ? new Date(now()).toISOString() : str(m.timestamp),
        raw: m,
      };
      try {
        if (await processor.persist(msg)) added++;
      } catch (err) {
        // A message that can't be stored (no id/sender/text) would fail every poll; skip it
        // rather than wedge the tick. Any other error (the store) aborts the tick before the
        // cursor is saved, so the message is fetched again next time.
        if (!(err instanceof GoToSmsError && err.code === 'invalid_inbound')) throw err;
        logger.warn('goto-sms: skipped an inbound text with no id, sender or body');
      }
    }
    if (newest !== savedCursor) await store.set(tenant, CURSOR_KEY, new Date(newest).toISOString());

    await processor.replayPending();
    return added;
  }
}
