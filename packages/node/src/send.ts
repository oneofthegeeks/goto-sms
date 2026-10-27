import { randomBytes } from 'node:crypto';
import type { ConfigResolver } from './config.js';
import {
  GoToApiError,
  GoToSmsError,
  LoginExpiredError,
  NotConfiguredError,
  SendFailedError,
  TemporaryError,
} from './errors.js';
import { errorName, type GoToHttp } from './http.js';
import { PRUNE_EVERY, type MessageLog } from './log.js';
import type { GoToAuth } from './oauth.js';
import type { OptOuts } from './optouts.js';
import { normalizePhone } from './phone.js';
import type { GoToSmsStore, Json } from './store/types.js';
import type { Logger, SendOptions, SendResult } from './types.js';

const SEND_PATH = '/messaging/v1/messages';
const DAY_MS = 86_400_000;
const LOCK_TTL_MS = 60_000;
const DEDUPE_PREFIX = 'dedupe:';
const LOCK_PREFIX = 'dedupe-lock:';

const R = {
  invalidNumber: 'Not a valid phone number',
  noClient: "GoTo client ID and secret aren't set",
  unreadable:
    "Saved GoTo credentials can't be decrypted — re-enter the client secret and reconnect",
  badFrom: "The configured sending number isn't a valid phone number",
  noFrom: 'No sending number chosen',
  notConnected: 'Not connected to GoTo — open the setup page and click Connect',
  loginExpired: 'GoTo login expired — reconnect',
  self: "GoTo can't text the sending number itself",
  optedOut: 'This number replied STOP and has opted out of texts',
  empty: 'Message text is empty',
  logOnly: 'log-only mode',
  locked: 'A send with this dedupeKey is already in progress',
  timeout: "GoTo didn't answer in time — the text may or may not have been sent; not retried",
  unreadableAnswer:
    "GoTo accepted the request but its answer couldn't be read — the text may or may not have been sent; not retried",
  noToken: "Couldn't get a GoTo access token — the text was not sent; try again",
  forbidden:
    "GoTo refused (403): the login lacks messaging.v1.send, or this number isn't SMS-enabled in GoTo Admin",
  tenDlc: "This number isn't registered to a 10DLC texting campaign",
};

export interface SenderOptions {
  http: GoToHttp;
  auth: GoToAuth;
  config: ConfigResolver;
  optOuts: OptOuts;
  log: MessageLog;
  store: GoToSmsStore;
  tenant: string;
  now: () => number;
  timeoutMs: number;
  maxBody: number;
  logOnly: boolean;
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

/** GoTo's `message` field from a JSON error body, cut to 200 chars; never the raw body. */
function gotoMessage(body: string): string | undefined {
  try {
    const m = (JSON.parse(body) as { message?: unknown }).message;
    return typeof m === 'string' && m.trim() ? m.trim().slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

/** Maps a failed POST (or token fetch) to a result. Unexpected errors are rethrown. */
function translate(err: unknown): SendResult {
  if (err instanceof LoginExpiredError) return { status: 'not_connected', reason: R.loginExpired };
  // NotConfiguredError messages are fixed, secret-free texts from oauth.ts.
  if (err instanceof NotConfiguredError) return { status: 'not_connected', reason: err.message };
  if (err instanceof TemporaryError) {
    // After the request left, GoTo may have sent it: never report rejected (it invites a retry).
    return err.requestSent
      ? { status: 'uncertain', reason: R.timeout }
      : { status: 'rejected', reason: R.noToken, retryable: true };
  }
  if (err instanceof GoToApiError) {
    const { status, body } = err;
    // The token endpoint failed before the POST left, so the text was not sent. A garbled
    // 2xx there is likely transient; its other answers are login/config problems.
    if (err.tokenEndpoint) {
      return status >= 200 && status < 300
        ? { status: 'rejected', reason: R.noToken, retryable: true }
        : {
            status: 'rejected',
            reason: `GoTo's login service answered HTTP ${status} — the text was not sent`,
          };
    }
    // Any other 2xx error (e.g. an unparseable body): the send endpoint accepted the
    // request and we can't prove the text didn't go out.
    if (status >= 200 && status < 300) return { status: 'uncertain', reason: R.unreadableAnswer };
    // GoTo reports 10DLC problems under several statuses, so the body is checked first.
    if (/10dlc|campaign/i.test(body)) return { status: 'rejected', reason: R.tenDlc };
    if (status === 403) return { status: 'rejected', reason: R.forbidden };
    // 408 is the server's definitive "not processed", like 429/5xx: safe to retry.
    if (status === 408 || status === 429 || status >= 500) {
      return {
        status: 'rejected',
        reason: `GoTo is busy or unavailable (HTTP ${status}) — the text was not sent; try again later`,
        retryable: true,
      };
    }
    const message = gotoMessage(body);
    return {
      status: 'rejected',
      reason: `GoTo rejected the text (HTTP ${status})${message ? `: ${message}` : ''}`,
    };
  }
  throw err;
}

type Gate =
  | { ok: true; to: string; from: string }
  | { ok: false; result: SendResult; from: string; logTo: string };

/**
 * Sends texts. `send()` returns a result for every expected outcome and never throws for
 * them. It never reports "sent" for an unsent text, never texts an opted-out number
 * (except an explicit bypass for the STOP confirmation), and never double-sends a dedupeKey.
 */
export class Sender {
  private readonly o: SenderOptions;
  /** In-process sends in flight per dedupeKey; concurrent callers share one promise. */
  private readonly inFlight = new Map<string, Promise<SendResult>>();
  /** Sends recorded by this instance; drives the periodic pruneDedupe(). */
  private recorded = 0;

  constructor(o: SenderOptions) {
    if (o.logOnly && o.env.NODE_ENV === 'production') {
      throw new GoToSmsError(
        'logOnly mode would silently drop every text, so it is refused when NODE_ENV=production',
        'log_only_in_production',
      );
    }
    this.o = o;
  }

  async send(
    to: string,
    text: string,
    opts: SendOptions & { bypassOptOut?: boolean } = {},
  ): Promise<SendResult> {
    const gate = await this.gate(to, text, opts.bypassOptOut ?? false);
    if (!gate.ok) return this.record(gate.result, gate.from, gate.logTo);

    const key = opts.dedupeKey;
    if (key === undefined) return this.deliver(gate.to, gate.from, text);

    // No await between get and set: the check-and-register is atomic on the event loop.
    const running = this.inFlight.get(key);
    if (running) return this.deduped(await running);
    const p = this.dedupedSend(key, gate.to, gate.from, text).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  async sendOrThrow(to: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
    // Forward only dedupeKey: bypassOptOut is internal (the STOP confirmation) and must not
    // be reachable through this public method, even by an untyped caller.
    const result = await this.send(to, text, { dedupeKey: opts.dedupeKey });
    if (result.status !== 'sent') throw new SendFailedError(result);
    return result;
  }

  /** Removes `dedupe:*` records older than the message log's retention. */
  async pruneDedupe(): Promise<void> {
    const cutoff = this.o.now() - this.o.log.retentionDays * DAY_MS;
    for (const { key, value } of await this.o.store.list(this.o.tenant, DEDUPE_PREFIX)) {
      const at =
        typeof value === 'object' && value !== null && !Array.isArray(value) ? value.at : 0;
      if (typeof at !== 'number' || at < cutoff) await this.o.store.delete(this.o.tenant, key);
    }
  }

  // --- internals ---

  /** Every check that needs no network call, in the documented order. */
  private async gate(rawTo: string, text: string, bypassOptOut: boolean): Promise<Gate> {
    const { config, auth, optOuts, logOnly, maxBody } = this.o;
    const c = await config.resolve();
    const from = c.fromNumber ?? '';
    const to = normalizePhone(rawTo);
    const fail = (result: SendResult): Gate => ({
      ok: false,
      result: to === null ? result : { ...result, to },
      from,
      // An invalid input is logged as given (trimmed and capped), since it has no E.164 form.
      logTo: to ?? rawTo.trim().slice(0, 32),
    });

    if (to === null) return fail({ status: 'invalid_number', reason: R.invalidNumber });

    // logOnly needs only a sending number, so it can be tried before connecting to GoTo.
    if (!logOnly) {
      // Unreadable leaves clientSecret unset, so it's checked before "missing".
      if (c.credentialsUnreadable) return fail({ status: 'not_connected', reason: R.unreadable });
      if (!c.clientId || !c.clientSecret) {
        return fail({ status: 'not_connected', reason: R.noClient });
      }
    }
    if (c.invalidFromNumber) return fail({ status: 'not_connected', reason: R.badFrom });
    if (!c.fromNumber) return fail({ status: 'not_connected', reason: R.noFrom });
    if (!logOnly) {
      const s = await auth.status();
      // With GOTO_REFRESH_TOKEN set, the first token call seeds the login, so only refuse
      // up front when there's no seed; otherwise the token errors decide (translate()).
      if (!s.connected && !config.seedRefreshToken()) {
        return fail({
          status: 'not_connected',
          reason: s.loginExpired ? R.loginExpired : R.notConnected,
        });
      }
    }

    if (to === c.fromNumber) return fail({ status: 'rejected', reason: R.self });
    if (!bypassOptOut && (await optOuts.has(to))) {
      return fail({ status: 'opted_out', reason: R.optedOut });
    }
    if (text.trim() === '') return fail({ status: 'rejected', reason: R.empty });
    // Code points, not UTF-16 units: an emoji is one character to the person typing it.
    // Counting code points is the intent here, so the spread is deliberate.
    // oxlint-disable-next-line typescript/no-misused-spread
    const length = [...text].length;
    if (length > maxBody) {
      return fail({
        status: 'rejected',
        reason: `Message is ${length} characters; the limit is ${maxBody} (not truncated)`,
      });
    }
    return { ok: true, to, from: c.fromNumber };
  }

  private async dedupedSend(
    key: string,
    to: string,
    from: string,
    text: string,
  ): Promise<SendResult> {
    const { store, tenant } = this.o;
    const earlier = await this.storedResult(key);
    if (earlier) return this.deduped(earlier);

    // Cross-process seam: a unique owner per call, so two Senders sharing a store can't
    // both hold the lock (claim succeeds again for the same owner).
    const lockKey = LOCK_PREFIX + key;
    const owner = randomBytes(8).toString('hex');
    if (!(await store.claim(tenant, lockKey, LOCK_TTL_MS, owner))) {
      return this.record({ status: 'rejected', reason: R.locked, retryable: true, to }, from, to);
    }
    try {
      // Another holder may have finished between our first read and the claim.
      const justSent = await this.storedResult(key);
      if (justSent) return this.deduped(justSent);
      return await this.deliver(to, from, text, key);
    } finally {
      await store.delete(tenant, lockKey).catch((err: unknown) => {
        this.o.logger.warn('goto-sms: could not release dedupe lock', { error: errorName(err) });
      });
    }
  }

  /** The network step (skipped in logOnly), then the dedupe record and the log entry. */
  private async deliver(
    to: string,
    from: string,
    text: string,
    dedupeKey?: string,
  ): Promise<SendResult> {
    const result = this.o.logOnly
      ? { status: 'sent' as const, reason: R.logOnly, to }
      : await this.post(to, from, text);

    // Nothing after the POST may throw: an exception here would look like a failed send
    // and invite a retry, i.e. a double send. Store failures are logged instead.
    // logOnly never persists: a "sent" that wasn't would be replayed as deduped once
    // logOnly is turned off on the same store. (The in-flight map still dedupes.)
    if (
      dedupeKey !== undefined &&
      !this.o.logOnly &&
      (result.status === 'sent' || result.status === 'uncertain')
    ) {
      try {
        await this.o.store.set(this.o.tenant, DEDUPE_PREFIX + dedupeKey, {
          result: result as unknown as Json,
          at: this.o.now(),
        });
      } catch (err) {
        this.o.logger.warn('goto-sms: could not store dedupe result', { error: errorName(err) });
      }
    }
    return this.record(result, from, to);
  }

  private async post(to: string, from: string, text: string): Promise<SendResult> {
    try {
      const res = await this.o.http.json<{ id?: unknown }>(
        'POST',
        SEND_PATH,
        { ownerPhoneNumber: from, contactPhoneNumbers: [to], body: text },
        { timeoutMs: this.o.timeoutMs },
      );
      return { status: 'sent', to, ...(typeof res.id === 'string' ? { messageId: res.id } : {}) };
    } catch (err) {
      return { ...translate(err), to };
    }
  }

  /** Appends to the message log (no body) and writes one info line (last 4 digits only). */
  private async record(result: SendResult, from: string, to: string): Promise<SendResult> {
    try {
      await this.o.log.append({
        direction: 'outbound',
        from,
        to,
        status: result.status,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.messageId !== undefined ? { gotoId: result.messageId } : {}),
      });
    } catch (err) {
      this.o.logger.warn('goto-sms: could not write the message log', { error: errorName(err) });
    }
    this.infoLine(result, to);
    // Keep dedupe records bounded on the same every-Nth cadence as the log's own prune.
    if (++this.recorded % PRUNE_EVERY === 0) {
      try {
        await this.pruneDedupe();
      } catch (err) {
        this.o.logger.warn('goto-sms: could not prune dedupe records', { error: errorName(err) });
      }
    }
    return result;
  }

  private deduped(earlier: SendResult): SendResult {
    const result = { ...earlier, deduped: true };
    this.infoLine(result, result.to ?? '');
    return result;
  }

  private infoLine(result: SendResult, to: string): void {
    const last4 = to.replace(/\D/g, '').slice(-4);
    this.o.logger.info(
      `goto-sms: send to …${last4}: ${result.status}${result.deduped ? ' (deduped)' : ''}`,
    );
  }

  private async storedResult(key: string): Promise<SendResult | undefined> {
    const v = await this.o.store.get(this.o.tenant, DEDUPE_PREFIX + key);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    const r = v.result;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return undefined;
    return r.status === 'sent' || r.status === 'uncertain'
      ? (r as unknown as SendResult)
      : undefined;
  }
}
