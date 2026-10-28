import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createGoToSms, type GoToSms } from '../src/client.js';
import { GoToSmsError } from '../src/errors.js';
import { MemoryStore } from '../src/store/memory.js';
import {
  createHandlers,
  type HttpRequest,
  type HttpResponse,
  type StatusPayload,
} from '../src/server/handlers.js';
import { startFakeGoTo, type FakeGoTo } from './helpers/fake-goto.js';
import { connectedSms, FROM, PEER, silent } from './helpers/sms.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const HTML = '<!doctype html><title>setup</title>';
const NO_AUTH =
  'goto-sms: pass authorize(req) to createGoToSms (or allowUnauthenticatedSetup: true in development)';

async function fakeGoTo(): Promise<FakeGoTo> {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  return fake;
}

async function setup(
  o: Parameters<typeof connectedSms>[1] = {},
): Promise<{ fake: FakeGoTo; sms: GoToSms; handle: (r: HttpRequest) => Promise<HttpResponse> }> {
  const fake = await fakeGoTo();
  const sms = await connectedSms(fake, { authorize: () => true, ...o });
  cleanups.push(() => sms.close());
  return { fake, sms, handle: createHandlers(sms.core, HTML) };
}

/** A same-origin request for the default publicUrl host, unless headers override it. */
function req(
  method: string,
  path: string,
  o: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {},
): HttpRequest {
  return {
    method,
    path,
    query: o.query ?? {},
    headers: {
      host: 'app.example',
      ...(method === 'GET' ? {} : { origin: 'https://app.example' }),
      ...o.headers,
    },
    body: o.body,
    raw: {} as IncomingMessage,
  };
}

const API_ROUTES: Array<[string, string]> = [
  ['GET', '/'],
  ['GET', '/api/status'],
  ['POST', '/api/credentials'],
  ['POST', '/api/connect'],
  ['POST', '/api/disconnect'],
  ['GET', '/api/accounts'],
  ['GET', '/api/numbers'],
  ['POST', '/api/selection'],
  ['POST', '/api/test'],
  ['POST', '/api/incoming'],
  ['GET', '/api/log'],
  ['GET', '/api/opt-outs'],
  ['POST', '/api/opt-outs'],
];

/** Puts the instance in webhook mode with a known secret, without calling GoTo. */
async function webhookMode(sms: GoToSms, secret = 'S'.repeat(43)): Promise<string> {
  await sms.core.store.set(sms.core.tenant, 'inbound:mode', 'webhook');
  await sms.core.store.set(sms.core.tenant, 'inbound:webhookSecret', secret);
  return secret;
}

const envelope = (id: string, text = 'hello there') => ({
  type: 'INBOUND_MESSAGE',
  content: {
    payload: {
      id,
      direction: 'INBOUND',
      authorTouchpoint: PEER,
      ownerPhoneNumber: FROM,
      body: text,
      timestamp: '2026-10-27T10:00:00Z',
    },
  },
});

test('C23 router() without authorize throws; with authorize→false every /api route is 403; /callback and /inbound bypass authorize', async () => {
  const fake = await fakeGoTo();
  const bare = await connectedSms(fake, { connect: false });
  cleanups.push(() => bare.close());
  assert.throws(() => createHandlers(bare.core, HTML), { message: NO_AUTH });

  const prod = await connectedSms(fake, {
    connect: false,
    allowUnauthenticatedSetup: true,
    env: { NODE_ENV: 'production' },
  });
  cleanups.push(() => prod.close());
  assert.throws(() => createHandlers(prod.core, HTML), { message: NO_AUTH });

  const dev = await connectedSms(fake, { connect: false, allowUnauthenticatedSetup: true });
  cleanups.push(() => dev.close());
  const devHandle = createHandlers(dev.core, HTML);
  assert.equal((await devHandle(req('GET', '/api/status'))).status, 200);

  const seen: unknown[] = [];
  const sms = await connectedSms(fake, {
    authorize: (raw) => {
      seen.push(raw);
      return false;
    },
  });
  cleanups.push(() => sms.close());
  const handle = createHandlers(sms.core, HTML);
  for (const [method, path] of API_ROUTES) {
    const r = await handle(req(method, path, { body: {} }));
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  assert.equal(seen.length, API_ROUTES.length, 'authorize got the raw request each time');

  // /callback answers with a redirect, /inbound with 204: neither asked authorize.
  const cb = await handle(req('GET', '/callback', { query: { error: 'access_denied' } }));
  assert.equal(cb.redirect, './?error=goto_login');
  const secret = await webhookMode(sms);
  const inbound = await handle(req('POST', `/inbound/${secret}`, { body: envelope('g-c23') }));
  assert.equal(inbound.status, 204);
  assert.equal(seen.length, API_ROUTES.length);
});

test('C22 /api/status never contains clientSecret or tokens', async () => {
  const { fake, sms, handle } = await setup();
  await sms.send(PEER, 'warm the access token');
  const secret = await webhookMode(sms);
  const r = await handle(req('GET', '/api/status'));
  assert.equal(r.status, 200);
  const s = r.json as StatusPayload;
  assert.equal(s.connected, true);
  assert.equal(s.configured, true);
  assert.equal(s.ready, true);
  assert.equal(s.clientId, 'cid');
  assert.equal(s.fromNumber, FROM);
  assert.equal(s.version, 'dev');
  assert.equal(s.incoming.mode, 'webhook');
  assert.equal(s.incoming.canWebhook, true);
  assert.deepEqual(s.requiredScopes, [
    'messaging.v1.send',
    'messaging.v1.read',
    'messaging.v1.notifications.manage',
    'voice-admin.v1.read',
  ]);

  const text = JSON.stringify(s);
  assert.equal(text.includes('csecret'), false);
  assert.equal(text.includes(fake.tokens.refresh), false);
  assert.ok(fake.tokens.valid.size > 0);
  for (const token of fake.tokens.valid) assert.equal(text.includes(token), false);
  // The webhook secret appears only inside webhookUrl (shown to the authorized admin).
  assert.equal(s.incoming.webhookUrl, `https://app.example/goto-sms/inbound/${secret}`);
  assert.equal(text.split(secret).length - 1, 1);

  // sms.status() is built by the same code.
  assert.deepEqual(await sms.status(), s);
});

test('sms.status() answers configured:false/ready:false when startup failed for lack of a key', async () => {
  const sms = createGoToSms({ store: new MemoryStore(), env: {}, logger: silent });
  cleanups.push(() => sms.close());
  await assert.rejects(sms.ready);
  const s = await sms.status();
  assert.equal(s.configured, false);
  assert.equal(s.ready, false);
  assert.equal(s.connected, false);
  assert.equal(s.sources.clientId, 'unset');
});

test('POST without matching Origin → 403', async () => {
  const { handle } = await setup();
  const evil = await handle(
    req('POST', '/api/disconnect', { body: {}, headers: { origin: 'https://evil.example' } }),
  );
  assert.equal(evil.status, 403);
  const none = await handle(req('POST', '/api/disconnect', { body: {}, headers: { origin: '' } }));
  assert.equal(none.status, 403);
  const nul = await handle(
    req('POST', '/api/disconnect', { body: {}, headers: { origin: 'null' } }),
  );
  assert.equal(nul.status, 403);
  const crossSite = await handle(
    req('POST', '/api/disconnect', {
      body: {},
      headers: { origin: '', 'sec-fetch-site': 'cross-site' },
    }),
  );
  assert.equal(crossSite.status, 403);

  // Sec-Fetch-Site: same-origin alone passes; so does Origin matching the publicUrl host
  // when the proxy rewrote Host.
  const fetchSite = await handle(
    req('POST', '/api/disconnect', {
      body: {},
      headers: { origin: '', 'sec-fetch-site': 'same-origin' },
    }),
  );
  assert.equal(fetchSite.status, 200);
  const proxied = await handle(
    req('POST', '/api/disconnect', { body: {}, headers: { host: 'internal:3000' } }),
  );
  assert.equal(proxied.status, 200);
});

test('redirectUri for nested mount /admin/tools/sms and publicUrl https://x.example → https://x.example/admin/tools/sms/callback', async () => {
  const { handle } = await setup({ mountPath: '/admin/tools/sms', publicUrl: 'https://x.example' });
  const s = (await handle(req('GET', '/api/status'))).json as StatusPayload;
  assert.equal(s.redirectUri, 'https://x.example/admin/tools/sms/callback');
  const r = await handle(req('POST', '/api/connect', { headers: { origin: 'https://x.example' } }));
  assert.equal(r.status, 200);
  const url = new URL((r.json as { url: string }).url);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://x.example/admin/tools/sms/callback');
});

test('POST /api/connect without a publicUrl → 400 no_public_url', async () => {
  const { handle } = await setup({ publicUrl: '' });
  const r = await handle(req('POST', '/api/connect', { body: {} }));
  assert.equal(r.status, 400);
  assert.equal((r.json as { error: string }).error, 'no_public_url');
});

test('inbound: 204 returned and message pending in store before processing', async () => {
  const { sms, handle } = await setup();
  const secret = await webhookMode(sms);
  const got: string[] = [];
  sms.on('message', (m) => void got.push(m.text));

  const original = sms.core.processor.process.bind(sms.core.processor);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let processed!: Promise<void>;
  sms.core.processor.process = (id: string) => {
    processed = gate.then(() => original(id));
    return processed;
  };

  const r = await handle(req('POST', `/inbound/${secret}`, { body: envelope('g-1') }));
  assert.equal(r.status, 204);
  assert.ok(await sms.core.store.get(sms.core.tenant, 'inbound:pending:g-1'), 'pending first');
  assert.deepEqual(got, []);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  await processed;
  assert.deepEqual(got, ['hello there']);
  assert.equal(await sms.core.store.get(sms.core.tenant, 'inbound:pending:g-1'), undefined);
});

test('inbound bad secret → 404', async () => {
  const { sms, handle } = await setup();
  const r1 = await handle(req('POST', '/inbound/wrong', { body: envelope('g-2') }));
  assert.equal(r1.status, 404, 'not in webhook mode');
  const secret = await webhookMode(sms);
  const r2 = await handle(req('POST', '/inbound/wrong', { body: envelope('g-2') }));
  assert.equal(r2.status, 404);
  await sms.core.store.set(sms.core.tenant, 'inbound:mode', 'polling');
  const r3 = await handle(req('POST', `/inbound/${secret}`, { body: envelope('g-2') }));
  assert.equal(r3.status, 404, 'right secret but polling mode');
  assert.equal(await sms.core.store.get(sms.core.tenant, 'inbound:pending:g-2'), undefined);
});

test('inbound: other event types → 204 ignored; a duplicate → 204 without reprocessing', async () => {
  const { sms, handle } = await setup();
  const secret = await webhookMode(sms);
  const other = await handle(
    req('POST', `/inbound/${secret}`, { body: { type: 'MESSAGE_STATUS', content: {} } }),
  );
  assert.equal(other.status, 204);
  let calls = 0;
  const original = sms.core.processor.process.bind(sms.core.processor);
  sms.core.processor.process = (id: string) => {
    calls++;
    return original(id);
  };
  await handle(req('POST', `/inbound/${secret}`, { body: envelope('g-3') }));
  await new Promise((resolve) => setImmediate(resolve));
  const dup = await handle(req('POST', `/inbound/${secret}`, { body: envelope('g-3') }));
  assert.equal(dup.status, 204);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('inbound: persist invalid_inbound → 400', async () => {
  const { sms, handle } = await setup();
  const secret = await webhookMode(sms);
  // parseWebhookEnvelope never yields a message persist rejects, so stand in for one.
  sms.core.processor.persist = () =>
    Promise.reject(new GoToSmsError('Inbound text is missing its id', 'invalid_inbound'));
  const r = await handle(req('POST', `/inbound/${secret}`, { body: envelope('g-4') }));
  assert.equal(r.status, 400);
  assert.equal((r.json as { error: string }).error, 'invalid_inbound');
});

test('credentials POST for env-locked field → 409', async () => {
  const { handle } = await setup({ connect: false, env: { GOTO_CLIENT_ID: 'env-cid' } });
  const r = await handle(req('POST', '/api/credentials', { body: { clientId: 'other' } }));
  assert.equal(r.status, 409);
  assert.equal((r.json as { error: string }).error, 'locked');

  // A blank value for the locked field is "not editable", not a conflict.
  const ok = await handle(
    req('POST', '/api/credentials', { body: { clientId: '', clientSecret: 'new-secret' } }),
  );
  assert.equal(ok.status, 200);
  const s = ok.json as StatusPayload;
  assert.equal(s.clientId, 'env-cid');
  assert.equal(s.sources.clientId, 'env');
  assert.equal(JSON.stringify(s).includes('new-secret'), false);
});

test('credentials POST with a non-string field → 400', async () => {
  const { handle } = await setup();
  const r = await handle(req('POST', '/api/credentials', { body: { clientId: 5 } }));
  assert.equal(r.status, 400);
});

test('incoming webhook enable surfaces GoTo 403 body verbatim', async () => {
  const { fake, sms, handle } = await setup({ accountKey: 'acct-1' });
  fake.failNext('POST', '/messaging/v2/subscriptions', 403, { error: 'first' });
  fake.failNext('POST', '/messaging/v2/subscriptions', 403, { message: 'missing scope' });
  const r = await handle(req('POST', '/api/incoming', { body: { mode: 'webhook' } }));
  assert.equal(r.status, 502);
  assert.deepEqual(r.json, {
    error: 'goto_api',
    message: 'GoTo API error 403',
    gotoStatus: 403,
    gotoBody: JSON.stringify({ message: 'missing scope' }),
  });
  assert.equal(await sms.core.incomingMode(), 'off', 'mode unchanged on failure');
});

test('incoming: webhook → polling → off → webhook switches modes, poller and channels', async () => {
  const { fake, sms, handle } = await setup({ accountKey: 'acct-1' });
  const post = (mode: string) => handle(req('POST', '/api/incoming', { body: { mode } }));

  const w1 = await post('webhook');
  assert.equal(w1.status, 200);
  const s1 = w1.json as StatusPayload;
  assert.equal(s1.incoming.mode, 'webhook');
  assert.equal(await sms.core.store.get(sms.core.tenant, 'inbound:mode'), 'webhook');
  assert.equal(fake.subscriptions.length, 1);
  assert.equal(sms.core.poller.running, false);
  const firstUrl = s1.incoming.webhookUrl!;
  const firstSecret = firstUrl.split('/').pop()!;
  assert.equal(
    (fake.channels[0]!.webhookChannelData as { webhook: { url: string } }).webhook.url,
    firstUrl,
  );

  const p = await post('polling');
  assert.equal((p.json as StatusPayload).incoming.mode, 'polling');
  assert.equal(sms.core.poller.running, true);
  assert.equal(fake.subscriptions.length, 0, 'webhook subscription deleted');
  const oldSecret = await handle(req('POST', `/inbound/${firstSecret}`, { body: envelope('x') }));
  assert.equal(oldSecret.status, 404);

  const off = await post('off');
  assert.equal((off.json as StatusPayload).incoming.mode, 'off');
  assert.equal(sms.core.poller.running, false);
  assert.equal(await sms.core.store.get(sms.core.tenant, 'inbound:mode'), 'off');

  // Re-enable: the rotated secret means a new URL, so a new channel pointing at it.
  const w2 = await post('webhook');
  const secondUrl = (w2.json as StatusPayload).incoming.webhookUrl!;
  assert.notEqual(secondUrl, firstUrl);
  assert.equal(fake.channels.length, 2);
  assert.equal(
    (fake.channels[1]!.webhookChannelData as { webhook: { url: string } }).webhook.url,
    secondUrl,
  );
  assert.equal(fake.subscriptions[0]!.channelId, fake.channels[1]!.channelId);
  const fresh = await handle(
    req('POST', `/inbound/${secondUrl.split('/').pop()!}`, { body: envelope('y') }),
  );
  assert.equal(fresh.status, 204);
  assert.equal(
    (await handle(req('POST', `/inbound/${firstSecret}`, { body: envelope('z') }))).status,
    404,
  );
});

test('incoming: webhook needs an https publicUrl; bad mode → 400', async () => {
  const { handle } = await setup({ accountKey: 'acct-1', publicUrl: 'http://app.example' });
  const r = await handle(req('POST', '/api/incoming', { body: { mode: 'webhook' } }));
  assert.equal(r.status, 400);
  const bad = await handle(req('POST', '/api/incoming', { body: { mode: 'carrier-pigeon' } }));
  assert.equal(bad.status, 400);
});

test('callback: finishes the login and redirects; bad state → error redirect', async () => {
  const { sms, handle } = await setup({ connect: false });
  await sms.core.config.save({ clientId: 'cid', clientSecret: 'csecret' });
  const state = new URL(await sms.core.auth.startConnect()).searchParams.get('state')!;
  const ok = await handle(req('GET', '/callback', { query: { code: 'code-ok', state } }));
  assert.deepEqual(ok, { status: 302, redirect: './?connected=1' });
  assert.equal((await sms.status()).connected, true);
  const replay = await handle(req('GET', '/callback', { query: { code: 'code-ok', state } }));
  assert.equal(replay.redirect, './?error=bad_state');
  const missing = await handle(req('GET', '/callback'));
  assert.equal(missing.redirect, './?error=bad_state');
});

test('setup page, accounts, numbers, selection, test send, log, opt-outs', async () => {
  const { fake, handle } = await setup();
  const page = await handle(req('GET', '/'));
  assert.deepEqual(page, { status: 200, html: HTML });

  const accounts = await handle(req('GET', '/api/accounts'));
  assert.deepEqual(accounts.json, { accounts: [{ key: 'acct-1', name: 'Test Account' }] });

  fake.numbersPages = [[{ number: '+18015550199', name: 'Main' }]];
  const numbers = await handle(req('GET', '/api/numbers', { query: { accountKey: 'acct-1' } }));
  assert.deepEqual(numbers.json, {
    numbers: [{ number: '+18015550199', name: 'Main', accountKey: 'acct-1' }],
  });
  assert.equal((await handle(req('GET', '/api/numbers'))).status, 400);

  const sel = await handle(
    req('POST', '/api/selection', {
      body: { accountKey: 'acct-1', fromNumber: '(801) 555-0199' },
    }),
  );
  assert.equal(sel.status, 200);
  assert.equal((sel.json as StatusPayload).fromNumber, '+18015550199');
  assert.equal((sel.json as StatusPayload).accountKey, 'acct-1');
  const badSel = await handle(req('POST', '/api/selection', { body: { fromNumber: 'call me' } }));
  assert.equal(badSel.status, 400);
  assert.equal((badSel.json as { error: string }).error, 'invalid_number');

  const sent = await handle(req('POST', '/api/test', { body: { to: '801-555-0123' } }));
  assert.equal(sent.status, 200);
  assert.equal((sent.json as { status: string }).status, 'sent');
  assert.equal(fake.sent.at(-1)!.contactPhoneNumbers[0], PEER);

  const log = await handle(req('GET', '/api/log', { query: { limit: '9999' } }));
  const entries = (log.json as { entries: Array<{ to: string }> }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.to, PEER);

  const add = await handle(
    req('POST', '/api/opt-outs', { body: { number: '801 555 0123', action: 'add' } }),
  );
  assert.equal(add.status, 200);
  const list = await handle(req('GET', '/api/opt-outs'));
  const optOuts = (list.json as { optOuts: Array<{ number: string; source: string }> }).optOuts;
  assert.deepEqual(
    optOuts.map((x) => [x.number, x.source]),
    [[PEER, 'admin']],
  );
  await handle(req('POST', '/api/opt-outs', { body: { number: PEER, action: 'remove' } }));
  assert.deepEqual(
    ((await handle(req('GET', '/api/opt-outs'))).json as { optOuts: [] }).optOuts,
    [],
  );
  const bad = await handle(
    req('POST', '/api/opt-outs', { body: { number: PEER, action: 'nuke' } }),
  );
  assert.equal(bad.status, 400);

  assert.equal((await handle(req('GET', '/api/nope'))).status, 404);
});

test('disconnect clears the login; unexpected errors are a generic 500', async () => {
  const { sms, handle } = await setup();
  const r = await handle(req('POST', '/api/disconnect', { body: {} }));
  assert.equal((r.json as StatusPayload).connected, false);

  sms.core.optOuts.list = () => Promise.reject(new Error('disk on fire: secret-ish detail'));
  const boom = await handle(req('GET', '/api/opt-outs'));
  assert.equal(boom.status, 500);
  assert.equal(JSON.stringify(boom.json).includes('disk on fire'), false);
});
