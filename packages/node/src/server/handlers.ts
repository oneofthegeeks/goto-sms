// Framework-free HTTP handlers for the setup page, its JSON API, the OAuth callback and the
// GoTo webhook. A thin adapter (the Express router) maps its request/response onto these.
// contract/http.md at the repo root is the language-neutral write-up of this file.
import type { IncomingMessage } from 'node:http';
import type { Core, IncomingMode } from '../client.js';
import { listAccounts, listNumbers } from '../directory.js';
import { GoToApiError, GoToSmsError, TemporaryError } from '../errors.js';
import { errorName } from '../http.js';
import {
  checkWebhookSecret,
  disableWebhook,
  enableWebhook,
  ensureWebhookSecret,
  getWebhookSecret,
  parseWebhookEnvelope,
} from '../inbound/webhook.js';
import { buildStatus } from './status.js';

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
function errorResponse(core: Core, route: string, err: unknown): HttpResponse {
  core.logger.debug('goto-sms: setup request failed', {
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

/** Switches inbound delivery. The stored mode changes only once the switch succeeded. */
async function setIncoming(core: Core, mode: IncomingMode): Promise<void> {
  const { store, tenant, http, poller } = core;
  if (mode === 'webhook') {
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
    await store.set(tenant, 'inbound:mode', mode);
    poller.stop();
    return;
  }
  // Leaving webhook mode deletes the subscription and rotates the secret, so the old URL
  // stops authenticating. A failed DELETE throws here and the mode stays as it was.
  if ((await core.incomingMode()) === 'webhook') await disableWebhook({ http, store, tenant });
  await store.set(tenant, 'inbound:mode', mode);
  if (mode === 'polling') poller.start();
  else poller.stop();
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

export function createHandlers(
  core: Core,
  setupHtml: string,
): (req: HttpRequest) => Promise<HttpResponse> {
  const { authorize, allowUnauthenticatedSetup } = core.options;
  if (!authorize) {
    // Setup without auth is a development convenience only, never in production.
    if (!allowUnauthenticatedSetup || core.options.env.NODE_ENV === 'production') {
      throw new Error(NO_AUTHORIZE);
    }
  }

  const status = () => buildStatus(core.options, core);
  const ok = (json: unknown): HttpResponse => ({ status: 200, json });

  const routes: Record<string, (req: HttpRequest) => Promise<HttpResponse>> = {
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

  return async (req) => {
    const method = req.method.toUpperCase();
    const hook = /^\/inbound\/([^/]+)$/.exec(req.path);
    // The webhook path holds its secret, so logs name the pattern instead.
    const route = hook ? `${method} /inbound/:secret` : `${method} ${req.path}`;
    try {
      // Exempt from authorize and the Origin check: GoTo and the OAuth redirect send neither
      // the host's session nor a same-origin header. Each carries its own secret.
      if (hook && method === 'POST') return await inbound(core, hook[1]!, req.body);
      if (route === 'GET /callback') return await callback(core, req.query);

      if (authorize && !(await authorize(req.raw))) {
        return { status: 403, json: { error: 'forbidden', message: 'Not allowed' } };
      }
      if (method !== 'GET' && !sameOrigin(req, core.options.publicUrl)) {
        return {
          status: 403,
          json: { error: 'cross_origin', message: 'Cross-origin request refused' },
        };
      }
      const handler = routes[route];
      if (!handler) return { status: 404, json: { error: 'not_found', message: 'No such route' } };
      return await handler(req);
    } catch (err) {
      return errorResponse(core, route, err);
    }
  };
}
