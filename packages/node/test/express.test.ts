import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createGoToSms, type GoToSms, type ResolvedOptions } from '../src/client.js';
import { buildExpressRouter } from '../src/server/express.js';
import { MemoryStore } from '../src/store/memory.js';
import type { StatusPayload } from '../src/server/status.js';
import { SETUP_HTML } from '../src/server/setup-html.generated.js';
import { startFakeGoTo } from './helpers/fake-goto.js';
import { connectedSms, recorder, silent } from './helpers/sms.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const NO_AUTH =
  'goto-sms: pass authorize(req) to createGoToSms (or allowUnauthenticatedSetup: true in development)';

/** Listens on an ephemeral port; returns the base URL. */
async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanups.push(() => new Promise((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A connected instance with router() mounted at `mount`. */
async function mounted(
  mount = '/goto-sms',
  o: Parameters<typeof connectedSms>[1] = {},
): Promise<{ sms: GoToSms; base: string }> {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  const sms = await connectedSms(fake, { authorize: () => true, ...o });
  cleanups.push(() => sms.close());
  const app = express();
  app.use(mount, sms.router());
  return { sms, base: await listen(app) };
}

/** Same-origin headers for a state-changing request against `base`. */
const jsonPost = (base: string, body: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body,
});

test('GET /goto-sms/ serves html containing goto-sms v', async () => {
  const { base } = await mounted();
  const res = await fetch(`${base}/goto-sms/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('goto-sms v'));
  // The real page, not the stub embed-setup.mjs writes when setup-ui wasn't built.
  assert.ok(html.includes('GoTo OAuth client'), 'run npm run build first: got the stub page');
});

test('page has no absolute /goto-sms/ or /api/ URLs', () => {
  const absolute = /["'`](\/goto-sms|\/api)\//;
  assert.ok(SETUP_HTML.includes('GoTo OAuth client'), 'run npm run build first: got the stub');
  assert.ok(!absolute.test(SETUP_HTML));
  // The sources too, so the check means something even before a build.
  for (const f of ['index.html', 'app.ts']) {
    const src = readFileSync(new URL(`../../../setup-ui/src/${f}`, import.meta.url), 'utf8');
    assert.ok(!absolute.test(src), f);
  }
});

test('/goto-sms without a trailing slash redirects relatively to ./goto-sms/', async () => {
  const { base } = await mounted('/admin/tools/sms', { mountPath: '/admin/tools/sms' });
  const res = await fetch(`${base}/admin/tools/sms?x=1`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  // Relative, so it also works behind a proxy that strips a path prefix.
  assert.equal(res.headers.get('location'), './sms/?x=1');
  const page = await fetch(new URL(res.headers.get('location')!, `${base}/admin/tools/sms?x=1`));
  assert.equal(page.status, 200);
});

test('HEAD maps to GET', async () => {
  const { base } = await mounted();
  const res = await fetch(`${base}/goto-sms/api/status`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /json/);
});

test('JSON body round-trip through POST /api/credentials', async () => {
  const { base } = await mounted();
  const res = await fetch(
    `${base}/goto-sms/api/credentials`,
    jsonPost(base, JSON.stringify({ clientId: 'new-client' })),
  );
  assert.equal(res.status, 200);
  const status = (await res.json()) as StatusPayload;
  assert.equal(status.clientId, 'new-client');
  assert.equal(status.sources.clientId, 'store');
  assert.ok(!JSON.stringify(status).includes('csecret'));
});

test('malformed JSON gives the contract JSON error, not an HTML page', async () => {
  const { base } = await mounted();
  const res = await fetch(`${base}/goto-sms/api/credentials`, jsonPost(base, '{nope'));
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, 'invalid_input');
});

test('cross-origin POST is refused through the router', async () => {
  const { base } = await mounted();
  const res = await fetch(`${base}/goto-sms/api/credentials`, {
    ...jsonPost(base, '{}'),
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, 'cross_origin');
});

test('webhookRouter() exposes only /inbound', async () => {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  // No authorize: the webhook is authenticated by its path secret alone.
  const sms = await connectedSms(fake);
  cleanups.push(() => sms.close());
  const secret = 'S'.repeat(43);
  await sms.core.store.set(sms.core.tenant, 'inbound:mode', 'webhook');
  await sms.core.store.set(sms.core.tenant, 'inbound:webhookSecret', secret);
  const app = express();
  app.use('/goto-sms', sms.webhookRouter());
  const base = await listen(app);

  for (const path of ['/', '/api/status', `/inbound/${secret}`]) {
    const res = await fetch(`${base}/goto-sms${path}`);
    assert.equal(res.status, 404, `GET ${path}`);
  }
  const post = await fetch(`${base}/goto-sms/api/credentials`, jsonPost(base, '{}'));
  assert.equal(post.status, 404);
  // Not an inbound text: acknowledged and ignored.
  const hook = await fetch(`${base}/goto-sms/inbound/${secret}`, jsonPost(base, '{}'));
  assert.equal(hook.status, 204);
  const wrong = await fetch(`${base}/goto-sms/inbound/${'x'.repeat(43)}`, jsonPost(base, '{}'));
  assert.equal(wrong.status, 404);
  // GoTo's URL check while creating the channel.
  const options = await fetch(`${base}/goto-sms/inbound/${secret}`, { method: 'OPTIONS' });
  assert.equal(options.status, 200, 'OPTIONS reaches the webhook through webhookRouter()');
});

test('baseUrl mismatch warns once', async () => {
  const { logger, lines } = recorder();
  const { base } = await mounted('/elsewhere', { logger });
  await fetch(`${base}/elsewhere/api/status`);
  await fetch(`${base}/elsewhere/api/status`);
  const warns = lines.filter((l) => l.level === 'warn' && l.m.includes('mounted at'));
  assert.equal(warns.length, 1);
  assert.equal(
    warns[0]!.m,
    'goto-sms: mounted at /elsewhere but mountPath option is /goto-sms; the redirect URI shown will be wrong',
  );
});

test('sms.router() throws at creation without authorize', () => {
  const sms = createGoToSms({
    store: new MemoryStore(),
    encryptionKey: 'k',
    env: {},
    logger: silent,
  });
  cleanups.push(() => sms.close());
  assert.throws(() => sms.router(), { message: NO_AUTH });
});

test('the page and status still answer when startup failed', async () => {
  // A custom store, no dataDir and no key: ready rejects with NotConfiguredError.
  const sms = createGoToSms({
    store: new MemoryStore(),
    env: {},
    logger: silent,
    authorize: () => true,
  });
  cleanups.push(() => sms.close());
  await assert.rejects(sms.ready);
  const app = express();
  app.use('/goto-sms', sms.router());
  const base = await listen(app);

  const page = await fetch(`${base}/goto-sms/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('goto-sms v'));
  const status = (await (await fetch(`${base}/goto-sms/api/status`)).json()) as StatusPayload;
  assert.equal(status.configured, false);
  assert.equal(
    status.startupError,
    'Set GOTO_SMS_ENCRYPTION_KEY (or give a dataDir/store the package can keep a key file in)',
  );
  const save = await fetch(`${base}/goto-sms/api/credentials`, jsonPost(base, '{}'));
  assert.equal(save.status, 400);
  assert.equal(((await save.json()) as { error: string }).error, 'not_configured');
  assert.deepEqual(await sms.status(), status);
});

test('authorize still applies when startup failed', async () => {
  const sms = createGoToSms({
    store: new MemoryStore(),
    env: {},
    logger: silent,
    authorize: () => false,
  });
  cleanups.push(() => sms.close());
  const app = express();
  app.use('/goto-sms', sms.router());
  const base = await listen(app);
  assert.equal((await fetch(`${base}/goto-sms/`)).status, 403);
  assert.equal((await fetch(`${base}/goto-sms/api/status`)).status, 403);
});

test("root mount '/': redirect URI and webhook URL have one slash, and no mount warning", async () => {
  const { logger, lines } = recorder();
  const { sms, base } = await mounted('/', { mountPath: '/', logger });
  const status = (await (await fetch(`${base}/api/status`)).json()) as StatusPayload;
  assert.equal(status.redirectUri, 'https://app.example/callback');
  assert.equal(sms.core.webhookUrl('S'), 'https://app.example/inbound/S');
  assert.equal(sms.core.options.mountPath, '');
  assert.ok(!lines.some((l) => l.m.includes('mounted at')), 'no false mount warning');
});

test('publicUrl with a trailing slash and mountPath / → https://app.example/callback', async () => {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  const sms = await connectedSms(fake, { publicUrl: 'https://app.example/', mountPath: '/' });
  cleanups.push(() => sms.close());
  assert.equal((await sms.status()).redirectUri, 'https://app.example/callback');
  const defaults = await connectedSms(fake, { publicUrl: 'https://app.example/', mountPath: '' });
  cleanups.push(() => defaults.close());
  assert.equal((await defaults.status()).redirectUri, 'https://app.example/callback');
});

test('an error thrown while sending the response reaches the error handler', async () => {
  const app = express();
  // A BigInt makes res.json() throw before any header is sent.
  const router = buildExpressRouter({
    options: { mountPath: '' } as ResolvedOptions,
    logger: silent,
    handle: async () => ({ status: 200, json: { n: 1n } }),
  });
  app.use(router);
  const base = await listen(app);
  const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(2000) });
  assert.equal(res.status, 500);
  assert.equal(((await res.json()) as { error: string }).error, 'internal');
});

test('HEAD /callback does not consume the OAuth state', async () => {
  const { sms, base } = await mounted('/goto-sms', { connect: false });
  await sms.core.config.save({ clientId: 'cid', clientSecret: 'csecret' });
  const state = new URL(await sms.core.auth.startConnect()).searchParams.get('state')!;
  const url = `${base}/goto-sms/callback?code=code-ok&state=${encodeURIComponent(state)}`;
  const head = await fetch(url, { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 200);
  const get = await fetch(url, { redirect: 'manual' });
  assert.equal(get.status, 302);
  assert.equal(get.headers.get('location'), './?connected=1');
});
