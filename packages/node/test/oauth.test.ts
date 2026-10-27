import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoToAuth } from '../src/oauth.js';
import { createGoToHttp } from '../src/http.js';
import { ConfigResolver } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { FileStore } from '../src/store/file.js';
import { SecretBox } from '../src/secrets.js';
import {
  GoToSmsError,
  LoginExpiredError,
  NotConfiguredError,
  TemporaryError,
} from '../src/errors.js';
import type { GoToSmsStore } from '../src/store/types.js';
import type { Logger } from '../src/types.js';
import { startFakeGoTo, type FakeGoTo } from './helpers/fake-goto.js';

const T = 't1';
const REDIRECT = 'https://app.example/goto/callback';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(
  o: {
    env?: NodeJS.ProcessEnv;
    store?: GoToSmsStore;
    box?: SecretBox;
    timeoutMs?: number;
    fake?: FakeGoTo;
  } = {},
) {
  const fake = o.fake ?? (await startFakeGoTo());
  if (!o.fake) cleanups.push(() => fake.close());
  const clock = { t: 1_000_000_000 };
  const store = o.store ?? new MemoryStore();
  const box = o.box ?? new SecretBox(randomBytes(32));
  const env = o.env ?? { GOTO_CLIENT_ID: 'cid', GOTO_CLIENT_SECRET: 'csecret' };
  const make = () =>
    new GoToAuth({
      store,
      tenant: T,
      box,
      config: new ConfigResolver({ store, tenant: T, box, options: {}, env }),
      fetch: (url, init) => fetch(url, init),
      authBaseUrl: fake.url,
      redirectUri: REDIRECT,
      now: () => clock.t,
      logger: silent,
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    });
  const auth = make();
  const tokenCalls = () => fake.requests.filter((r) => r.path === '/oauth/token').length;
  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
  const connect = async (a = auth) => a.finishConnect('code-ok', stateOf(await a.startConnect()));
  return { fake, clock, store, box, auth, make, tokenCalls, stateOf, connect };
}

const isCode = (code: string) => (err: unknown) => err instanceof GoToSmsError && err.code === code;

test('C1 authorize URL has client_id, redirect_uri, response_type=code, state and no scope/prompt', async () => {
  const { auth, fake } = await setup();
  const u = new URL(await auth.startConnect());
  assert.equal(`${u.origin}${u.pathname}`, `${fake.url}/oauth/authorize`);
  assert.deepEqual([...u.searchParams.keys()].sort(), [
    'client_id',
    'redirect_uri',
    'response_type',
    'state',
  ]);
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.match(u.searchParams.get('state')!, /^[A-Za-z0-9_-]{43}$/);
});

test('C2 token call uses Basic auth and form body without client_secret', async () => {
  const { connect, fake, auth } = await setup();
  fake.tokens.codes.set('code-ok', REDIRECT); // fake now also checks redirect_uri
  await connect();
  const req = fake.requests.find((r) => r.path === '/oauth/token')!;
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, `Basic ${Buffer.from('cid:csecret').toString('base64')}`);
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(req.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'code-ok');
  assert.equal(form.get('redirect_uri'), REDIRECT);
  assert.equal(form.has('client_secret'), false);
  assert.equal(form.has('client_id'), false);
  assert.deepEqual(await auth.status(), {
    connected: true,
    loginExpired: false,
    refreshSource: 'login',
  });
});

test('C3 state is single-use and expires after 10 min', async () => {
  const { auth, clock, stateOf, store } = await setup();
  const s1 = stateOf(await auth.startConnect());
  await auth.finishConnect('code-ok', s1);
  await assert.rejects(auth.finishConnect('code-ok', s1), isCode('bad_state'));

  const s2 = stateOf(await auth.startConnect());
  clock.t += 10 * 60_000 + 1;
  await assert.rejects(auth.finishConnect('code-ok', s2), isCode('bad_state'));
  assert.equal(await store.get(T, `state:${s2}`), undefined, 'expired state deleted on use');

  // Wrong length / junk: a clean bad_state, never a TypeError from timingSafeEqual.
  for (const junk of ['', 'short', s2 + 'x', 'a'.repeat(43) + 'é', '../tokens']) {
    await assert.rejects(auth.finishConnect('code-ok', junk), isCode('bad_state'));
  }
});

test('C3 startConnect sweeps expired states', async () => {
  const { auth, clock, stateOf, store } = await setup();
  const old = stateOf(await auth.startConnect());
  clock.t += 10 * 60_000 + 1;
  const fresh = stateOf(await auth.startConnect());
  assert.deepEqual(
    (await store.list(T, 'state:')).map((e) => e.key),
    [`state:${fresh}`],
  );
  assert.notEqual(old, fresh);
});

test('C3 two pending states both work', async () => {
  const { auth, stateOf } = await setup();
  const a = stateOf(await auth.startConnect());
  const b = stateOf(await auth.startConnect());
  await auth.finishConnect('code-ok', b);
  await auth.finishConnect('code-ok', a);
  assert.equal((await auth.status()).connected, true);
});

test('state survives a restart (Review Focus 3)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goto-oauth-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.json');
  const box = new SecretBox(randomBytes(32));
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());

  const A = await setup({ fake, box, store: new FileStore({ path }) });
  const state = A.stateOf(await A.auth.startConnect());

  const B = await setup({ fake, box, store: new FileStore({ path }) });
  await B.auth.finishConnect('code-ok', state);
  assert.equal((await B.auth.status()).connected, true);
  assert.equal(typeof (await B.auth.getAccessToken()), 'string');
});

test('finishConnect: rejected code → LoginExpiredError, existing login untouched', async () => {
  const { auth, stateOf, connect } = await setup();
  await connect();
  const before = await auth.getAccessToken();
  await assert.rejects(
    auth.finishConnect('code-bad', stateOf(await auth.startConnect())),
    LoginExpiredError,
  );
  assert.equal(await auth.getAccessToken(), before);
  assert.equal((await auth.status()).loginExpired, false);
});

test('token reused until 60 s before expiry', async () => {
  const { auth, connect, clock, tokenCalls, store, box } = await setup();
  await connect();
  assert.equal(tokenCalls(), 1);
  const first = await auth.getAccessToken();
  const stored = (await store.get(T, 'tokens')) as Record<string, unknown>;
  assert.notEqual(stored.access, first, 'access token is sealed at rest');
  assert.equal(box.open(stored.access as string), first);

  clock.t += 3600_000 - 60_000 - 1; // 1 ms before the reuse window closes
  assert.equal(await auth.getAccessToken(), first);
  assert.equal(tokenCalls(), 1);

  clock.t += 1;
  const second = await auth.getAccessToken();
  assert.notEqual(second, first);
  assert.equal(tokenCalls(), 2);
});

test('C4 single-flight: 5 concurrent calls on an expired token → one refresh', async () => {
  const { auth, connect, clock, tokenCalls } = await setup();
  await connect();
  clock.t += 3600_000;
  const tokens = await Promise.all(Array.from({ length: 5 }, () => auth.getAccessToken()));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(tokenCalls(), 2); // code exchange + one refresh
});

test('C4 rotation: rotated refresh token is stored; non-rotated one is kept', async () => {
  const { auth, connect, clock, store, box, fake } = await setup();
  await connect();
  const refreshOf = async () =>
    box.open(((await store.get(T, 'tokens')) as { refresh: string }).refresh);
  assert.equal(await refreshOf(), 'refresh-1');

  clock.t += 3600_000;
  await auth.getAccessToken(); // rotateOnRefresh false: no refresh_token in the response
  assert.equal(await refreshOf(), 'refresh-1');

  fake.tokens.rotateOnRefresh = true;
  clock.t += 3600_000;
  await auth.getAccessToken();
  assert.notEqual(await refreshOf(), 'refresh-1');
  assert.equal(await refreshOf(), fake.tokens.refresh);
  assert.equal((await auth.status()).refreshSource, 'login');

  // And the rotated token really works for the next refresh.
  clock.t += 3600_000;
  await auth.getAccessToken();
  assert.equal((await auth.status()).loginExpired, false);
});

for (const status of [400, 401, 403]) {
  test(`C5 refresh ${status} → LoginExpiredError and login_expired flag; later calls fail fast`, async () => {
    const { auth, connect, clock, store, fake, tokenCalls } = await setup();
    await connect();
    clock.t += 3600_000;
    fake.failNext('POST', '/oauth/token', status, { error: 'invalid_grant' });
    await assert.rejects(auth.getAccessToken(), LoginExpiredError);
    assert.equal(await store.get(T, 'login_expired'), true);
    assert.deepEqual(await auth.status(), {
      connected: false,
      loginExpired: true,
      refreshSource: 'login',
    });

    const calls = tokenCalls();
    await assert.rejects(auth.getAccessToken(), LoginExpiredError);
    await assert.rejects(auth.forceRefresh(), LoginExpiredError);
    assert.equal(tokenCalls(), calls, 'no network once the login is dead');

    // A new login clears the flag.
    await connect();
    assert.equal(await store.get(T, 'login_expired'), undefined);
    assert.equal(typeof (await auth.getAccessToken()), 'string');
  });
}

test('C5 refresh 503 → TemporaryError, no flag, tokens untouched', async () => {
  const { auth, connect, clock, store, fake } = await setup();
  await connect();
  const before = await store.get(T, 'tokens');
  clock.t += 3600_000;
  fake.failNext('POST', '/oauth/token', 503);
  await assert.rejects(auth.getAccessToken(), TemporaryError);
  assert.equal(await store.get(T, 'login_expired'), undefined);
  assert.deepEqual(await store.get(T, 'tokens'), before);
  // Recovers on the next call (no internal retry; one attempt per call).
  assert.equal(typeof (await auth.getAccessToken()), 'string');
});

test('C5 refresh hang → TemporaryError after timeout, no flag', async () => {
  const { auth, connect, clock, store, fake } = await setup({ timeoutMs: 50 });
  await connect();
  clock.t += 3600_000;
  fake.hangNext('POST', '/oauth/token');
  await assert.rejects(auth.getAccessToken(), (err: unknown) => {
    assert.ok(err instanceof TemporaryError);
    assert.equal(err.requestSent, undefined);
    return true;
  });
  assert.equal(await store.get(T, 'login_expired'), undefined);
});

test('not configured: missing credentials, unreadable credentials, never connected', async () => {
  const none = await setup({ env: {} });
  await assert.rejects(none.auth.startConnect(), NotConfiguredError);
  await assert.rejects(none.auth.getAccessToken(), NotConfiguredError);

  // Stored client secret sealed with a different key → credentialsUnreadable.
  const store = new MemoryStore();
  await store.set(T, 'config:clientId', 'cid');
  await store.set(T, 'config:clientSecret', new SecretBox(randomBytes(32)).seal('csecret'));
  const unreadable = await setup({ env: {}, store });
  await assert.rejects(unreadable.auth.startConnect(), NotConfiguredError);
  await assert.rejects(unreadable.auth.getAccessToken(), NotConfiguredError);

  const fresh = await setup();
  await assert.rejects(
    fresh.auth.getAccessToken(),
    new NotConfiguredError('Not connected to GoTo — open the setup page and click Connect'),
  );
  assert.deepEqual(await fresh.auth.status(), { connected: false, loginExpired: false });
});

test('disconnect deletes tokens and login_expired', async () => {
  const { auth, connect, store, clock, fake } = await setup();
  await connect();
  clock.t += 3600_000;
  fake.failNext('POST', '/oauth/token', 400);
  await assert.rejects(auth.getAccessToken(), LoginExpiredError);
  await auth.disconnect();
  assert.equal(await store.get(T, 'tokens'), undefined);
  assert.equal(await store.get(T, 'login_expired'), undefined);
  assert.deepEqual(await auth.status(), { connected: false, loginExpired: false });
});

test('seeded from env: first use refreshes with the seed; restart keeps the rotated token', async () => {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  fake.tokens.rotateOnRefresh = true;
  const seed = fake.tokens.refresh;
  const env = { GOTO_CLIENT_ID: 'cid', GOTO_CLIENT_SECRET: 'csecret', GOTO_REFRESH_TOKEN: seed };
  const store = new MemoryStore();
  const box = new SecretBox(randomBytes(32));

  const A = await setup({ fake, env, store, box });
  assert.equal(typeof (await A.auth.getAccessToken()), 'string');
  const form = new URLSearchParams(fake.requests.at(-1)!.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), seed);
  const stored = (await store.get(T, 'tokens')) as Record<string, unknown>;
  assert.equal(stored.source, 'seeded-from-env');
  assert.equal(stored.seedHash, createHash('sha256').update(seed).digest('hex'));
  assert.equal((await A.auth.status()).refreshSource, 'seeded-from-env');
  assert.notEqual(box.open(stored.refresh as string), seed, 'rotated away from the seed');

  // Restart with the same env, token expired: must refresh with the stored (rotated)
  // token. Re-using the seed would be refused by the fake (400 → LoginExpiredError).
  const B = await setup({ fake, env, store, box });
  B.clock.t += 3600_000;
  assert.equal(typeof (await B.auth.getAccessToken()), 'string');
  assert.equal(
    new URLSearchParams(fake.requests.at(-1)!.body).get('refresh_token') === seed,
    false,
  );
  assert.equal((await B.auth.status()).refreshSource, 'seeded-from-env');
  assert.equal(await store.get(T, 'login_expired'), undefined);
});

test('new env seed after login expired recovers', async () => {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  const store = new MemoryStore();
  const box = new SecretBox(randomBytes(32));
  const base = { GOTO_CLIENT_ID: 'cid', GOTO_CLIENT_SECRET: 'csecret' };

  const A = await setup({ fake, store, box, env: { ...base, GOTO_REFRESH_TOKEN: 'refresh-1' } });
  await A.auth.getAccessToken();
  // GoTo revokes the login.
  fake.tokens.refresh = 'refresh-2';
  A.clock.t += 3600_000;
  await assert.rejects(A.auth.getAccessToken(), LoginExpiredError);

  // Same seed after restart: still dead, no network.
  const calls = A.tokenCalls();
  const same = await setup({ fake, store, box, env: { ...base, GOTO_REFRESH_TOKEN: 'refresh-1' } });
  await assert.rejects(same.auth.getAccessToken(), LoginExpiredError);
  assert.equal(A.tokenCalls(), calls);

  // Operator pastes a new token into env and restarts.
  const B = await setup({ fake, store, box, env: { ...base, GOTO_REFRESH_TOKEN: 'refresh-2' } });
  assert.equal(typeof (await B.auth.getAccessToken()), 'string');
  assert.equal(await store.get(T, 'login_expired'), undefined);
  assert.deepEqual(await B.auth.status(), {
    connected: true,
    loginExpired: false,
    refreshSource: 'seeded-from-env',
  });
});

test('an env seed never overrides a browser login', async () => {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  const store = new MemoryStore();
  const box = new SecretBox(randomBytes(32));
  const A = await setup({ fake, store, box });
  await A.connect();
  const B = await setup({
    fake,
    store,
    box,
    env: { GOTO_CLIENT_ID: 'cid', GOTO_CLIENT_SECRET: 'csecret', GOTO_REFRESH_TOKEN: 'other' },
  });
  const calls = B.tokenCalls();
  await B.auth.getAccessToken();
  assert.equal(B.tokenCalls(), calls);
  assert.equal((await B.auth.status()).refreshSource, 'login');
});

test('http 401 → one forceRefresh and one retry; second 401 → LoginExpiredError', async () => {
  const { auth, connect, fake, tokenCalls, store } = await setup();
  await connect();
  const http = createGoToHttp({
    apiBaseUrl: fake.url,
    fetch: (url, init) => fetch(url, init),
    getToken: () => auth.getAccessToken(),
    forceRefresh: () => auth.forceRefresh(),
  });
  const me = await http.json<Record<string, { accounts: unknown[] }>>(
    'GET',
    '/identity/v1/Users/me',
  );
  assert.deepEqual(me['urn:scim:schemas:extension:getgo:1.0']!.accounts, [
    { value: 'acct-1', display: 'Test Account' },
  ]);
  const apiReq = fake.requests.at(-1)!;
  assert.match(apiReq.headers.authorization!, /^Bearer /);
  assert.equal(apiReq.headers.accept, 'application/json');
  assert.equal(apiReq.headers['content-type'], undefined);

  fake.tokens.valid.clear(); // GoTo revoked the access token early
  const calls = tokenCalls();
  await http.json('GET', '/identity/v1/Users/me');
  assert.equal(tokenCalls(), calls + 1, 'exactly one forced refresh');

  fake.failNext('GET', '/identity/v1/Users/me', 401);
  fake.failNext('GET', '/identity/v1/Users/me', 401);
  const before = fake.requests.length;
  await assert.rejects(http.json('GET', '/identity/v1/Users/me'), LoginExpiredError);
  // two API calls + one refresh
  assert.equal(fake.requests.length - before, 3);
  // The refresh itself worked, so the login isn't flagged dead.
  assert.equal(await store.get(T, 'login_expired'), undefined);
});

test('http: non-2xx → GoToApiError; empty body → {}; query and JSON body sent', async () => {
  const { auth, connect, fake } = await setup();
  await connect();
  let seen: { query: string; body: string; ct?: string } | undefined;
  fake.route('POST', '/echo', (req) => {
    seen = { query: req.query.toString(), body: req.body, ct: req.headers['content-type'] };
    return { status: 204 };
  });
  const http = createGoToHttp({
    apiBaseUrl: fake.url,
    fetch: (url, init) => fetch(url, init),
    getToken: () => auth.getAccessToken(),
    forceRefresh: () => auth.forceRefresh(),
  });
  assert.deepEqual(await http.json('POST', '/echo', { a: 1 }, { query: { x: 'y z' } }), {});
  assert.deepEqual(seen, { query: 'x=y+z', body: '{"a":1}', ct: 'application/json' });

  fake.failNext('GET', '/identity', 422, 'x'.repeat(800));
  await assert.rejects(http.json('GET', '/identity/v1/Users/me'), (err: unknown) => {
    assert.ok(err instanceof GoToSmsError && err.code === 'api');
    assert.equal((err as unknown as { status: number }).status, 422);
    assert.equal((err as unknown as { body: string }).body.length, 500);
    return true;
  });
});

test('http: timeout → TemporaryError with requestSent; token errors pass through without it', async () => {
  const { auth, connect, fake, clock } = await setup();
  await connect();
  const http = createGoToHttp({
    apiBaseUrl: fake.url,
    fetch: (url, init) => fetch(url, init),
    getToken: () => auth.getAccessToken(),
    forceRefresh: () => auth.forceRefresh(),
  });
  fake.hangNext('GET', '/identity');
  await assert.rejects(
    http.json('GET', '/identity/v1/Users/me', undefined, { timeoutMs: 50 }),
    (err: unknown) => {
      assert.ok(err instanceof TemporaryError);
      assert.equal(err.requestSent, true);
      return true;
    },
  );

  clock.t += 3600_000;
  fake.failNext('POST', '/oauth/token', 503);
  await assert.rejects(http.json('GET', '/identity/v1/Users/me'), (err: unknown) => {
    assert.ok(err instanceof TemporaryError);
    assert.equal(err.requestSent, undefined);
    return true;
  });
});
