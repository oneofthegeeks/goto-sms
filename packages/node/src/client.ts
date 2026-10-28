// createGoToSms: the public facade. Wires config, OAuth, HTTP, sending, opt-outs, the log,
// inbound processing and polling together over one store.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Router } from 'express';
import { join } from 'node:path';
import { ConfigResolver } from './config.js';
import { GoToSmsError, NotConfiguredError, SendFailedError } from './errors.js';
import { createGoToHttp, errorName, type GoToHttp } from './http.js';
import { DEFAULT_REPLIES, type KeywordReplies } from './inbound/keywords.js';
import { Poller } from './inbound/poller.js';
import { InboundProcessor } from './inbound/processor.js';
import { MessageLog } from './log.js';
import { GoToAuth } from './oauth.js';
import { OptOuts } from './optouts.js';
import { resolveEncryptionKey, SecretBox } from './secrets.js';
import { Sender } from './send.js';
import { buildExpressRouter } from './server/express.js';
import { assertSetupAuth, createDeferredHandlers } from './server/handlers.js';
import { SETUP_HTML } from './server/setup-html.generated.js';
import { buildStatus, startupErrorText, type StatusPayload } from './server/status.js';
import { FileStore } from './store/file.js';
import type { GoToSmsStore } from './store/types.js';
import type { FetchLike, InboundMessage, Logger, SendOptions, SendResult } from './types.js';

const DEFAULT_AUTH_BASE = 'https://authentication.logmeininc.com';
const DEFAULT_API_BASE = 'https://api.goto.com';
const LOCK_KEY = 'process-lock';
const LOCK_TTL_MS = 90_000;
const LOCK_REFRESH_MS = 30_000;
const MAX_BODY = 1600;
const ONE_PROCESS =
  'Another process is using this goto-sms store; run one process per store (see README)';

export type IncomingMode = 'webhook' | 'polling' | 'off';

export interface GoToSmsOptions {
  publicUrl?: string;
  /** Where the host mounts router(); default '/goto-sms'. */
  mountPath?: string;
  dataDir?: string;
  store?: GoToSmsStore;
  tenant?: string;
  authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;
  allowUnauthenticatedSetup?: boolean;
  clientId?: string;
  clientSecret?: string;
  accountKey?: string;
  fromNumber?: string;
  refreshToken?: string;
  encryptionKey?: string;
  logOnly?: boolean;
  replies?: Partial<KeywordReplies>;
  yesIsOptIn?: boolean;
  pollIntervalMs?: number;
  sendTimeoutMs?: number;
  inboundPerHour?: number;
  logRetentionDays?: number;
  logger?: Logger | false;
  fetch?: FetchLike;
  authBaseUrl?: string;
  apiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Options with defaults applied, for handlers (Task 12). */
export interface ResolvedOptions {
  /** No trailing slash; undefined when neither the option nor GOTO_SMS_PUBLIC_URL is set. */
  publicUrl?: string;
  /** Leading slash, no trailing slash; '' for the root mount (so URLs never get '//'). */
  mountPath: string;
  /** publicUrl + mountPath + '/callback', or undefined without a publicUrl. */
  redirectUri?: string;
  dataDir?: string;
  authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;
  allowUnauthenticatedSetup: boolean;
  logOnly: boolean;
  replies: KeywordReplies;
  yesIsOptIn: boolean;
  pollIntervalMs: number;
  sendTimeoutMs: number;
  inboundPerHour: number;
  logRetentionDays: number;
  fetch: FetchLike;
  authBaseUrl: string;
  apiBaseUrl: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
}

/** Every module instance, for the setup handlers. Internal. */
export interface Core {
  store: GoToSmsStore;
  tenant: string;
  box: SecretBox;
  keySource: 'option' | 'env' | 'keyfile';
  config: ConfigResolver;
  auth: GoToAuth;
  http: GoToHttp;
  sender: Sender;
  optOuts: OptOuts;
  log: MessageLog;
  processor: InboundProcessor;
  poller: Poller;
  logger: Logger;
  options: ResolvedOptions;
  /** Stored `inbound:mode`; 'off' when unset or unrecognized. */
  incomingMode(): Promise<IncomingMode>;
  /** publicUrl + mountPath + '/inbound/' + secret, or undefined without a publicUrl. */
  webhookUrl(secret: string): string | undefined;
  /** Background work started by handlers (post-204 inbound processing); close() awaits it. */
  inflight: Set<Promise<void>>;
}

type Handler = (m: InboundMessage) => void;

export interface GoToSms {
  send(to: string, text: string, o?: SendOptions): Promise<SendResult>;
  sendOrThrow(to: string, text: string, o?: SendOptions): Promise<SendResult>;
  on(ev: 'message', fn: Handler): this;
  off(ev: 'message', fn: Handler): this;
  optOuts: Pick<OptOuts, 'has' | 'add' | 'remove' | 'list'>;
  /**
   * The setup page's status (the same payload as GET /api/status). Never throws for missing
   * configuration: if startup failed for lack of an encryption key it reports not set up.
   */
  status(): Promise<StatusPayload>;
  /**
   * The setup page, its JSON API, the OAuth callback and the webhook, for
   * `app.use(mountPath, sms.router())`. Throws without `authorize` (see contract/http.md).
   * Usable before `ready`; if startup fails the page still loads and shows why.
   */
  router(): Router;
  /** Only `POST /inbound/:secret`, for hosts that serve the setup page elsewhere or not at all. */
  webhookRouter(): Router;
  /** Resolves after key resolution, the process lock, replayPending and poller start. */
  ready: Promise<void>;
  close(): Promise<void>;
  /** @internal for handlers; throws until `ready` resolves. */
  readonly core: Core;
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** console with a `[goto-sms]` prefix (modules' own "goto-sms: " prefix is dropped). */
function consoleLogger(): Logger {
  const line =
    (write: (...a: unknown[]) => void) =>
    (m: string, x?: object): void => {
      write('[goto-sms]', m.replace(/^goto-sms: /, ''), ...(x ? [x] : []));
    };
  return {
    debug: line(console.debug),
    info: line(console.info),
    warn: line(console.warn),
    error: line(console.error),
  };
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

/** '/goto-sms/' → '/goto-sms', 'sms' → '/sms'; '/' and '' → '' (the root mount). */
function normalizeMount(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed === '') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function createGoToSms(o: GoToSmsOptions = {}): GoToSms {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const logger = o.logger === false ? silentLogger : (o.logger ?? consoleLogger());
  const tenant = o.tenant ?? 'default';
  const publicUrlRaw = o.publicUrl ?? env.GOTO_SMS_PUBLIC_URL;
  const publicUrl = publicUrlRaw ? publicUrlRaw.replace(/\/+$/, '') : undefined;
  const mountPath = o.mountPath === undefined ? '/goto-sms' : normalizeMount(o.mountPath);
  // A custom store and no dataDir means there is nowhere for a keyfile: the key must then
  // come from the option or env (resolveEncryptionKey throws NotConfiguredError).
  const dataDir = o.dataDir ?? (o.store ? undefined : './data');
  const options: ResolvedOptions = {
    ...(publicUrl ? { publicUrl, redirectUri: `${publicUrl}${mountPath}/callback` } : {}),
    mountPath,
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(o.authorize ? { authorize: o.authorize } : {}),
    allowUnauthenticatedSetup: o.allowUnauthenticatedSetup ?? false,
    logOnly: o.logOnly ?? false,
    replies: { ...DEFAULT_REPLIES, ...o.replies },
    yesIsOptIn: o.yesIsOptIn ?? true,
    pollIntervalMs: o.pollIntervalMs ?? 30_000,
    sendTimeoutMs: o.sendTimeoutMs ?? 10_000,
    inboundPerHour: o.inboundPerHour ?? 10,
    logRetentionDays: o.logRetentionDays ?? 90,
    fetch: o.fetch ?? ((url, init) => fetch(url, init)),
    authBaseUrl: o.authBaseUrl ?? DEFAULT_AUTH_BASE,
    apiBaseUrl: o.apiBaseUrl ?? DEFAULT_API_BASE,
    env,
    now,
  };

  const listeners = new Set<Handler>();
  /**
   * The processor's emit is synchronous. Each handler runs in its own try/catch, and a
   * promise-returning handler's rejection is caught here, so a host's async handler can
   * never cause an unhandled rejection. Only the error's name is logged: its message could
   * quote the text.
   */
  const emit = (m: InboundMessage): void => {
    // A snapshot, so a handler that calls on() doesn't get this same message.
    for (const fn of Array.from(listeners)) {
      try {
        const r: unknown = fn(m);
        if (isThenable(r)) {
          r.then(undefined, (err: unknown) => {
            logger.warn('goto-sms: inbound handler failed', { error: errorName(err) });
          });
        }
      } catch (err) {
        logger.warn('goto-sms: inbound handler threw', { error: errorName(err) });
      }
    }
  };

  const lockOwner = randomUUID();
  let core: Core | undefined;
  let closed = false;
  let lockTimer: ReturnType<typeof setInterval> | undefined;
  let lockWarned = false;
  /** The maintenance run in flight (lock refresh + pending retry); close() waits for it. */
  let maintaining: Promise<void> | undefined;

  const claimLock = async (c: Core): Promise<void> => {
    const won = await c.store.claim(tenant, LOCK_KEY, LOCK_TTL_MS, lockOwner);
    if (won) lockWarned = false;
    else if (!lockWarned) {
      lockWarned = true;
      logger.warn(ONE_PROCESS);
    }
  };

  /**
   * Every 30 s: refresh the process lock, and retry inbound rows a failed process() left
   * pending (e.g. an opt-out write that failed). While polling, each tick already replays
   * pending rows, so this skips the replay then to keep one replay running at a time.
   */
  const maintain = (c: Core): Promise<void> => {
    maintaining ??= (async () => {
      try {
        await claimLock(c);
        if (!c.poller.running) await c.processor.replayPending();
      } catch (err) {
        logger.warn('goto-sms: background maintenance failed', { error: errorName(err) });
      }
    })().finally(() => {
      maintaining = undefined;
    });
    return maintaining;
  };

  const start = async (): Promise<Core> => {
    const { key, source } = await resolveEncryptionKey({
      ...(o.encryptionKey ? { optionKey: o.encryptionKey } : {}),
      env,
      ...(dataDir !== undefined ? { dataDir } : {}),
      logger,
    });
    const box = new SecretBox(key);
    const store =
      o.store ?? new FileStore({ path: join(dataDir ?? './data', 'goto-sms.json'), now, logger });
    const config = new ConfigResolver({
      store,
      tenant,
      box,
      options: {
        ...(o.clientId !== undefined ? { clientId: o.clientId } : {}),
        ...(o.clientSecret !== undefined ? { clientSecret: o.clientSecret } : {}),
        ...(o.accountKey !== undefined ? { accountKey: o.accountKey } : {}),
        ...(o.fromNumber !== undefined ? { fromNumber: o.fromNumber } : {}),
        ...(o.refreshToken !== undefined ? { refreshToken: o.refreshToken } : {}),
      },
      env,
    });
    const auth = new GoToAuth({
      store,
      tenant,
      box,
      config,
      fetch: options.fetch,
      authBaseUrl: options.authBaseUrl,
      // Without a publicUrl there is no valid redirect; the setup handlers report that.
      redirectUri: options.redirectUri ?? '',
      now,
      logger,
    });
    const http = createGoToHttp({
      apiBaseUrl: options.apiBaseUrl,
      fetch: options.fetch,
      getToken: () => auth.getAccessToken(),
      forceRefresh: () => auth.forceRefresh(),
    });
    const optOuts = new OptOuts(store, tenant, now);
    const log = new MessageLog(store, tenant, now, { retentionDays: options.logRetentionDays });
    const sender = new Sender({
      http,
      auth,
      config,
      optOuts,
      log,
      store,
      tenant,
      now,
      timeoutMs: options.sendTimeoutMs,
      maxBody: MAX_BODY,
      logOnly: options.logOnly,
      env,
      logger,
    });
    const processor = new InboundProcessor({
      store,
      tenant,
      sender,
      optOuts,
      log,
      emit,
      replies: options.replies,
      yesIsOptIn: options.yesIsOptIn,
      perHour: options.inboundPerHour,
      now,
      logger,
      seenRetentionDays: options.logRetentionDays,
    });
    const poller = new Poller({
      http,
      config,
      processor,
      store,
      tenant,
      intervalMs: options.pollIntervalMs,
      now,
      logger,
    });
    const c: Core = {
      store,
      tenant,
      box,
      keySource: source,
      config,
      auth,
      http,
      sender,
      optOuts,
      log,
      processor,
      poller,
      logger,
      options,
      inflight: new Set(),
      async incomingMode() {
        const mode = await store.get(tenant, 'inbound:mode');
        return mode === 'webhook' || mode === 'polling' ? mode : 'off';
      },
      webhookUrl: (secret) =>
        publicUrl ? `${publicUrl}${mountPath}/inbound/${secret}` : undefined,
    };
    core = c;

    await claimLock(c);
    // Finish anything persisted but not processed (a crash mid-STOP) before taking new texts.
    await c.processor.replayPending();
    if (closed) return c;
    lockTimer = setInterval(() => void maintain(c), LOCK_REFRESH_MS);
    lockTimer.unref();
    if ((await c.incomingMode()) === 'polling') c.poller.start();
    return c;
  };

  const coreReady = start();
  const ready = coreReady.then(
    () => undefined,
    (err: unknown) => {
      // Package errors carry fixed, secret-free messages; anything else only by name.
      logger.error('goto-sms: startup failed', {
        error: err instanceof GoToSmsError ? err.message : errorName(err),
      });
      throw err;
    },
  );
  // A host that never awaits `ready` must not get an unhandled rejection; callers who do
  // await it still see the error.
  ready.catch(() => {});

  /** The core, or a not_connected result when startup failed for lack of configuration. */
  const coreOr = async (): Promise<Core | SendResult> => {
    try {
      return await coreReady;
    } catch (err) {
      if (err instanceof NotConfiguredError)
        return { status: 'not_connected', reason: err.message };
      throw err;
    }
  };
  const isResult = (v: Core | SendResult): v is SendResult => 'status' in v;

  // One handler set shared by router() and webhookRouter(); it waits for startup per request.
  let handle: ReturnType<typeof createDeferredHandlers> | undefined;
  const routerSource = () => {
    handle ??= createDeferredHandlers({ options, logger, core: coreReady }, SETUP_HTML);
    return { options, logger, handle };
  };

  const sms: GoToSms = {
    async send(to, text, opts = {}) {
      const c = await coreOr();
      if (isResult(c)) return c;
      // Only dedupeKey is forwarded: the sender's bypassOptOut is internal.
      return c.sender.send(to, text, { dedupeKey: opts.dedupeKey });
    },
    async sendOrThrow(to, text, opts = {}) {
      const c = await coreOr();
      if (isResult(c)) throw new SendFailedError(c);
      return c.sender.sendOrThrow(to, text, { dedupeKey: opts.dedupeKey });
    },
    on(_ev, fn) {
      listeners.add(fn);
      return this;
    },
    off(_ev, fn) {
      listeners.delete(fn);
      return this;
    },
    optOuts: {
      has: async (n) => (await coreReady).optOuts.has(n),
      add: async (n, s) => (await coreReady).optOuts.add(n, s),
      remove: async (n) => (await coreReady).optOuts.remove(n),
      list: async () => (await coreReady).optOuts.list(),
    },
    async status() {
      let c: Core;
      try {
        c = await coreReady;
      } catch (err) {
        if (!(err instanceof NotConfiguredError)) throw err;
        return buildStatus(options, undefined, startupErrorText(err));
      }
      return buildStatus(options, c);
    },
    router() {
      assertSetupAuth(options);
      return buildExpressRouter(routerSource());
    },
    webhookRouter() {
      return buildExpressRouter(routerSource(), { inboundOnly: true });
    },
    ready,
    async close() {
      closed = true;
      await ready.catch(() => {});
      if (lockTimer) clearInterval(lockTimer);
      lockTimer = undefined;
      const c = core;
      if (!c) return;
      c.poller.stop();
      // Wait for in-flight work so nothing writes to the store after close() resolves.
      await c.poller.idle();
      await Promise.allSettled([...c.inflight]);
      await maintaining;
      // Release the lock only if it's still ours.
      const lock = await c.store.get(tenant, LOCK_KEY);
      if (
        typeof lock === 'object' &&
        lock !== null &&
        !Array.isArray(lock) &&
        lock.owner === lockOwner
      ) {
        await c.store.delete(tenant, LOCK_KEY);
      }
    },
    get core(): Core {
      if (!core) {
        throw new GoToSmsError('goto-sms is not ready yet; await sms.ready first', 'not_ready');
      }
      return core;
    },
  };
  return sms;
}
