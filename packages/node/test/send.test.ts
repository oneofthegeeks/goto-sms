import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { GoToAuth } from '../src/oauth.js';
import { createGoToHttp, type GoToHttp } from '../src/http.js';
import { ConfigResolver } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { SecretBox } from '../src/secrets.js';
import { OptOuts } from '../src/optouts.js';
import { MessageLog } from '../src/log.js';
import { Sender } from '../src/send.js';
import {
  GoToApiError,
  GoToSmsError,
  LoginExpiredError,
  NotConfiguredError,
  SendFailedError,
  TemporaryError,
} from '../src/errors.js';
import type { Logger, SendResult } from '../src/types.js';
import { startFakeGoTo } from './helpers/fake-goto.js';

const T = 't1';
const FROM = '+18015550100';
const TO = '+18015550123';
const DAY = 86_400_000;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const BASE_ENV = { GOTO_CLIENT_ID: 'cid', GOTO_CLIENT_SECRET: 'csecret', GOTO_FROM_NUMBER: FROM };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(
  o: {
    env?: NodeJS.ProcessEnv;
    connect?: boolean;
    box?: SecretBox;
    store?: MemoryStore;
  } = {},
) {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  const clock = { t: 1_000_000_000_000 };
  const now = () => clock.t;
  const store = o.store ?? new MemoryStore(now);
  const box = o.box ?? new SecretBox(randomBytes(32));
  const env = o.env ?? { ...BASE_ENV };
  const config = new ConfigResolver({ store, tenant: T, box, options: {}, env });
  const auth = new GoToAuth({
    store,
    tenant: T,
    box,
    config,
    fetch,
    authBaseUrl: fake.url,
    redirectUri: 'https://app.example/goto/callback',
    now,
    logger: silent,
  });
  const http = createGoToHttp({
    apiBaseUrl: fake.url,
    fetch,
    getToken: () => auth.getAccessToken(),
    forceRefresh: () => auth.forceRefresh(),
  });
  const optOuts = new OptOuts(store, T, now);
  const log = new MessageLog(store, T, now);
  const make = (over: Partial<ConstructorParameters<typeof Sender>[0]> = {}) =>
    new Sender({
      http,
      auth,
      config,
      optOuts,
      log,
      store,
      tenant: T,
      now,
      timeoutMs: 10_000,
      maxBody: 1600,
      logOnly: false,
      env,
      logger: silent,
      ...over,
    });
  if (o.connect ?? true) {
    const state = new URL(await auth.startConnect()).searchParams.get('state')!;
    await auth.finishConnect('code-ok', state);
  }
  const posts = () =>
    fake.requests.filter((r) => r.method === 'POST' && r.path === '/messaging/v1/messages').length;
  return { fake, clock, store, box, env, config, auth, http, optOuts, log, make, posts };
}

test('sends to a normalized number and returns the GoTo message id', async () => {
  const { make, fake } = await setup();
  const r = await make().send('(801) 555-0123', 'hello');
  assert.deepEqual(r, { status: 'sent', to: TO, messageId: 'msg-1' });
  assert.deepEqual(fake.sent, [
    { ownerPhoneNumber: FROM, contactPhoneNumbers: [TO], body: 'hello' },
  ]);
});

test('invalid number → invalid_number with no network call', async () => {
  const { make, fake } = await setup();
  const before = fake.requests.length;
  const r = await make().send('555-0100', 'hello');
  assert.equal(r.status, 'invalid_number');
  assert.equal(fake.requests.length, before);
});

test('C9 owner number refused (no network)', async () => {
  const { make, posts } = await setup();
  const r = await make().send('801.555.0100', 'hello');
  assert.deepEqual(r, {
    status: 'rejected',
    reason: "GoTo can't text the sending number itself",
    to: FROM,
  });
  assert.equal(posts(), 0);
});

test('C10 opted-out refused (no network)', async () => {
  const { make, optOuts, posts, fake } = await setup();
  await optOuts.add(TO, 'keyword');
  const sender = make();
  const r = await sender.send('801-555-0123', 'hello');
  assert.equal(r.status, 'opted_out');
  assert.equal(posts(), 0);
  // The one allowed send: the STOP confirmation.
  const confirm = await sender.send(TO, 'You are unsubscribed', { bypassOptOut: true });
  assert.equal(confirm.status, 'sent');
  assert.equal(fake.sent.length, 1);
});

test('C11 same dedupeKey sends once, sequentially and concurrently', async () => {
  const { make, fake, posts } = await setup();
  const sender = make();

  // Sequential.
  const first = await sender.send(TO, 'code 1234', { dedupeKey: 'k1' });
  const second = await sender.send(TO, 'code 1234', { dedupeKey: 'k1' });
  assert.equal(first.status, 'sent');
  assert.equal(first.deduped, undefined);
  assert.deepEqual(second, { ...first, deduped: true });
  assert.equal(fake.sent.length, 1);

  // Concurrent: both callers await one in-flight send.
  const [a, b] = await Promise.all([
    sender.send(TO, 'code 5678', { dedupeKey: 'k2' }),
    sender.send(TO, 'code 5678', { dedupeKey: 'k2' }),
  ]);
  assert.equal(a.status, 'sent');
  assert.equal(a.deduped, undefined);
  assert.deepEqual(b, { ...a, deduped: true });
  assert.equal(fake.sent.length, 2);

  // Persisted: a new Sender (a restart) still knows the key.
  const again = await make().send(TO, 'code 1234', { dedupeKey: 'k1' });
  assert.deepEqual(again, { ...first, deduped: true });
  assert.equal(posts(), 2);

  // Rejected results aren't stored: the same key may be retried.
  fake.failNext('POST', '/messaging/v1/messages', 503);
  const busy = await sender.send(TO, 'later', { dedupeKey: 'k3' });
  assert.equal(busy.status, 'rejected');
  assert.equal(busy.retryable, true);
  const retried = await sender.send(TO, 'later', { dedupeKey: 'k3' });
  assert.equal(retried.status, 'sent');
  assert.equal(retried.deduped, undefined);
});

test('C11 a dedupeKey locked by another process is refused as retryable', async () => {
  const { make, store, posts } = await setup();
  assert.equal(await store.claim(T, 'dedupe-lock:k', 60_000, 'other-process'), true);
  const r = await make().send(TO, 'hi', { dedupeKey: 'k' });
  assert.deepEqual(r, {
    status: 'rejected',
    reason: 'A send with this dedupeKey is already in progress',
    retryable: true,
    to: TO,
  });
  assert.equal(posts(), 0);
});

test('pruneDedupe drops dedupe records older than the log retention', async () => {
  const { make, store, clock, fake } = await setup();
  const sender = make();
  await sender.send(TO, 'old', { dedupeKey: 'old' });
  clock.t += 89 * DAY;
  await sender.send(TO, 'new', { dedupeKey: 'new' });
  clock.t += 2 * DAY; // 'old' is now 91 days old, 'new' 2 days
  await sender.pruneDedupe();
  assert.deepEqual(
    (await store.list(T, 'dedupe:')).map((e) => e.key),
    ['dedupe:new'],
  );
  // The pruned key sends again (after a routine token refresh).
  const r = await sender.send(TO, 'old', { dedupeKey: 'old' });
  assert.equal(r.deduped, undefined);
  assert.equal(fake.sent.length, 3);
});

test('C12 hangNext → uncertain, fake saw exactly 1 POST', async () => {
  const { make, fake, posts } = await setup();
  fake.hangNext('POST', '/messaging/v1/messages');
  const sender = make({ timeoutMs: 200 });
  const r = await sender.send(TO, 'hello', { dedupeKey: 'h' });
  assert.deepEqual(r, {
    status: 'uncertain',
    reason: "GoTo didn't answer in time — the text may or may not have been sent; not retried",
    to: TO,
  });
  assert.equal(posts(), 1);
  // Uncertain is stored: the same key never sends a second copy.
  const again = await sender.send(TO, 'hello', { dedupeKey: 'h' });
  assert.equal(again.deduped, true);
  assert.equal(posts(), 1);
});

test('a 2xx GoTo answer that is not JSON is uncertain, never rejected', async () => {
  const { make, fake } = await setup();
  fake.failNext('POST', '/messaging/v1/messages', 200, '<html>oops</html>');
  const r = await make().send(TO, 'hello');
  assert.equal(r.status, 'uncertain');
  assert.equal(r.retryable, undefined);
});

test('C13 401 then success → sent after one refresh', async () => {
  const { make, fake, posts } = await setup();
  fake.tokens.valid.clear(); // the cached access token is now refused
  const tokenCallsBefore = fake.requests.filter((r) => r.path === '/oauth/token').length;
  const r = await make().send(TO, 'hello');
  assert.equal(r.status, 'sent');
  assert.equal(fake.requests.filter((r) => r.path === '/oauth/token').length - tokenCallsBefore, 1);
  assert.equal(posts(), 2);
  assert.equal(fake.sent.length, 1);
});

test('C13 401 after the refresh too → not_connected, login expired', async () => {
  const { make, fake } = await setup();
  fake.failNext('POST', '/messaging/v1/messages', 401);
  fake.failNext('POST', '/messaging/v1/messages', 401);
  const r = await make().send(TO, 'hello');
  assert.deepEqual(r, {
    status: 'not_connected',
    reason: 'GoTo login expired — reconnect',
    to: TO,
  });
});

test('C14 403 and 10DLC reasons', async () => {
  const { make, fake } = await setup();
  const sender = make();
  const P = '/messaging/v1/messages';

  fake.failNext('POST', P, 403, { message: 'Forbidden' });
  assert.deepEqual(await sender.send(TO, 'x'), {
    status: 'rejected',
    reason:
      "GoTo refused (403): the login lacks messaging.v1.send, or this number isn't SMS-enabled in GoTo Admin",
    to: TO,
  });

  const tenDlc = "This number isn't registered to a 10DLC texting campaign";
  fake.failNext('POST', P, 400, { message: 'Sender not registered with a 10DLC brand' });
  assert.deepEqual(await sender.send(TO, 'x'), { status: 'rejected', reason: tenDlc, to: TO });
  // The 10DLC check wins over the status mapping.
  fake.failNext('POST', P, 403, { message: 'No approved Campaign for this number' });
  assert.deepEqual(await sender.send(TO, 'x'), { status: 'rejected', reason: tenDlc, to: TO });

  for (const status of [408, 429, 500, 503]) {
    fake.failNext('POST', P, status);
    const r = await sender.send(TO, 'x');
    assert.equal(r.status, 'rejected');
    assert.equal(r.retryable, true, `HTTP ${status} is retryable`);
  }

  fake.failNext('POST', P, 422, { message: 'Invalid destination ' + 'z'.repeat(300) });
  const r422 = await sender.send(TO, 'x');
  assert.equal(r422.status, 'rejected');
  assert.equal(r422.retryable, undefined);
  assert.ok(r422.reason!.includes('422'));
  assert.ok(r422.reason!.includes('Invalid destination'));
  assert.ok(!r422.reason!.includes('z'.repeat(201)), 'GoTo message cut to 200 chars');

  // A body that isn't JSON is never echoed.
  fake.failNext('POST', P, 400, 'raw secret-ish text');
  const r400 = await sender.send(TO, 'x');
  assert.equal(r400.status, 'rejected');
  assert.ok(!r400.reason!.includes('raw secret-ish'));
  assert.equal(fake.sent.length, 0);
});

test('C15 unconfigured → not_connected, fake saw 0 POSTs; logOnly + NODE_ENV=production throws at construction', async () => {
  const cases: Array<{ name: string; env: NodeJS.ProcessEnv; connect?: boolean; reason: string }> =
    [
      {
        name: 'no client',
        env: { GOTO_FROM_NUMBER: FROM },
        connect: false,
        reason: "GoTo client ID and secret aren't set",
      },
      {
        name: 'no from number',
        env: { GOTO_CLIENT_ID: 'cid', GOTO_CLIENT_SECRET: 'csecret' },
        reason: 'No sending number chosen',
      },
      {
        name: 'bad from number',
        env: { ...BASE_ENV, GOTO_FROM_NUMBER: 'call me' },
        reason: "The configured sending number isn't a valid phone number",
      },
      {
        name: 'never connected',
        env: { ...BASE_ENV },
        connect: false,
        reason: 'Not connected to GoTo — open the setup page and click Connect',
      },
    ];
  for (const c of cases) {
    const { make, fake } = await setup({ env: c.env, connect: c.connect ?? true });
    const before = fake.requests.length;
    const r = await make().send(TO, 'hello');
    assert.deepEqual(r, { status: 'not_connected', reason: c.reason, to: TO }, c.name);
    assert.equal(fake.requests.length, before, `${c.name}: no network`);
  }

  // Login expired.
  {
    const { make, fake, store } = await setup();
    await store.set(T, 'login_expired', true);
    const before = fake.requests.length;
    const r = await make().send(TO, 'hello');
    assert.deepEqual(r, {
      status: 'not_connected',
      reason: 'GoTo login expired — reconnect',
      to: TO,
    });
    assert.equal(fake.requests.length, before);
  }

  // Stored secret sealed with a different encryption key.
  {
    const store = new MemoryStore();
    const env = { GOTO_CLIENT_ID: 'cid', GOTO_FROM_NUMBER: FROM };
    const oldBox = new SecretBox(randomBytes(32));
    await new ConfigResolver({ store, tenant: T, box: oldBox, options: {}, env }).save({
      clientSecret: 'csecret',
    });
    const { make, fake } = await setup({ env, store, connect: false });
    const r = await make().send(TO, 'hello');
    assert.deepEqual(r, {
      status: 'not_connected',
      reason:
        "Saved GoTo credentials can't be decrypted — re-enter the client secret and reconnect",
      to: TO,
    });
    assert.equal(fake.requests.length, 0);
  }

  // logOnly is refused in production at construction.
  const { make } = await setup({ connect: false });
  assert.throws(
    () => make({ logOnly: true, env: { NODE_ENV: 'production' } }),
    (err: unknown) => err instanceof GoToSmsError && err.code === 'log_only_in_production',
  );
});

test('a seeded GOTO_REFRESH_TOKEN with no stored login can still send', async () => {
  const { make, fake } = await setup({
    env: { ...BASE_ENV, GOTO_REFRESH_TOKEN: 'refresh-1' },
    connect: false,
  });
  const r = await make().send(TO, 'hello');
  assert.equal(r.status, 'sent');
  assert.equal(fake.sent.length, 1);
});

test('a garbled 2xx token answer is rejected (not uncertain) and not deduped', async () => {
  const { make, fake, clock, posts, store } = await setup();
  clock.t += 2 * 3600_000; // the next send must refresh first
  fake.failNext('POST', '/oauth/token', 200, 'not json');
  const sender = make();
  const r = await sender.send(TO, 'hello', { dedupeKey: 'g' });
  assert.equal(r.status, 'rejected');
  assert.equal(r.retryable, true);
  assert.equal(posts(), 0);
  assert.equal(await store.get(T, 'dedupe:g'), undefined);
  const retried = await sender.send(TO, 'hello', { dedupeKey: 'g' });
  assert.equal(retried.status, 'sent');
  assert.equal(retried.deduped, undefined);
  assert.equal(fake.sent.length, 1);
});

test('token fetch failing before the send → rejected and retryable, nothing posted', async () => {
  const { make, fake, clock, posts } = await setup();
  clock.t += 2 * 3600_000; // access token expired: the next send must refresh first
  fake.failNext('POST', '/oauth/token', 503);
  const r = await make().send(TO, 'hello');
  assert.equal(r.status, 'rejected');
  assert.equal(r.retryable, true);
  assert.equal(posts(), 0);
});

test('token and error mapping from a stub http', async () => {
  const { make } = await setup();
  const failing = (err: unknown): GoToHttp => ({
    json: () => Promise.reject(err),
  });
  const cases: Array<[unknown, Partial<SendResult>]> = [
    [
      new NotConfiguredError("Saved GoTo login can't be decrypted — reconnect to GoTo"),
      {
        status: 'not_connected',
        reason: "Saved GoTo login can't be decrypted — reconnect to GoTo",
      },
    ],
    [
      new LoginExpiredError(),
      { status: 'not_connected', reason: 'GoTo login expired — reconnect' },
    ],
    [new TemporaryError('x', { requestSent: true }), { status: 'uncertain' }],
    [new TemporaryError('x'), { status: 'rejected', retryable: true }],
    // A 2xx error not marked as from the token endpoint: the POST was accepted.
    [new GoToApiError(200, 'anything'), { status: 'uncertain' }],
    [new GoToApiError(201, 'Malformed JSON response'), { status: 'uncertain' }],
    // Token endpoint errors happen before the POST: never sent.
    [
      new GoToApiError(200, 'Malformed token response', { tokenEndpoint: true }),
      { status: 'rejected', retryable: true },
    ],
    [
      new GoToApiError(404, 'GoTo token endpoint returned 404', { tokenEndpoint: true }),
      { status: 'rejected' },
    ],
  ];
  for (const [err, expected] of cases) {
    const r = await make({ http: failing(err) }).send(TO, 'hello');
    for (const [k, v] of Object.entries(expected)) {
      assert.equal(r[k as keyof SendResult], v, `${String(err)}: ${k}`);
    }
  }
});

test('logOnly needs only a sending number, runs the gates and never posts', async () => {
  const { make, fake, optOuts, log } = await setup({
    env: { GOTO_FROM_NUMBER: FROM },
    connect: false,
  });
  const sender = make({ logOnly: true });
  const r = await sender.send(TO, 'hello');
  assert.deepEqual(r, { status: 'sent', reason: 'log-only mode', to: TO });
  await optOuts.add(TO, 'admin');
  assert.equal((await sender.send(TO, 'hello')).status, 'opted_out');
  assert.equal((await sender.send(FROM, 'hello')).status, 'rejected');
  assert.equal(fake.requests.length, 0);
  const logged = (await log.list()).find((e) => e.status === 'sent');
  assert.equal(logged?.reason, 'log-only mode');

  const noFrom = await setup({ env: {}, connect: false });
  assert.equal((await noFrom.make({ logOnly: true }).send(TO, 'hi')).status, 'not_connected');
});

test('sendOrThrow ignores a smuggled bypassOptOut', async () => {
  const { make, optOuts, fake } = await setup();
  await optOuts.add(TO, 'keyword');
  const smuggled = { bypassOptOut: true } as any; // oxlint-disable-line typescript/no-explicit-any
  await assert.rejects(make().sendOrThrow(TO, 'hello', smuggled), (err: unknown) => {
    assert.ok(err instanceof SendFailedError);
    assert.equal(err.result.status, 'opted_out');
    return true;
  });
  assert.equal(fake.sent.length, 0);
});

test('logOnly never persists dedupe records, so turning it off sends for real', async () => {
  const { make, store, fake } = await setup();
  const fake1 = await make({ logOnly: true }).send(TO, 'hello', { dedupeKey: 'lo' });
  assert.equal(fake1.reason, 'log-only mode');
  assert.equal(await store.get(T, 'dedupe:lo'), undefined);
  const real = await make().send(TO, 'hello', { dedupeKey: 'lo' });
  assert.equal(real.status, 'sent');
  assert.equal(real.deduped, undefined);
  assert.equal(fake.sent.length, 1);
});

test('every 100th recorded send prunes old dedupe records', async () => {
  const { make, store, clock } = await setup();
  const sender = make();
  await sender.send(TO, 'old', { dedupeKey: 'old' }); // recorded send 1
  clock.t += 91 * 86_400_000;
  // Gate rejections are recorded sends too, and need no network.
  for (let i = 2; i < 100; i++) await sender.send(TO, '');
  assert.notEqual(await store.get(T, 'dedupe:old'), undefined, 'not pruned before the 100th');
  await sender.send(TO, ''); // recorded send 100
  assert.equal(await store.get(T, 'dedupe:old'), undefined);
});

test('sendOrThrow throws SendFailedError carrying result', async () => {
  const { make, optOuts } = await setup();
  const sender = make();
  const ok = await sender.sendOrThrow(TO, 'hello');
  assert.equal(ok.status, 'sent');
  await optOuts.add(TO, 'keyword');
  await assert.rejects(sender.sendOrThrow(TO, 'hello'), (err: unknown) => {
    assert.ok(err instanceof SendFailedError);
    assert.equal(err.result.status, 'opted_out');
    return true;
  });
});

test('1601 chars rejected, 1600 sent', async () => {
  const { make, fake } = await setup();
  const sender = make();
  const tooLong = await sender.send(TO, 'a'.repeat(1601));
  assert.equal(tooLong.status, 'rejected');
  assert.match(tooLong.reason!, /1601.*1600/);
  assert.equal((await sender.send(TO, 'a'.repeat(1600))).status, 'sent');

  // Code points, not UTF-16 units: 1600 emoji are 3200 units but 1600 characters.
  assert.equal((await sender.send(TO, '😀'.repeat(1600))).status, 'sent');
  assert.equal((await sender.send(TO, '😀'.repeat(1601))).status, 'rejected');

  assert.deepEqual(await sender.send(TO, '  \n '), {
    status: 'rejected',
    reason: 'Message text is empty',
    to: TO,
  });
  assert.equal(fake.sent.length, 2);
});

test('log has entry with status/reason and no body', async () => {
  const { make, log, store, fake, clock } = await setup();
  const lines: string[] = [];
  const capture: Logger = {
    debug: (m, x) => lines.push(m + JSON.stringify(x ?? {})),
    info: (m, x) => lines.push(m + JSON.stringify(x ?? {})),
    warn: (m, x) => lines.push(m + JSON.stringify(x ?? {})),
    error: (m, x) => lines.push(m + JSON.stringify(x ?? {})),
  };
  const sender = make({ logger: capture });
  const BODY = 'secret code 998877';
  // Advance the clock between sends: same-ms log entries have no defined order.
  await sender.send(TO, BODY);
  clock.t += 1000;
  fake.failNext('POST', '/messaging/v1/messages', 403);
  await sender.send(TO, BODY);
  clock.t += 1000;
  await sender.send('nope', BODY);

  const entries = await log.list();
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.status, 'invalid_number');
  assert.equal(entries[1]!.status, 'rejected');
  assert.match(entries[1]!.reason!, /403/);
  assert.deepEqual(
    { ...entries[2], id: 'x', at: 'x' },
    {
      id: 'x',
      at: 'x',
      direction: 'outbound',
      from: FROM,
      to: TO,
      status: 'sent',
      gotoId: 'msg-1',
    },
  );
  const raw = JSON.stringify(await store.list(T, 'log:'));
  assert.ok(!raw.includes(BODY), 'body never stored in the log');

  assert.equal(lines.length, 3, 'one log line per send');
  for (const line of lines) {
    assert.ok(!line.includes(BODY), 'no body in logs');
    assert.ok(!line.includes(TO) && !line.includes('8015550123'), 'no full number in logs');
  }
  assert.ok(lines[0]!.includes('0123') && lines[0]!.includes('sent'));
});

test('MessageLog lists newest first with a limit', async () => {
  const store = new MemoryStore();
  const clock = { t: 1_000_000 };
  const log = new MessageLog(store, T, () => clock.t);
  for (let i = 0; i < 60; i++) {
    clock.t += 1000;
    await log.append({ direction: 'outbound', from: FROM, to: TO, status: `s${i}` });
  }
  const page = await log.list();
  assert.equal(page.length, 50);
  assert.equal(page[0]!.status, 's59');
  assert.equal(page[49]!.status, 's10');
  assert.deepEqual(
    (await log.list(2)).map((e) => e.status),
    ['s59', 's58'],
  );
  const first = page[0]!;
  assert.equal(first.at, new Date(clock.t).toISOString());
  assert.match((await store.list(T, 'log:')).at(-1)!.key, /^log:\d{15}:[0-9a-f]{8}$/);
});

test('MessageLog.prune removes >90-day and >maxEntries entries', async () => {
  const store = new MemoryStore();
  const clock = { t: 1_000_000_000_000 };
  const log = new MessageLog(store, T, () => clock.t, { maxEntries: 5 });
  const add = (status: string) => log.append({ direction: 'outbound', from: FROM, to: TO, status });
  await add('ancient');
  clock.t += 91 * DAY;
  for (let i = 0; i < 7; i++) {
    clock.t += 1000;
    await add(`r${i}`);
  }
  await log.prune();
  assert.deepEqual(
    (await log.list()).map((e) => e.status),
    ['r6', 'r5', 'r4', 'r3', 'r2'],
  );

  // Default retention: 90 days, and append prunes on every 100th call.
  const store2 = new MemoryStore();
  const log2 = new MessageLog(store2, T, () => clock.t);
  await log2.append({ direction: 'outbound', from: FROM, to: TO, status: 'old' });
  clock.t += 91 * DAY;
  for (let i = 0; i < 98; i++) {
    await log2.append({ direction: 'outbound', from: FROM, to: TO, status: 'new' });
  }
  assert.equal((await store2.list(T, 'log:')).length, 99, 'no prune before the 100th append');
  await log2.append({ direction: 'outbound', from: FROM, to: TO, status: 'new' });
  assert.equal((await store2.list(T, 'log:')).length, 99, '100th append pruned the old entry');
  assert.ok((await log2.list(200)).every((e) => e.status === 'new'));
});

test('OptOuts add/has/remove/list', async () => {
  const store = new MemoryStore();
  const clock = { t: 1_000_000 };
  const o = new OptOuts(store, T, () => clock.t);
  const OTHER = '+18015550124';
  assert.equal(await o.has(TO), false);
  await o.add(TO, 'keyword');
  clock.t += 1000;
  await o.add(OTHER, 'admin');
  assert.equal(await o.has(TO), true);
  assert.equal((await store.get(T, `optout:${TO}`)) !== undefined, true);
  assert.deepEqual(await o.list(), [
    { number: OTHER, at: new Date(clock.t).toISOString(), source: 'admin' },
    { number: TO, at: new Date(clock.t - 1000).toISOString(), source: 'keyword' },
  ]);
  await o.remove(TO);
  assert.equal(await o.has(TO), false);
  assert.deepEqual(
    (await o.list()).map((e) => e.number),
    [OTHER],
  );
  await assert.rejects(
    o.add('call me', 'admin'),
    (err: unknown) => err instanceof GoToSmsError && err.code === 'invalid_number',
  );
  await assert.rejects(
    o.remove('123'),
    (err: unknown) => err instanceof GoToSmsError && err.code === 'invalid_number',
  );
  assert.equal(await o.has('junk'), false);
});
