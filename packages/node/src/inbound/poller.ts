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
// The furthest back a poll ever reads (R31). A cursor older than this (polling was off or the
// process down for longer, or paging stayed incomplete) is clamped, and the clamp is logged at
// error level: texts older than this are never fetched, so never auto-replied to months later.
const MAX_LOOKBACK_MS = 24 * 3_600_000;
// A complete tick with no traffic leaves the cursor at the last message. Once that is this
// stale, it moves up to now (minus the overlap), so a quiet number never reaches the clamp.
const QUIET_ADVANCE_MS = 3_600_000;
const PAGE_SIZE = '100';
// Guards against a marker that never ends (same cap as directory.ts listNumbers).
const MAX_PAGES = 50;

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
  /** The saved cursor last reported as clamped, so a held cursor logs once, not every tick. */
  private clampLogged: number | undefined;

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

  /** Moves the cursor to now, so the next poll reads only from here on. */
  async resetCursor(): Promise<void> {
    await this.o.store.set(this.o.tenant, CURSOR_KEY, new Date(this.o.now()).toISOString());
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

  /**
   * GET every page of a list, following `nextPageMarker` as directory.ts does. `complete` is
   * false when the page cap was hit or a marker repeated (a loop), i.e. items may be missing.
   */
  private async allPages<T>(
    path: string,
    query: Record<string, string>,
  ): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    const markers = new Set<string>();
    let marker: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.o.http.json<{ items?: T[]; nextPageMarker?: unknown }>(
        'GET',
        path,
        undefined,
        { query: { ...query, pageSize: PAGE_SIZE, ...(marker ? { pageMarker: marker } : {}) } },
      );
      items.push(...(res.items ?? []));
      const next = res.nextPageMarker;
      if (typeof next !== 'string' || next === '') return { items, complete: true };
      if (markers.has(next)) return { items, complete: false };
      markers.add(next);
      marker = next;
    }
    return { items, complete: false };
  }

  private async poll(): Promise<number> {
    const { config, processor, store, tenant, now, logger } = this.o;
    const owner = (await config.resolve()).fromNumber;
    if (!owner) {
      logger.debug('goto-sms: polling skipped; no sending number chosen');
      return 0;
    }

    // No cursor yet (first poll ever): start from now rather than replaying old history.
    const tickAt = now();
    const savedCursor = ms(await store.get(tenant, CURSOR_KEY));
    let cursor = Number.isNaN(savedCursor) ? tickAt : savedCursor;
    const floor = tickAt - MAX_LOOKBACK_MS;
    if (cursor - OVERLAP_MS < floor) {
      cursor = floor + OVERLAP_MS;
      if (this.clampLogged !== savedCursor) {
        this.clampLogged = savedCursor;
        logger.error(
          'goto-sms: the poll cursor is more than 24 h old; texts before then are not fetched',
          { cursor: new Date(savedCursor).toISOString() },
        );
      }
    }
    const oldest = cursor - OVERLAP_MS;
    const oldestTimestamp = new Date(oldest).toISOString();

    // Every page is read: the cursor advances past whatever the window held, so a text on
    // an unread page (a STOP, after downtime or a bulk send) would otherwise be lost for good.
    let complete = true;
    const conversations = await this.allPages<Conversation>(CONVERSATIONS, {
      ownerPhoneNumber: owner,
      oldestTimestamp,
    });
    if (!conversations.complete) complete = false;
    const batch: Array<{ at: number; m: GoToMessage }> = [];
    // The cursor follows all traffic, ours included (like geeks-tracker's use of
    // lastMessageTimestamp). Following only inbound texts would park it at the last reply,
    // and a busy sender would then re-list every contact texted since, every tick.
    // It's saved only after every new message is persisted, so a failed tick loses nothing.
    let newest = cursor;
    const seenAt = (t: number) => {
      if (!Number.isNaN(t) && t > newest) newest = t;
    };
    for (const c of conversations.items) {
      const last = ms(c.lastMessageTimestamp);
      // Nothing new in this conversation. Strictly older only: µs and ms stamps can parse equal.
      if (last < oldest) continue;
      const contacts = Array.isArray(c.contactPhoneNumbers) ? c.contactPhoneNumbers : [];
      const contact = str(contacts[0]);
      if (!contact) continue;
      seenAt(last);
      const msgs = await this.allPages<GoToMessage>(MESSAGES, {
        ownerPhoneNumber: owner,
        contactPhoneNumber: contact,
        oldestTimestamp,
      });
      if (!msgs.complete) complete = false;
      for (const m of msgs.items) {
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
    if (!complete) {
      // Paging was cut short, so texts newer than what we saw may be unread: keep the cursor
      // and read the window again next tick (persist() skips what's already stored). The
      // 24 h clamp above stops that window growing for good.
      logger.warn('goto-sms: GoTo paging did not finish; the poll cursor was not advanced');
    } else {
      // Everything since `oldest` was read, so a stale cursor can safely move up to now.
      if (newest < tickAt - QUIET_ADVANCE_MS) newest = tickAt - OVERLAP_MS;
      if (newest !== savedCursor) {
        await store.set(tenant, CURSOR_KEY, new Date(newest).toISOString());
      }
    }

    await processor.replayPending();
    return added;
  }
}
