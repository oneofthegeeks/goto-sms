import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoToSms } from '../src/client.js';
import { NotConfiguredError } from '../src/errors.js';
import { MemoryStore } from '../src/store/memory.js';
import type { InboundMessage } from '../src/types.js';
import { startFakeGoTo } from './helpers/fake-goto.js';
import { connectedSms, FROM, PEER, recorder, silent } from './helpers/sms.js';

const T0 = Date.parse('2026-10-27T10:00:00Z');
const ONE_PROCESS =
  'Another process is using this goto-sms store; run one process per store (see README)';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Level = 'debug' | 'info' | 'warn' | 'error';
/** Replaces console's log methods with recorders until the test's cleanup runs. */
function captureConsole() {
  const calls: Array<{ level: Level; args: unknown[] }> = [];
  const levels: Level[] = ['debug', 'info', 'warn', 'error'];
  const saved = levels.map((level) => [level, console[level]] as const);
  for (const level of levels) {
    console[level] = (...args: unknown[]) => void calls.push({ level, args });
  }
  cleanups.unshift(async () => {
    for (const [level, fn] of saved) console[level] = fn;
  });
  return calls;
}

async function fakeGoTo() {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  return fake;
}

test('facade end-to-end on fake', async () => {
  const fake = await fakeGoTo();
  const sms = await connectedSms(fake, { now: () => T0 });
  cleanups.push(() => sms.close());

  const r = await sms.send('(801) 555-0123', 'hello');
  assert.equal(r.status, 'sent');
  assert.equal(fake.sent[0]!.body, 'hello');

  const got: InboundMessage[] = [];
  sms.on('message', (m) => void got.push(m));
  fake.inbound.push({
    id: 'g-1',
    from: PEER,
    to: FROM,
    body: 'hi back',
    timestamp: '2026-10-27T10:00:01Z',
  });
  await sms.core.poller.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0]!.text, 'hi back');

  // off() removes the handler.
  const off = (m: InboundMessage) => void got.push(m);
  sms.on('message', off).off('message', off);
  fake.inbound.push({
    id: 'g-2',
    from: PEER,
    to: FROM,
    body: 'two',
    timestamp: '2026-10-27T10:00:02Z',
  });
  await sms.core.poller.tick();
  assert.equal(got.length, 2);

  await sms.optOuts.add(PEER, 'admin');
  assert.equal(await sms.optOuts.has(PEER), true);
  assert.equal((await sms.send(PEER, 'nope')).status, 'opted_out');

  const s = await sms.status();
  assert.equal(s.connected, true);
  assert.equal(s.sources.clientSecret, 'store');
  assert.equal(JSON.stringify(s).includes('csecret'), false, 'status never carries the secret');
});

test('second instance on same store logs the one-process warning', async () => {
  const store = new MemoryStore();
  const first = createGoToSms({ store, encryptionKey: 'k', env: {}, logger: silent });
  cleanups.push(() => first.close());
  await first.ready;
  const rec = recorder();
  const second = createGoToSms({ store, encryptionKey: 'k', env: {}, logger: rec.logger });
  cleanups.push(() => second.close());
  await second.ready;
  assert.ok(rec.lines.some((l) => l.level === 'warn' && l.m === ONE_PROCESS));

  // Once the first one closes and releases the lock, a new instance gets it quietly.
  await first.close();
  await second.close();
  const rec3 = recorder();
  const third = createGoToSms({ store, encryptionKey: 'k', env: {}, logger: rec3.logger });
  cleanups.push(() => third.close());
  await third.ready;
  assert.equal(
    rec3.lines.some((l) => l.m === ONE_PROCESS),
    false,
  );
});

test('ready rejects with NotConfiguredError when no dataDir/store and no encryption key', async () => {
  // A custom store and no dataDir: there's nowhere to keep a keyfile.
  const sms = createGoToSms({ store: new MemoryStore(), env: {}, logger: silent });
  await assert.rejects(sms.ready, NotConfiguredError);
  // send() still answers with a result instead of throwing.
  const r = await sms.send(PEER, 'hi');
  assert.equal(r.status, 'not_connected');
  await sms.close();
});

test('default FileStore in dataDir with a generated keyfile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goto-sms-client-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const sms = createGoToSms({ dataDir: dir, env: {}, logger: silent });
  cleanups.push(() => sms.close());
  await sms.ready;
  await sms.optOuts.add(PEER, 'admin');
  await sms.close();
  const again = createGoToSms({ dataDir: dir, env: {}, logger: silent });
  cleanups.push(() => again.close());
  await again.ready;
  assert.equal(await again.optOuts.has(PEER), true);
});

test('async handler rejection is logged without the message text', async () => {
  const fake = await fakeGoTo();
  const rec = recorder();
  const sms = await connectedSms(fake, { now: () => T0, logger: rec.logger });
  cleanups.push(() => sms.close());
  const later: InboundMessage[] = [];
  sms.on('message', async (m) => {
    await Promise.resolve();
    throw new Error(`could not handle ${m.text}`);
  });
  sms.on('message', (m) => void later.push(m));
  fake.inbound.push({
    id: 'g-1',
    from: PEER,
    to: FROM,
    body: 'secret words',
    timestamp: '2026-10-27T10:00:01Z',
  });
  await sms.core.poller.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(later.length, 1, 'a failing handler does not stop the others');
  assert.ok(rec.lines.some((l) => l.level === 'warn' && /handler/.test(l.m)));
  assert.equal(JSON.stringify(rec.lines).includes('secret words'), false);
});

test('polling mode starts the poller on ready; logger: false is silent', async () => {
  const consoleCalls = captureConsole();
  const fake = await fakeGoTo();
  const store = new MemoryStore(() => T0);
  await store.set('default', 'inbound:mode', 'polling');
  const sms = await connectedSms(fake, {
    store,
    now: () => T0,
    logger: false,
    pollIntervalMs: 60_000,
  });
  cleanups.push(() => sms.close());
  // The first tick ran at start (before connect, so it found no from number); a manual
  // tick now that it's connected proves the poller is wired to the facade's handlers.
  const got: InboundMessage[] = [];
  sms.on('message', (m) => void got.push(m));
  // A throwing handler makes the facade warn, which logger: false must swallow.
  sms.on('message', () => {
    throw new Error('boom');
  });
  fake.inbound.push({
    id: 'g-1',
    from: PEER,
    to: FROM,
    body: 'hi',
    timestamp: '2026-10-27T10:00:01Z',
  });
  await sms.core.poller.tick();
  assert.equal(got.length, 1);
  assert.equal(sms.core.poller.running, true);
  assert.deepEqual(consoleCalls, [], 'logger: false writes nothing to console');
});

test('default logger is console with a [goto-sms] prefix', async () => {
  const consoleCalls = captureConsole();
  const sms = createGoToSms({ store: new MemoryStore(), env: {} });
  await assert.rejects(sms.ready, NotConfiguredError);
  await sms.close();
  const err = consoleCalls.find((c) => c.level === 'error');
  assert.ok(err, 'startup failure is logged to console.error');
  assert.equal(err.args[0], '[goto-sms]');
  assert.equal(typeof err.args[1], 'string');
  assert.equal((err.args[1] as string).startsWith('goto-sms:'), false, 'no doubled prefix');
});

test('status: tokens sealed with an old key read as not connected and unreadable', async () => {
  const fake = await fakeGoTo();
  const store = new MemoryStore();
  const a = await connectedSms(fake, { store });
  assert.equal((await a.status()).ready, true);
  await a.close();

  // The encryption key changed and the admin re-entered the client secret, but the stored
  // GoTo login was sealed with the old key: sends would fail, so status must not say ready.
  const b = await connectedSms(fake, { store, encryptionKey: 'another-key', connect: false });
  cleanups.push(() => b.close());
  await b.core.config.save({ clientId: 'cid', clientSecret: 'csecret', fromNumber: FROM });
  const s = await b.status();
  assert.equal(s.configured, true);
  assert.equal(s.connected, false);
  assert.equal(s.credentialsUnreadable, true);
  assert.equal(s.ready, false);

  // Reconnecting (what the page asks for) replaces the login and clears the state.
  const state = new URL(await b.core.auth.startConnect()).searchParams.get('state')!;
  await b.core.auth.finishConnect('code-ok', state);
  const after = await b.status();
  assert.equal(after.connected, true);
  assert.equal(after.credentialsUnreadable, false);
  assert.equal(after.ready, true);
});

test('default logger drops debug lines', async () => {
  const consoleCalls = captureConsole();
  const sms = createGoToSms({ store: new MemoryStore(), encryptionKey: 'k', env: {} });
  await sms.ready;
  sms.core.logger.debug('goto-sms: polling skipped; no sending number chosen');
  sms.core.logger.warn('goto-sms: shown');
  await sms.close();
  assert.ok(!consoleCalls.some((c) => c.level === 'debug'));
  assert.ok(consoleCalls.some((c) => c.level === 'warn'));
});
