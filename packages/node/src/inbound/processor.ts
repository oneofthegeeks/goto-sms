import { GoToSmsError } from '../errors.js';
import { errorName } from '../http.js';
import { PRUNE_EVERY, type MessageLog } from '../log.js';
import type { OptOuts } from '../optouts.js';
import { normalizePhone } from '../phone.js';
import type { Sender } from '../send.js';
import type { GoToSmsStore, Json } from '../store/types.js';
import type { InboundMessage, Keyword, Logger } from '../types.js';
import { detectKeyword, type KeywordReplies } from './keywords.js';

const PENDING_PREFIX = 'inbound:pending:';
const SEEN_PREFIX = 'inbound:seen:';
const RATE_PREFIX = 'rate:';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DEFAULT_SEEN_RETENTION_DAYS = 90;

export interface InboundProcessorOptions {
  store: GoToSmsStore;
  tenant: string;
  sender: Sender;
  optOuts: OptOuts;
  log: MessageLog;
  emit: (m: InboundMessage) => void;
  replies: KeywordReplies;
  yesIsOptIn: boolean;
  /** Texts per number per clock hour that reach `emit`; keywords are handled regardless. */
  perHour: number;
  now: () => number;
  logger: Logger;
  /** How long a handled GoTo id is remembered for dedupe. Matches the log's retention. */
  seenRetentionDays?: number;
}

const last4 = (phone: string): string => phone.replace(/\D/g, '').slice(-4);

const isObject = (v: Json | undefined): v is { [k: string]: Json } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * A stored pending row back to a message; undefined if it isn't one. Only id, from and text
 * are required (what keyword handling needs), so a STOP is never dropped over a missing
 * `to` or `receivedAt`. `fallbackAt` is used if a row somehow lacks `receivedAt`.
 */
function fromRow(
  v: Json | undefined,
  fallbackAt: string,
): Omit<InboundMessage, 'keyword'> | undefined {
  if (!isObject(v)) return undefined;
  const { id, from, to, text, receivedAt, accountKey } = v;
  if (!nonEmpty(id) || !nonEmpty(from) || !nonEmpty(text)) return undefined;
  return {
    id,
    from,
    to: typeof to === 'string' ? to : '',
    text,
    receivedAt: typeof receivedAt === 'string' ? receivedAt : fallbackAt,
    ...(typeof accountKey === 'string' ? { accountKey } : {}),
    raw: v.raw ?? null,
  };
}

/**
 * Handles inbound texts durably. A webhook/poller calls `persist()` first (so a crash can't
 * lose a STOP), then `process()`. On start, `replayPending()` finishes anything persisted
 * but not processed. Keywords (STOP/START/HELP) are acted on before the rate limit, so a
 * flood of texts can never swallow an opt-out.
 */
export class InboundProcessor {
  private readonly o: InboundProcessorOptions;
  private readonly seenRetentionDays: number;
  /** Ids being processed in this process; a concurrent call for the same id is a no-op. */
  private readonly inProgress = new Set<string>();
  private processed = 0;

  constructor(o: InboundProcessorOptions) {
    this.o = o;
    this.seenRetentionDays = o.seenRetentionDays ?? DEFAULT_SEEN_RETENTION_DAYS;
  }

  /**
   * Stores the message as pending. False if this GoTo id was already seen or is pending.
   * Throws `invalid_inbound` when id, from or text is missing, so the caller doesn't
   * acknowledge a message that couldn't be stored.
   */
  async persist(m: Omit<InboundMessage, 'keyword'>): Promise<boolean> {
    const { store, tenant, now } = this.o;
    // Checked at runtime: the message comes from a parsed GoTo payload, not typed code.
    if (!nonEmpty(m.id) || !nonEmpty(m.from) || !nonEmpty(m.text)) {
      throw new GoToSmsError('Inbound text is missing its id, sender or body', 'invalid_inbound');
    }
    if ((await store.get(tenant, SEEN_PREFIX + m.id)) !== undefined) return false;
    // Fields are picked one by one: the row must be pure JSON (no undefined values).
    const row: Json = {
      id: m.id,
      from: m.from,
      // `to` and `receivedAt` are optional in practice; default them so the row is complete.
      to: typeof m.to === 'string' ? m.to : '',
      text: m.text,
      receivedAt: typeof m.receivedAt === 'string' ? m.receivedAt : new Date(now()).toISOString(),
      ...(m.accountKey !== undefined ? { accountKey: m.accountKey } : {}),
      // GoTo's payload is parsed JSON, so it is stored as-is.
      raw: (m.raw ?? null) as Json,
    };
    // compareAndSet against "absent" makes the duplicate check and the write one step.
    return store.compareAndSet(tenant, PENDING_PREFIX + m.id, undefined, row);
  }

  /**
   * Handles one pending message. Throws only if a store write fails, in which case the
   * pending row stays and `replayPending()` retries it.
   */
  async process(id: string): Promise<void> {
    if (this.inProgress.has(id)) return;
    this.inProgress.add(id);
    try {
      await this.handle(id);
    } finally {
      this.inProgress.delete(id);
    }
  }

  /** Processes every pending message in arrival order. Returns how many were handled. */
  async replayPending(): Promise<number> {
    const { store, tenant, logger } = this.o;
    // Keys sort by GoTo id, which isn't time order. Order matters: a START then a STOP
    // from one number must end opted out, so replay by receivedAt (unreadable rows last,
    // where handle() drops them), with the key as a stable tie-break.
    const arrival = (v: Json): number => {
      const t = isObject(v) && typeof v.receivedAt === 'string' ? Date.parse(v.receivedAt) : NaN;
      return Number.isNaN(t) ? Infinity : t;
    };
    const pending = (await store.list(tenant, PENDING_PREFIX))
      .map((e) => ({ key: e.key, at: arrival(e.value) }))
      .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let count = 0;
    for (const { key } of pending) {
      try {
        await this.process(key.slice(PENDING_PREFIX.length));
        count++;
      } catch (err) {
        // Left pending for the next replay; keep going with the others.
        logger.warn('goto-sms: could not process a pending inbound text', {
          error: errorName(err),
        });
      }
    }
    return count;
  }

  /** Drops rate buckets before the current hour and seen ids past their retention. */
  async prune(): Promise<void> {
    const { store, tenant, now } = this.o;
    const t = now();
    const hour = Math.floor(t / HOUR_MS);
    for (const { key } of await store.list(tenant, RATE_PREFIX)) {
      // `rate:<from>:<bucket>`; the bucket is after the last colon.
      const bucket = Number(key.slice(key.lastIndexOf(':') + 1));
      if (!(bucket >= hour)) await store.delete(tenant, key);
    }
    const cutoff = t - this.seenRetentionDays * DAY_MS;
    for (const { key, value } of await store.list(tenant, SEEN_PREFIX)) {
      const at = isObject(value) ? value.at : undefined;
      if (typeof at !== 'number' || at < cutoff) await store.delete(tenant, key);
    }
  }

  // --- internals ---

  private async handle(id: string): Promise<void> {
    const { store, tenant, now, logger } = this.o;
    const pendingKey = PENDING_PREFIX + id;
    const row = await store.get(tenant, pendingKey);
    if (row === undefined) return;
    if ((await store.get(tenant, SEEN_PREFIX + id)) !== undefined) {
      await store.delete(tenant, pendingKey);
      return;
    }
    const msg = fromRow(row, new Date(now()).toISOString());
    if (!msg) {
      // Unreadable row: drop it rather than fail on it at every replay.
      logger.warn('goto-sms: dropped a malformed pending inbound row');
      await store.delete(tenant, pendingKey);
      return;
    }

    // Keyword first, before the rate limit: a STOP must take effect even mid-flood.
    const keyword = detectKeyword(msg.text, { yesIsOptIn: this.o.yesIsOptIn });
    if (keyword) await this.applyKeyword(keyword, msg);

    if (await this.overRateLimit(msg.from)) {
      await this.logInbound(msg, 'rate_limited');
      logger.info(`goto-sms: inbound from …${last4(msg.from)}: rate_limited`);
    } else {
      await this.logInbound(msg, 'received');
      logger.info(
        `goto-sms: inbound from …${last4(msg.from)}: received${keyword ? ` (${keyword})` : ''}`,
      );
      try {
        this.o.emit(keyword ? { ...msg, keyword } : msg);
      } catch (err) {
        // Only the error's name: a handler's message could quote the text.
        logger.warn('goto-sms: inbound handler threw', { error: errorName(err) });
      }
    }

    // Marked seen only after emit: a crash in between replays the message, so delivery is
    // at-least-once (the keyword reply is deduped by its dedupeKey; the handler may see a
    // message twice). Marking first would make it at-most-once and could lose a message.
    await store.set(tenant, SEEN_PREFIX + id, { at: now() });
    await store.delete(tenant, pendingKey);

    if (++this.processed % PRUNE_EVERY === 0) {
      try {
        await this.prune();
      } catch (err) {
        logger.warn('goto-sms: could not prune inbound records', { error: errorName(err) });
      }
    }
  }

  /**
   * Saves the opt-out change (store errors propagate, so the message stays pending and is
   * retried), then sends the reply. A failed reply is only logged.
   */
  private async applyKeyword(keyword: Keyword, msg: Omit<InboundMessage, 'keyword'>) {
    const { optOuts, replies, logger, now } = this.o;
    const from = normalizePhone(msg.from);
    if (from === null) {
      // OptOuts can't store a number it can't normalize; failing here would make the row
      // fail at every replay. There's nothing to opt out and no number to reply to.
      logger.warn(`goto-sms: ${keyword} from unusable number …${last4(msg.from)}; ignored`);
      return;
    }
    if (keyword === 'STOP') await optOuts.add(msg.from, 'keyword');
    if (keyword === 'START') await optOuts.remove(msg.from);

    const text =
      keyword === 'STOP' ? replies.stop : keyword === 'START' ? replies.start : replies.help;
    try {
      // bypassOptOut only for STOP (its confirmation goes to a number that just opted out)
      // and HELP (carriers require it answered even for opted-out numbers). START must not
      // bypass: if a STOP landed after the removal above, the START reply must not go out.
      //
      // The dedupeKey allows one reply per keyword per number per clock hour, so a flood of
      // keyword texts can't be used to make us send unlimited texts. It also covers a replay
      // after a crash. Trade-off: STOP→START→STOP within one hour gets only the first STOP
      // confirmation (and one START reply); the opt-out state is still applied every time.
      const hour = Math.floor(now() / HOUR_MS);
      const r = await this.o.sender.send(msg.from, text, {
        bypassOptOut: keyword !== 'START',
        dedupeKey: `reply:${from}:${keyword}:${hour}`,
      });
      if (r.status !== 'sent') {
        logger.warn(`goto-sms: ${keyword} reply not sent: ${r.status}`);
      }
    } catch (err) {
      logger.warn(`goto-sms: ${keyword} reply failed`, { error: errorName(err) });
    }
  }

  /** Counts this text against its number's current hour; true once over `perHour`. */
  private async overRateLimit(from: string): Promise<boolean> {
    const { store, tenant, now, perHour } = this.o;
    const key = `${RATE_PREFIX}${from}:${Math.floor(now() / HOUR_MS)}`;
    // Compare-and-set loop so two processes sharing a store can't lose an increment.
    for (;;) {
      const current = await store.get(tenant, key);
      const count = typeof current === 'number' ? current : 0;
      if (await store.compareAndSet(tenant, key, current, count + 1)) return count + 1 > perHour;
    }
  }

  private async logInbound(msg: Omit<InboundMessage, 'keyword'>, status: string): Promise<void> {
    try {
      await this.o.log.append({
        direction: 'inbound',
        from: msg.from,
        to: msg.to,
        status,
        gotoId: msg.id,
      });
    } catch (err) {
      this.o.logger.warn('goto-sms: could not write the message log', { error: errorName(err) });
    }
  }
}
