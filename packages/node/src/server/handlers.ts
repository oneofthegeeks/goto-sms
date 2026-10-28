// Framework-free HTTP handlers for the setup page, its JSON API, the OAuth callback and the
// GoTo webhook. A thin adapter (the Express router) maps its request/response onto these.
// contract/http.md at the repo root is the language-neutral write-up of this file.
import type { IncomingMessage } from 'node:http';
import type { Core, IncomingMode, ResolvedOptions } from '../client.js';
import { listAccounts, listNumbers } from '../directory.js';
import { GoToApiError, GoToSmsError, TemporaryError } from '../errors.js';
import { errorName } from '../http.js';
import {
  checkWebhookSecret,
  disableWebhook,
  enableWebhook,
  ensureWebhookSecret,
  getWebhookAccount,
  getWebhookSecret,
  parseWebhookEnvelope,
} from '../inbound/webhook.js';
import type { Logger } from '../types.js';
import { buildStatus, INBOUND_ERROR, startupErrorText } from './status.js';

export { buildStatus, REQUIRED_SCOPES, type StatusPayload } from './status.js';

export interface HttpRequest {
  method: string;
  /** Relative to the mount, e.g. '/api/status'. */
  path: string;
  query: Record<string, string>;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  /** The parsed JSON body (undefined when there was none). */
  body: unknown;
  raw: IncomingMessage;
}
export type HttpResponse = { status: number; json?: unknown; html?: string; redirect?: string };
export type Handler = (req: HttpRequest) => Promise<HttpResponse>;

const NO_AUTHORIZE =
  'goto-sms: pass authorize(req) to createGoToSms (or allowUnauthenticatedSetup: true in development)';
const TEST_TEXT = 'Test message from goto-sms';
const LOG_DEFAULT = 50;
const LOG_MAX = 500;
const MODES: IncomingMode[] = ['webhook', 'polling', 'off'];

/** Package error codes that mean "the request can't be done as asked", not a server fault. */
const BAD_REQUEST = new Set([
  'invalid_input',
  'invalid_number',
  'invalid_inbound',
  'not_configured',
  'login_expired',
  'bad_state',
  'no_public_url',
]);

const badInput = (message: string) => new GoToSmsError(message, 'invalid_input');

function asObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw badInput('Expected a JSON object');
  return body as Record<string, unknown>;
}

function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badInput(`${key} must be a string`);
  return v;
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = optString(o, key);
  if (!v) throw badInput(`${key} is required`);
  return v;
}

const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined; // e.g. `Origin: null`
  }
};

/**
 * CSRF guard for state-changing routes. `Sec-Fetch-Site: same-origin` passes on its own;
 * otherwise Origin's host must equal the Host header or, behind a proxy that rewrites Host,
 * the publicUrl's host.
 */
function sameOrigin(req: HttpRequest, publicUrl: string | undefined): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const origin = hostOf(req.headers.origin);
  if (!origin) return false;
  return origin === req.headers.host || origin === hostOf(publicUrl);
}

/** One error → response mapping for every route. Details go to the debug log only. */
function errorResponse(logger: Logger, route: string, err: unknown): HttpResponse {
  logger.debug('goto-sms: setup request failed', {
    route,
    error: err instanceof GoToSmsError ? err.code : errorName(err),
  });
  if (err instanceof GoToApiError) {
    return {
      status: 502,
      json: { error: 'goto_api', message: err.message, gotoStatus: err.status, gotoBody: err.body },
    };
  }
  if (err instanceof TemporaryError) {
    return {
      status: 503,
      json: { error: 'temporary', message: 'GoTo did not answer in time; try again' },
    };
  }
  if (err instanceof GoToSmsError && err.code === 'locked') {
    return { status: 409, json: { error: 'locked', message: err.message } };
  }
  if (err instanceof GoToSmsError && BAD_REQUEST.has(err.code)) {
    return { status: 400, json: { error: err.code, message: err.message } };
  }
  return {
    status: 500,
    json: { error: 'internal', message: 'Something went wrong; see the server logs' },
  };
}

/** Subscribes the webhook on the selected account (channel and subscription reused if they match). */
async function subscribeWebhook(core: Core): Promise<void> {
  const { store, tenant, http } = core;
  if (!core.options.publicUrl?.startsWith('https://')) {
    throw new GoToSmsError(
      'Webhooks need an https publicUrl; use polling instead',
      'no_public_url',
    );
  }
  const { accountKey } = await core.config.resolve();
  if (!accountKey) {
    throw new GoToSmsError('Pick a GoTo account before turning on webhooks', 'not_configured');
  }
  // The URL embeds the secret, so it has to exist before GoTo is told the URL.
  const secret = await ensureWebhookSecret(store, tenant);
  await enableWebhook({
    http,
    store,
    tenant,
    accountKey,
    webhookUrl: core.webhookUrl(secret)!,
    channelPrefix: 'goto-sms',
  });
}

/** Switches inbound delivery. The stored mode changes only once the switch succeeded. */
async function setIncoming(core: Core, mode: IncomingMode): Promise<void> {
  const { store, tenant, http, poller } = core;
  if (mode === 'webhook') {
    await subscribeWebhook(core);
    await store.set(tenant, 'inbound:mode', mode);
    await store.delete(tenant, INBOUND_ERROR);
    poller.stop();
    return;
  }
  // Leaving webhook mode deletes the subscription and rotates the secret, so the old URL
  // stops authenticating. A failed DELETE throws here and the mode stays as it was.
  const fromWebhook = (await core.incomingMode()) === 'webhook';
  if (fromWebhook) await disableWebhook({ http, store, tenant });
  // R31: the webhook covered the time since polling last ran, so polling starts from now
  // (re-reading that span would replay texts the webhook already handled). Coming from off,
  // the cursor is kept: nothing handled texts then, and the poller caps the lookback at 24 h.
  // Set before start(), which polls straight away.
  if (mode === 'polling' && fromWebhook) await poller.resetCursor();
  await store.set(tenant, 'inbound:mode', mode);
  await store.delete(tenant, INBOUND_ERROR);
  if (mode === 'polling') poller.start();
  else poller.stop();
}

/**
 * R29: the subscription is per account, so when the selected account changes in webhook mode
 * it moves: delete the old one (keeping the secret, so the URL and channel stay), subscribe on
 * the new account. A failure keeps the selection and is stored as `inbound:error`, which the
 * status shows (code and GoTo's HTTP status only) until a later switch succeeds.
 */
async function followAccount(core: Core): Promise<void> {
  const { store, tenant, http, logger } = core;
  if ((await core.incomingMode()) !== 'webhook') return;
  const { accountKey } = await core.config.resolve();
  if (accountKey === (await getWebhookAccount(store, tenant))) return;
  try {
    await disableWebhook({ http, store, tenant, rotateSecret: false });
    await subscribeWebhook(core);
    await store.delete(tenant, INBOUND_ERROR);
  } catch (err) {
    const { error, message, gotoStatus } = errorResponse(
      logger,
      'POST /api/selection (webhook)',
      err,
    ).json as { error: string; message: string; gotoStatus?: number };
    logger.warn('goto-sms: moving the webhook to the new account failed', { error });
    await store.set(tenant, INBOUND_ERROR, {
      error,
      message,
      ...(gotoStatus !== undefined ? { gotoStatus } : {}),
    });
  }
}

/** POST /inbound/:secret: GoTo's webhook. Authenticated by the path secret alone. */
async function inbound(core: Core, secret: string, body: unknown): Promise<HttpResponse> {
  const notFound = { status: 404 };
  if ((await core.incomingMode()) !== 'webhook') return notFound;
  const expected = await getWebhookSecret(core.store, core.tenant);
  if (!expected || !checkWebhookSecret(secret, expected)) return notFound;
  // GoTo sends other event types to the same channel; acknowledge and ignore them.
  const message = parseWebhookEnvelope(body);
  if (!message) return { status: 204 };
  // Persisted before the 204, so an acknowledged STOP survives a crash.
  const fresh = await core.processor.persist(message);
  if (fresh) {
    // After the response has gone out; process() leaves the row pending if it fails, and
    // the background replay retries it. Only the error's name is logged (no message text).
    // Registered on core.inflight now (before the 204) so close() waits for it.
    const job: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => core.processor.process(message.id))
      .catch((err: unknown) => {
        core.logger.error('goto-sms: processing an inbound text failed', {
          error: errorName(err),
        });
      })
      .finally(() => core.inflight.delete(job));
    core.inflight.add(job);
  }
  return { status: 204 };
}

/** GET /callback: the OAuth redirect, authenticated by `state`. Always redirects to the page. */
async function callback(core: Core, query: Record<string, string>): Promise<HttpResponse> {
  const back = (q: string): HttpResponse => ({ status: 302, redirect: `./?${q}` });
  // GoTo's own error text is never echoed; the page explains the usual causes.
  if (query.error) return back('error=goto_login');
  if (!query.code || !query.state) return back('error=bad_state');
  try {
    await core.auth.finishConnect(query.code, query.state);
    return back('connected=1');
  } catch (err) {
    const code = err instanceof GoToSmsError ? err.code : 'internal';
    core.logger.debug('goto-sms: OAuth callback failed', { error: code });
    return back(`error=${encodeURIComponent(code)}`);
  }
}

/**
 * Throws unless the setup routes are protected: `authorize` is required, and
 * `allowUnauthenticatedSetup` is a development-only escape hatch, refused in production.
 */
export function assertSetupAuth(options: ResolvedOptions): void {
  if (options.authorize) return;
  if (!options.allowUnauthenticatedSetup || options.env.NODE_ENV === 'production') {
    throw new Error(NO_AUTHORIZE);
  }
}

/** What a dispatcher needs besides the shared auth/exemption logic. */
interface RouteTable {
  inbound(secret: string, body: unknown): Promise<HttpResponse>;
  callback(query: Record<string, string>): Promise<HttpResponse>;
  routes: Record<string, Handler>;
  /** Runs when no route matched; returns undefined for a plain 404. */
  fallback?: (req: HttpRequest) => HttpResponse | undefined;
}

/** The exemptions, authorize, the same-origin check and the error mapping, for every route. */
function dispatcher(options: ResolvedOptions, logger: Logger, t: RouteTable): Handler {
  const { authorize } = options;
  return async (req) => {
    const method = req.method.toUpperCase();
    const hook = /^\/inbound\/([^/]+)$/.exec(req.path);
    // The webhook path holds its secret, so logs name the pattern instead.
    const route = hook ? `${method} /inbound/:secret` : `${method} ${req.path}`;
    try {
      // Exempt from authorize and the Origin check: GoTo and the OAuth redirect send neither
      // the host's session nor a same-origin header. Each carries its own secret.
      if (hook && method === 'POST') return await t.inbound(hook[1]!, req.body);
      if (route === 'GET /callback') return await t.callback(req.query);

      if (authorize && !(await authorize(req.raw))) {
        return { status: 403, json: { error: 'forbidden', message: 'Not allowed' } };
      }
      if (method !== 'GET' && !sameOrigin(req, options.publicUrl)) {
        return {
          status: 403,
          json: { error: 'cross_origin', message: 'Cross-origin request refused' },
        };
      }
      const handler = t.routes[route];
      if (handler) return await handler(req);
      return (
        t.fallback?.(req) ?? {
          status: 404,
          json: { error: 'not_found', message: 'No such route' },
        }
      );
    } catch (err) {
      return errorResponse(logger, route, err);
    }
  };
}

/** The routes of a started instance. */
function liveHandlers(core: Core, setupHtml: string): Handler {
  const status = () => buildStatus(core.options, core);
  const ok = (json: unknown): HttpResponse => ({ status: 200, json });

  const routes: Record<string, Handler> = {
    'GET /': async () => ({ status: 200, html: setupHtml }),
    'GET /api/status': async () => ok(await status()),
    'POST /api/credentials': async (req) => {
      const b = asObject(req.body);
      const clientId = optString(b, 'clientId');
      const clientSecret = optString(b, 'clientSecret');
      await core.config.save({
        ...(clientId !== undefined ? { clientId } : {}),
        ...(clientSecret !== undefined ? { clientSecret } : {}),
      });
      return ok(await status());
    },
    'POST /api/connect': async () => {
      if (!core.options.redirectUri) {
        throw new GoToSmsError(
          'Set publicUrl (or GOTO_SMS_PUBLIC_URL) so GoTo has a redirect URI to send you back to',
          'no_public_url',
        );
      }
      return ok({ url: await core.auth.startConnect() });
    },
    'POST /api/disconnect': async () => {
      await core.auth.disconnect();
      return ok(await status());
    },
    'GET /api/accounts': async () => ok({ accounts: await listAccounts(core.http) }),
    'GET /api/numbers': async (req) => {
      const accountKey = req.query.accountKey;
      if (!accountKey) throw badInput('accountKey is required');
      return ok({ numbers: await listNumbers(core.http, accountKey) });
    },
    'POST /api/selection': async (req) => {
      const b = asObject(req.body);
      const accountKey = optString(b, 'accountKey');
      const fromNumber = optString(b, 'fromNumber');
      await core.config.save({
        ...(accountKey !== undefined ? { accountKey } : {}),
        ...(fromNumber !== undefined ? { fromNumber } : {}),
      });
      await followAccount(core);
      return ok(await status());
    },
    'POST /api/test': async (req) =>
      ok(await core.sender.send(reqString(asObject(req.body), 'to'), TEST_TEXT)),
    'POST /api/incoming': async (req) => {
      const mode = optString(asObject(req.body), 'mode');
      if (!MODES.includes(mode as IncomingMode)) {
        throw badInput('mode must be "webhook", "polling" or "off"');
      }
      await setIncoming(core, mode as IncomingMode);
      return ok(await status());
    },
    'GET /api/log': async (req) => {
      const n = Number.parseInt(req.query.limit ?? '', 10);
      const limit = Number.isFinite(n) && n > 0 ? Math.min(n, LOG_MAX) : LOG_DEFAULT;
      return ok({ entries: await core.log.list(limit) });
    },
    'GET /api/opt-outs': async () => ok({ optOuts: await core.optOuts.list() }),
    'POST /api/opt-outs': async (req) => {
      const b = asObject(req.body);
      const number = reqString(b, 'number');
      const action = optString(b, 'action');
      if (action === 'add') await core.optOuts.add(number, 'admin');
      else if (action === 'remove') await core.optOuts.remove(number);
      else throw badInput('action must be "add" or "remove"');
      return ok({ optOuts: await core.optOuts.list() });
    },
  };

  return dispatcher(core.options, core.logger, {
    inbound: (secret, body) => inbound(core, secret, body),
    callback: (query) => callback(core, query),
    routes,
  });
}

/**
 * The routes when startup failed (e.g. no encryption key): still behind authorize, the page
 * and status answer so the admin can see why, and every other API route is `not_configured`.
 */
function startupFailedHandlers(
  options: ResolvedOptions,
  logger: Logger,
  err: unknown,
  setupHtml: string,
): Handler {
  const startupError = startupErrorText(err);
  return dispatcher(options, logger, {
    inbound: async () => ({ status: 404 }),
    callback: async () => ({ status: 302, redirect: './?error=not_configured' }),
    routes: {
      'GET /': async () => ({ status: 200, html: setupHtml }),
      'GET /api/status': async () => ({
        status: 200,
        json: await buildStatus(options, undefined, startupError),
      }),
    },
    fallback: (req) =>
      req.path.startsWith('/api/')
        ? { status: 400, json: { error: 'not_configured', message: startupError } }
        : undefined,
  });
}

export function createHandlers(core: Core, setupHtml: string): Handler {
  assertSetupAuth(core.options);
  return liveHandlers(core, setupHtml);
}

/**
 * For routers created before `ready` settles (hosts mount them synchronously). Waits for
 * startup on each request; if it failed, serves the startup-failed routes. Doesn't check
 * `authorize` itself: router() does, webhookRouter() needs none.
 */
export function createDeferredHandlers(
  src: { options: ResolvedOptions; logger: Logger; core: Promise<Core> },
  setupHtml: string,
): Handler {
  let handler: Promise<Handler> | undefined;
  return async (req) => {
    handler ??= src.core.then(
      (core) => liveHandlers(core, setupHtml),
      (err: unknown) => startupFailedHandlers(src.options, src.logger, err, setupHtml),
    );
    return (await handler)(req);
  };
}
