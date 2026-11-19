// Inbound calls to the sending number, by polling GoTo's call reports (`watchCalls: true`).
//
// A port of aiogotoconnect's sms/inbound/calls.py: the same algorithm, constants, store keys
// and store formats, so a store written by one package reads correctly in the other. Shaped
// like poller.ts: its own timer, one look at a time, state in the store. The
// call-events-report API is only partly documented; this is what was observed live
// (2026-11-19):
//
//   GET /call-events-report/v1/report-summaries?accountKey&startTime&endTime[&pageSize&pageMarker]
//       -> {"pageSize", "nextPageMarker"?, "items": [...]}, one item per call on the WHOLE
//       account: conversationSpaceId, callCreated, callEnded, direction (INBOUND/OUTBOUND),
//       callerOutcome (MISSED, NORMAL, LEFT_DIAL_PLAN, ...), caller {name, number, type
//       {value, number}}. For an outside call in, caller.type.value is PHONE_NUMBER and
//       caller.type.number is the number that was DIALLED; caller.name / caller.number are
//       who called.
//   GET /call-events-report/v1/reports/{conversationSpaceId}
//       -> participants[].type {value: PHONE_NUMBER, number: dialled, caller {name, number}}.
//       Read only when a summary does not name the dialled number.
//
// A report appears once the call has ended. One ring can be reported as two conversations.
// Reading needs the scope cr.v1.read on the OAuth client. Caller ID is whatever the caller's
// carrier sent: it is data, it can be spoofed, and it never appears in a log line at info or
// above.
import type { ConfigResolver } from '../config.js';
import { GoToApiError, LoginExpiredError, NotConfiguredError, TemporaryError } from '../errors.js';
import { errorName, type GoToHttp } from '../http.js';
import { normalizePhone } from '../phone.js';
import { jsonEqual, type GoToSmsStore, type Json } from '../store/types.js';
import type { InboundCall, Logger } from '../types.js';
import { ms } from './poller.js';

export const SUMMARIES = '/call-events-report/v1/report-summaries';
export const REPORTS = '/call-events-report/v1/reports/';
export const CURSOR_KEY = 'calls:cursor';
// When watching was first switched on. Calls that started before it are never delivered.
const SINCE_KEY = 'calls:since';
// [[id, ring, atMs], ...]: every call already looked at. `ring` is set only for a delivered
// call whose caller number is a real one: "<E.164>|<outcome>", the memory for the double-ring
// rule. It is "" for everything else.
const SEEN_KEY = 'calls:seen';
export const ERROR_KEY = 'calls:error';
// Written by oauth.ts: the sealed token record. Read here only to notice that it changed.
const TOKENS_KEY = 'tokens';

// Each look reaches back this far before the cursor. A report appears only after the call
// ends, and the list is searched by when the call STARTED, so this is also the longest call
// that can still be noticed. (Whether GoTo filters on the start or the end is not documented;
// the start is the safe assumption.)
const REACH_BACK_MS = 2 * 3_600_000;
// The furthest back a look ever reads, however stale the cursor (as poller.ts MAX_LOOKBACK_MS).
const MAX_LOOKBACK_MS = 24 * 3_600_000;
// One ring reported as two conversations: the same caller with the same outcome again within
// this long is not an event. A different outcome (voicemail, then a miss) is a second call.
const DOUBLE_RING_MS = 120_000;
// Seen entries older than the reach-back are dropped, oldest first, down to this many.
const SEEN_CAP = 400;
// The window of the very first look. GoTo answers 400 to an empty one (startTime == endTime).
const FIRST_LOOK_MS = 60_000;
const PAGE_SIZE = '100';
const MAX_PAGES = 50;
// While GoTo refuses the call reports (scope missing), look only this often. A 401 makes
// GoToHttp refresh the token before giving up; every two minutes, for good, would be abuse.
const REFUSED_BACKOFF_MS = 3_600_000;
export const SCOPE_MESSAGE =
  'GoTo refused the call reports. Enable the scope cr.v1.read on the OAuth client, ' +
  'then reconnect.';
const NAME_MAX = 40;
const NUMBER_MAX = 20;

type Dict = Record<string, unknown>;
type Seen = [id: string, ring: string, atMs: number];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const dict = (v: unknown): Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Dict) : {};
/** The first `max` characters (code points, as Python counts them, so no half surrogate). */
const cut = (text: string, max: number): string => Array.from(text).slice(0, max).join('');
const iso = (t: number): string => new Date(t).toISOString();
/** Whole seconds with a Z, the form GoTo's own examples use for startTime / endTime. */
const isoSeconds = (t: number): string =>
  new Date(Math.floor(t / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** E.164 when it normalises, else GoTo's text cut short; '' when withheld. */
function number(raw: unknown): string {
  const text = str(raw).trim();
  return normalizePhone(text) ?? cut(text, NUMBER_MAX);
}

// Whitespace as Python's str.split() sees it: \s plus the separators U+001C-U+001F and U+0085.
// eslint-disable-next-line no-control-regex
const WHITESPACE = /[\s\u001c-\u001f\u0085]+/;
/** Caller ID with whitespace collapsed, cut short; undefined when there is none. */
function name(raw: unknown): string | undefined {
  const text = cut(str(raw).split(WHITESPACE).filter(Boolean).join(' '), NAME_MAX);
  return text === '' ? undefined : text;
}

export interface CallWatcherOptions {
  http: GoToHttp;
  config: ConfigResolver;
  store: GoToSmsStore;
  tenant: string;
  /** Resolves once every handler has returned; the call is saved as seen only after that. */
  emit: (call: InboundCall) => Promise<void>;
  intervalMs: number;
  now: () => number;
  logger: Logger;
}

/**
 * Polls GoTo's call reports and emits one `InboundCall` per call dialled to the sending
 * number. Delivery is at least once: a call is marked seen after `emit` resolves, so a crash
 * in between delivers that one call again.
 */
export class CallWatcher {
  private readonly o: CallWatcherOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The look in flight; looks never overlap, and close() waits for it. */
  private current: Promise<number> | undefined;
  /**
   * When GoTo last refused the call reports (epoch ms). In memory only, so a restart looks
   * once before backing off again.
   */
  private refusedAt: number | undefined;
  /**
   * The stored login (the sealed token record) at that moment. A different one means the
   * admin reconnected, or the token was renewed: worth one more look.
   */
  private refusedLogin: Json | undefined;

  constructor(o: CallWatcherOptions) {
    this.o = o;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /**
   * One look. Returns how many calls were delivered. Concurrent callers share the one look in
   * flight (and its result or error).
   */
  tick(): Promise<number> {
    this.current ??= this.look().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  /** Looks now, then every intervalMs. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.safeTick(), this.o.intervalMs);
    // Never keep the host process alive just to watch for calls.
    this.timer.unref();
    void this.safeTick();
  }

  /** Stops the timer. A look already in flight finishes; `idle()` waits for it. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Resolves once no look is in flight (used by close()). */
  async idle(): Promise<void> {
    await this.current?.catch(() => {});
  }

  // --- internals ---

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      // Nothing may kill the loop.
      this.o.logger.warn('goto-sms: checking for calls failed', { error: errorName(err) });
    }
  }

  /**
   * Every page of the summaries list, following `nextPageMarker` as the text poller does.
   * `complete` is false when the page cap was hit or a marker repeated: items may be missing.
   */
  private async summaries(
    query: Record<string, string>,
  ): Promise<{ items: Dict[]; complete: boolean }> {
    const items: Dict[] = [];
    const markers = new Set<string>();
    let marker: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = dict(
        await this.o.http.json<unknown>('GET', SUMMARIES, undefined, {
          query: { ...query, pageSize: PAGE_SIZE, ...(marker ? { pageMarker: marker } : {}) },
        }),
      );
      if (Array.isArray(res.items)) {
        for (const item of res.items) {
          if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
            items.push(item as Dict);
          }
        }
      }
      const next = res.nextPageMarker;
      if (typeof next !== 'string' || next === '') return { items, complete: true };
      if (markers.has(next)) return { items, complete: false };
      markers.add(next);
      marker = next;
    }
    return { items, complete: false };
  }

  /**
   * The caller and the report, from the full report, when the summary did not name the
   * dialled number: the PHONE_NUMBER participant dialled to `owner` decides. undefined: not a
   * call to us.
   */
  private async fromReport(
    callId: string,
    owner: string,
  ): Promise<{ caller: Dict; report: unknown } | undefined> {
    const report = await this.o.http.json<unknown>('GET', REPORTS + encodeURIComponent(callId));
    const participants = dict(report).participants;
    for (const participant of Array.isArray(participants) ? participants : []) {
      const kind = dict(dict(participant).type);
      if (kind.value === 'PHONE_NUMBER' && number(kind.number) === owner) {
        return { caller: dict(kind.caller), report };
      }
    }
    return undefined;
  }

  /**
   * Records why the look failed, for `status().calls`. The cursor is left alone, so the next
   * good look reads the same window.
   */
  private async failed(
    err: LoginExpiredError | GoToApiError | TemporaryError,
    now: number,
  ): Promise<void> {
    const { store, tenant, logger } = this.o;
    let error: { error: string; message: string; gotoStatus?: number };
    if (err instanceof LoginExpiredError || (err instanceof GoToApiError && err.status === 403)) {
      if ((await store.get(tenant, 'login_expired')) === true) {
        // The login itself is dead (no request went out): say that, not "scope".
        error = { error: 'login_expired', message: err.message };
      } else {
        // GoToHttp throws LoginExpiredError when a freshly refreshed token gets a second 401.
        // For this API that means the scope is missing, not that the login is gone: nothing
        // here marks the login expired, and texting carries on.
        const status = err instanceof GoToApiError ? err.status : 401;
        error = { error: 'calls_scope', message: SCOPE_MESSAGE, gotoStatus: status };
        this.refusedAt = now;
        this.refusedLogin = await store.get(tenant, TOKENS_KEY);
      }
    } else if (err instanceof GoToApiError) {
      error = { error: 'goto_api', message: err.message, gotoStatus: err.status };
    } else {
      error = { error: 'goto_unreachable', message: 'GoTo could not be reached' };
    }
    if (!jsonEqual(await store.get(tenant, ERROR_KEY), error)) {
      await store.set(tenant, ERROR_KEY, error);
      if (error.error === 'calls_scope') logger.warn(`goto-sms: ${SCOPE_MESSAGE}`);
      else logger.warn('goto-sms: checking for calls failed', { error: error.error });
    }
  }

  private async loadSeen(): Promise<Seen[]> {
    const stored = await this.o.store.get(this.o.tenant, SEEN_KEY);
    const seen: Seen[] = [];
    for (const entry of Array.isArray(stored) ? stored : []) {
      if (
        Array.isArray(entry) &&
        entry.length === 3 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string' &&
        typeof entry[2] === 'number'
      ) {
        seen.push([entry[0], entry[1], entry[2]]);
      }
    }
    return seen;
  }

  private async saveSeen(seen: Seen[]): Promise<void> {
    await this.o.store.set(
      this.o.tenant,
      SEEN_KEY,
      seen.map(([id, ring, at]) => [id, ring, at]),
    );
  }

  private async look(): Promise<number> {
    const { config, store, tenant, logger } = this.o;
    const resolved = await config.resolve();
    const owner = resolved.fromNumber;
    const accountKey = resolved.accountKey;
    if (!owner || !accountKey) {
      logger.debug('goto-sms: call check skipped; no account or sending number chosen');
      return 0;
    }

    const now = this.o.now();
    if (
      this.refusedAt !== undefined &&
      now - this.refusedAt >= 0 &&
      now - this.refusedAt < REFUSED_BACKOFF_MS &&
      jsonEqual(await store.get(tenant, TOKENS_KEY), this.refusedLogin)
    ) {
      return 0;
    }
    const cursor = ms(await store.get(tenant, CURSOR_KEY));
    let start: number;
    if (Number.isNaN(cursor)) {
      // The first look ever: start from now. Old calls are never imported: whatever the
      // request below finds started before `since` and is only marked seen. It still goes
      // out, so a missing scope shows up at once.
      await store.set(tenant, SINCE_KEY, iso(now));
      await store.set(tenant, CURSOR_KEY, iso(now));
      start = now - FIRST_LOOK_MS;
    } else {
      start = Math.max(cursor - REACH_BACK_MS, now - MAX_LOOKBACK_MS);
    }
    const since = ms(await store.get(tenant, SINCE_KEY));
    let summaries: Dict[];
    let complete: boolean;
    try {
      ({ items: summaries, complete } = await this.summaries({
        accountKey,
        startTime: isoSeconds(start),
        endTime: isoSeconds(now),
      }));
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        logger.debug('goto-sms: call check skipped; GoTo is not connected');
        return 0;
      }
      if (
        err instanceof LoginExpiredError ||
        err instanceof GoToApiError ||
        err instanceof TemporaryError
      ) {
        await this.failed(err, now);
        return 0;
      }
      throw err;
    }
    this.refusedAt = undefined;
    if ((await store.get(tenant, ERROR_KEY)) != null) await store.delete(tenant, ERROR_KEY);

    const seen = await this.loadSeen();
    const known = new Set(seen.map(([id]) => id));
    let dirty = false;
    let delivered = 0;

    const created = (s: Dict): number => {
      const at = ms(s.callCreated);
      return Number.isNaN(at) ? now : at;
    };

    // Oldest first, whatever order GoTo answered in, so a double ring keeps the first.
    for (const summary of [...summaries].sort((a, b) => created(a) - created(b))) {
      const callId = str(summary.conversationSpaceId);
      if (!callId || known.has(callId)) continue;
      const at = created(summary);
      let caller = dict(summary.caller);
      const kind = dict(caller.type);
      let raw: unknown = summary;
      // An outside call in is PHONE_NUMBER. A summary that does not say what the caller is at
      // all (an older shape) is settled by the full report; LINE and the rest are not ours.
      let ours =
        summary.direction === 'INBOUND' && (kind.value === 'PHONE_NUMBER' || kind.value == null);
      if (ours && str(kind.number)) {
        ours = number(kind.number) === owner;
      } else if (ours) {
        let found: Awaited<ReturnType<CallWatcher['fromReport']>>;
        try {
          found = await this.fromReport(callId, owner);
        } catch (err) {
          // Left unseen: the next look tries again.
          logger.warn('goto-sms: reading a call report failed', { error: errorName(err) });
          continue;
        }
        ours = found !== undefined;
        if (found) ({ caller, report: raw } = found);
      }
      const from = ours ? number(caller.number) : '';
      if (ours && !Number.isNaN(since) && at < since) {
        ours = false; // it started before watching was switched on
      }
      const outcome = str(summary.callerOutcome);
      // Only a real number can be "the same caller": a withheld one, or a carrier's
      // placeholder text, is shared by everyone who hides theirs.
      const ring = ours && normalizePhone(from) === from ? `${from}|${outcome}` : '';
      if (ring && seen.some(([, r, t]) => r === ring && Math.abs(at - t) < DOUBLE_RING_MS)) {
        ours = false; // the same ring, reported twice
      }
      if (!ours) {
        // `ring` stays empty: only a delivered call counts for the double-ring rule.
        seen.push([callId, '', at]);
        known.add(callId);
        dirty = true;
        continue;
      }

      const createdText = str(summary.callCreated);
      const callerName = name(caller.name);
      const endedAt = str(summary.callEnded);
      const call: InboundCall = {
        id: callId,
        from,
        to: owner,
        at: Number.isNaN(ms(createdText)) ? iso(now) : createdText,
        outcome,
        raw,
        ...(callerName !== undefined ? { callerName } : {}),
        ...(endedAt ? { endedAt } : {}),
      };
      try {
        await this.o.emit(call);
      } catch (err) {
        // As with texts: logged, and it stays delivered.
        logger.warn('goto-sms: call handler threw', { error: errorName(err) });
      }
      // One call at a time, after its handlers: a crash here redelivers at most this one.
      seen.push([callId, ring, at]);
      known.add(callId);
      await this.saveSeen(seen);
      dirty = false;
      delivered++;
    }

    if (!complete) {
      // Paging was cut short, so newer calls may be unread: keep the cursor and read the
      // window again next time (seen ids are skipped). The 24 h clamp bounds that window.
      logger.warn(
        'goto-sms: GoTo paging of call reports did not finish; the cursor was not advanced',
      );
      if (dirty) await this.saveSeen(seen);
      return delivered;
    }

    // Entries the next look can still be shown (inside its reach-back) are never dropped;
    // older ones go, oldest first, down to the cap.
    const keepFrom = now - REACH_BACK_MS;
    if (seen.length > SEEN_CAP) {
      seen.sort((a, b) => a[2] - b[2]);
      const droppable = seen.filter(([, , t]) => t < keepFrom).length;
      seen.splice(0, Math.min(droppable, seen.length - SEEN_CAP));
      dirty = true;
    }
    if (dirty) await this.saveSeen(seen);
    await store.set(tenant, CURSOR_KEY, iso(now));
    return delivered;
  }
}
