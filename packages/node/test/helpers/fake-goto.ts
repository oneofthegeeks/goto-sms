// A fake GoTo (auth + API on one node:http server) for tests. Answers are modeled on the
// reference apps (swu-ideas, party-invites, geeks-tracker). Later tasks add API routes
// with `fake.route(method, pathPrefix, handler)`.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

export interface FakeRequest {
  method: string;
  /** Path including the query string, as sent. */
  path: string;
  /** Path without the query string. */
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
}

export interface FakeResponse {
  status: number;
  /** Serialized as JSON unless it's a string; omitted → empty body. */
  body?: unknown;
}

export type FakeHandler = (req: FakeRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeGoTo {
  url: string; // use as authBaseUrl AND apiBaseUrl
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>;
  sent: Array<{ ownerPhoneNumber: string; contactPhoneNumbers: string[]; body: string }>;
  /**
   * valid: access tokens the API accepts (clear() it to force a 401).
   * refresh: the refresh token the token endpoint accepts (and returns on code exchange).
   * codes: authorization code → required redirect_uri ('' = any).
   */
  tokens: {
    valid: Set<string>;
    refresh: string;
    rotateOnRefresh: boolean;
    codes: Map<string, string>;
  };
  /** The next request matching method + path prefix gets `status` (+ body) instead. */
  failNext(method: string, pathPrefix: string, status: number, body?: unknown): void;
  /** The next matching request is accepted but never answered (timeout tests). */
  hangNext(method: string, pathPrefix: string): void;
  /** Body served for GET /identity/v1/Users/me (default: one account, acct-1). */
  me: unknown;
  /**
   * Pages served by GET /voice-admin/v1/phone-numbers (items per page), for any accountKey.
   * pageMarker is the next page's index as a string; the last page carries no nextPageMarker.
   */
  numbersPages: unknown[][];
  /**
   * Messages served by the polling routes. `from` is the contact and `to` our number;
   * `direction: 'OUT'` makes it one of our sends to that contact (default 'IN').
   */
  inbound: Array<{
    id: string;
    from: string;
    to: string;
    body: string;
    timestamp: string;
    direction?: 'IN' | 'OUT';
  }>;
  /** Notification channels (party-invites subscribeInbound); `channelId` is `ch-<n>`. */
  channels: Array<{ channelId: string; channelType: string; webhookChannelData?: unknown }>;
  /** Messaging subscriptions; `id` is `sub-<n>`. */
  subscriptions: Array<{
    id: string;
    accountKey: string;
    ownerEntityType: string;
    channelId: string;
    eventTypes: string[];
  }>;
  /**
   * Register a handler. The longest matching prefix wins. API routes require a bearer
   * token from `tokens.valid` (else 401) unless `{ auth: false }`.
   */
  route(method: string, pathPrefix: string, handler: FakeHandler, o?: { auth?: boolean }): void;
  close(): Promise<void>;
}

const token = () => randomBytes(16).toString('hex');

export async function startFakeGoTo(
  opts: { clientId?: string; clientSecret?: string } = {},
): Promise<FakeGoTo> {
  const clientId = opts.clientId ?? 'cid';
  const clientSecret = opts.clientSecret ?? 'csecret';
  const routes: Array<{ method: string; prefix: string; handler: FakeHandler; auth: boolean }> = [];
  const overrides: Array<{ method: string; prefix: string; status?: number; body?: unknown }> = [];

  const takeOverride = (method: string, path: string) => {
    const i = overrides.findIndex((o) => o.method === method && path.startsWith(o.prefix));
    return i === -1 ? undefined : overrides.splice(i, 1)[0];
  };

  const fake: FakeGoTo = {
    url: '',
    requests: [],
    sent: [],
    inbound: [],
    channels: [],
    subscriptions: [],
    me: {
      'urn:scim:schemas:extension:getgo:1.0': {
        accounts: [{ value: 'acct-1', display: 'Test Account' }],
      },
    },
    numbersPages: [[]],
    tokens: { valid: new Set(), refresh: 'refresh-1', rotateOnRefresh: false, codes: new Map() },
    failNext(method, pathPrefix, status, body) {
      overrides.push({ method, prefix: pathPrefix, status, body });
    },
    hangNext(method, pathPrefix) {
      overrides.push({ method, prefix: pathPrefix });
    },
    route(method, pathPrefix, handler, o = {}) {
      routes.push({ method, prefix: pathPrefix, handler, auth: o.auth ?? true });
    },
    close: async () => {
      // Drop hung and keep-alive sockets so node:test has no handles left open.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  fake.tokens.codes.set('code-ok', '');

  // --- /oauth/token (modeled on swu-ideas tokenRequest) ---
  fake.route(
    'POST',
    '/oauth/token',
    (req) => {
      const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        return { status: 401, body: { error: 'invalid_client' } };
      }
      const form = new URLSearchParams(req.body);
      // GoTo wants client credentials in the Basic header only.
      if (form.has('client_secret')) return { status: 400, body: { error: 'invalid_request' } };

      const issue = (refresh?: string) => {
        const access = token();
        fake.tokens.valid.add(access);
        return {
          status: 200,
          body: {
            access_token: access,
            token_type: 'Bearer',
            expires_in: 3600,
            ...(refresh ? { refresh_token: refresh } : {}),
          },
        };
      };

      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const required = fake.tokens.codes.get(form.get('code') ?? '');
        if (required === undefined || (required && required !== form.get('redirect_uri'))) {
          return { status: 400, body: { error: 'invalid_grant' } };
        }
        return issue(fake.tokens.refresh);
      }
      if (grant === 'refresh_token') {
        if (form.get('refresh_token') !== fake.tokens.refresh) {
          return { status: 400, body: { error: 'invalid_grant' } };
        }
        if (!fake.tokens.rotateOnRefresh) return issue();
        fake.tokens.refresh = `refresh-${token()}`;
        return issue(fake.tokens.refresh);
      }
      return { status: 400, body: { error: 'unsupported_grant_type' } };
    },
    { auth: false },
  );

  // --- API: identity (party-invites sms.js) ---
  fake.route('GET', '/identity/v1/Users/me', () => ({ status: 200, body: fake.me }));

  // --- API: phone numbers (swu-ideas listNumbers), paged by pageMarker ---
  fake.route('GET', '/voice-admin/v1/phone-numbers', (req) => {
    const index = Number(req.query.get('pageMarker') ?? 0);
    const items = fake.numbersPages[index];
    if (!items) return { status: 400, body: { error: 'bad_page_marker' } };
    const more = index + 1 < fake.numbersPages.length;
    return { status: 200, body: { items, ...(more ? { nextPageMarker: String(index + 1) } : {}) } };
  });

  // --- API: send a text (swu-ideas sendSms). Only accepted sends land in `sent`. ---
  fake.route('POST', '/messaging/v1/messages', (req) => {
    fake.sent.push(JSON.parse(req.body) as FakeGoTo['sent'][number]);
    return { status: 200, body: { id: `msg-${fake.sent.length}` } };
  });

  // --- API: polling (geeks-tracker fetchInbound). Both read `fake.inbound`, filtered by
  // owner number and oldestTimestamp (compared with Date.parse, like GoTo's mixed precision).
  const since = (req: FakeRequest) => Date.parse(req.query.get('oldestTimestamp') ?? '') || 0;
  const forOwner = (req: FakeRequest) =>
    fake.inbound.filter(
      (m) => m.to === req.query.get('ownerPhoneNumber') && Date.parse(m.timestamp) >= since(req),
    );
  fake.route('GET', '/messaging/v1/conversations', (req) => {
    const last = new Map<string, string>();
    for (const m of forOwner(req)) {
      const prev = last.get(m.from);
      if (!prev || Date.parse(m.timestamp) > Date.parse(prev)) last.set(m.from, m.timestamp);
    }
    const items = [...last].map(([contact, lastMessageTimestamp]) => ({
      contactPhoneNumbers: [contact],
      lastMessageTimestamp,
    }));
    return { status: 200, body: { items } };
  });
  fake.route('GET', '/messaging/v1/messages', (req) => {
    // Served in reverse order on purpose: callers must sort, not trust the API's order.
    const items = forOwner(req)
      .filter((m) => m.from === req.query.get('contactPhoneNumber'))
      .map((m) => ({
        id: m.id,
        direction: m.direction ?? 'IN',
        authorPhoneNumber: m.direction === 'OUT' ? m.to : m.from,
        ownerPhoneNumber: m.to,
        contactPhoneNumber: m.from,
        body: m.body,
        timestamp: m.timestamp,
      }))
      .reverse();
    return { status: 200, body: { items } };
  });

  // --- API: notification channels + subscriptions (party-invites subscribeInbound) ---
  fake.route('GET', '/notification-channel/v1/channels', () => ({
    status: 200,
    body: { items: fake.channels },
  }));
  fake.route('POST', '/notification-channel/v1/channels/', (req) => {
    const channel = {
      ...(JSON.parse(req.body) as { channelType: string }),
      channelId: `ch-${fake.channels.length + 1}`,
    };
    fake.channels.push(channel);
    return { status: 200, body: channel };
  });
  fake.route('GET', '/messaging/v2/subscriptions', (req) => ({
    status: 200,
    body: {
      items: fake.subscriptions.filter((s) => s.accountKey === req.query.get('accountKey')),
    },
  }));
  fake.route('POST', '/messaging/v2/subscriptions', (req) => {
    const sub = {
      ...(JSON.parse(req.body) as Omit<FakeGoTo['subscriptions'][number], 'id'>),
      id: `sub-${fake.subscriptions.length + 1}`,
    };
    fake.subscriptions.push(sub);
    return { status: 200, body: sub };
  });
  fake.route('DELETE', '/messaging/v2/subscriptions/', (req) => {
    const id = req.pathname.slice('/messaging/v2/subscriptions/'.length);
    const i = fake.subscriptions.findIndex((s) => s.id === id);
    if (i === -1) return { status: 404, body: { error: 'not_found' } };
    fake.subscriptions.splice(i, 1);
    return { status: 204 };
  });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const body = Buffer.concat(chunks).toString('utf8');
    fake.requests.push({ method, path, headers, body });

    const send = (r: FakeResponse) => {
      const text =
        r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      res.writeHead(r.status, text ? { 'content-type': 'application/json' } : {});
      res.end(text);
    };

    const override = takeOverride(method, path);
    if (override) {
      if (override.status === undefined) return; // hang: never answer
      return send({ status: override.status, body: override.body });
    }

    const u = new URL(path, 'http://fake');
    const match = routes
      .filter((r) => r.method === method && u.pathname.startsWith(r.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (!match) return send({ status: 404, body: { error: 'not_found' } });
    if (match.auth) {
      const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
      if (!bearer || !fake.tokens.valid.has(bearer)) {
        return send({ status: 401, body: { error: 'invalid_token' } });
      }
    }
    send(
      await match.handler({
        method,
        path,
        pathname: u.pathname,
        query: u.searchParams,
        headers,
        body,
      }),
    );
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
