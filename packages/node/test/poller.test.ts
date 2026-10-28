import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../src/inbound/poller.js';
import type { GoToSms } from '../src/client.js';
import type { InboundMessage } from '../src/types.js';
import { startFakeGoTo, type FakeGoTo } from './helpers/fake-goto.js';
import { connectedSms, FROM, PEER, recorder, silent } from './helpers/sms.js';

const T0 = Date.parse('2026-10-27T10:00:00Z');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  const clock = { t: T0 };
  const now = () => clock.t;
  const sms = await connectedSms(fake, { now });
  cleanups.push(() => sms.close());
  const got: InboundMessage[] = [];
  sms.on('message', (m) => void got.push(m));
  return { fake, clock, now, sms, got };
}

/** A fresh Poller over the same store, like a restarted process. */
function newPoller(sms: GoToSms, now: () => number, logger = silent) {
  const { http, config, processor, store, tenant } = sms.core;
  return new Poller({ http, config, processor, store, tenant, intervalMs: 30_000, now, logger });
}

const conversationQueries = (fake: FakeGoTo) =>
  fake.requests
    .filter((r) => r.method === 'GET' && r.path.startsWith('/messaging/v1/conversations'))
    .map((r) => new URL(r.path, 'http://x').searchParams);

test('C19 polling dedupes across ticks', async () => {
  const { fake, sms, got } = await setup();
  fake.inbound.push({
    id: 'g-1',
    from: PEER,
    to: FROM,
    body: 'hi',
    timestamp: '2026-10-27T10:00:01Z',
  });
  assert.equal(await sms.core.poller.tick(), 1);
  // Same message still inside the overlap window, plus a new one.
  fake.inbound.push({
    id: 'g-2',
    from: PEER,
    to: FROM,
    body: 'again',
    timestamp: '2026-10-27T10:00:02Z',
  });
  assert.equal(await sms.core.poller.tick(), 1);
  assert.equal(await sms.core.poller.tick(), 0);
  assert.deepEqual(
    got.map((m) => m.id),
    ['g-1', 'g-2'],
  );
  assert.equal(got[0]!.text, 'hi');
  assert.equal(got[0]!.from, PEER);
  assert.equal(got[0]!.to, FROM);
});

test('C19 mixed µs/ms timestamps ordered by Date.parse', async () => {
  const { fake, sms, got } = await setup();
  // The fake serves messages newest first; the poller must order them itself.
  fake.inbound.push(
    { id: 'micro', from: PEER, to: FROM, body: 'first', timestamp: '2026-10-27T10:00:00.123456Z' },
    { id: 'milli', from: PEER, to: FROM, body: 'second', timestamp: '2026-10-27T10:00:00.2Z' },
  );
  assert.equal(await sms.core.poller.tick(), 2);
  assert.deepEqual(
    got.map((m) => m.id),
    ['micro', 'milli'],
  );
  assert.equal(
    await sms.core.store.get(sms.core.tenant, 'poll:cursor'),
    '2026-10-27T10:00:00.200Z',
  );
});

test('cursor survives restart', async () => {
  const { fake, clock, now, sms, got } = await setup();
  fake.inbound.push({
    id: 'g-1',
    from: PEER,
    to: FROM,
    body: 'hi',
    timestamp: '2026-10-27T10:00:05Z',
  });
  await sms.core.poller.tick();
  const cursor = await sms.core.store.get(sms.core.tenant, 'poll:cursor');
  assert.equal(cursor, '2026-10-27T10:00:05.000Z');

  // An hour later a new process starts: it polls from the stored cursor (minus the
  // overlap), not from its own clock, so nothing sent while it was down is missed.
  clock.t = T0 + 3_600_000;
  fake.inbound.push({
    id: 'g-2',
    from: PEER,
    to: FROM,
    body: 'while down',
    timestamp: '2026-10-27T10:30:00Z',
  });
  fake.requests.length = 0;
  assert.equal(await newPoller(sms, now).tick(), 1);
  assert.equal(conversationQueries(fake)[0]!.get('oldestTimestamp'), '2026-10-27T09:55:05.000Z');
  assert.deepEqual(
    got.map((m) => m.id),
    ['g-1', 'g-2'],
  );
});

test('poller skips an invalid inbound and keeps going', async () => {
  const { fake, sms, got } = await setup();
  const rec = recorder();
  fake.inbound.push(
    { id: 'empty', from: PEER, to: FROM, body: '', timestamp: '2026-10-27T10:00:01Z' },
    { id: 'ok', from: PEER, to: FROM, body: 'fine', timestamp: '2026-10-27T10:00:02Z' },
  );
  assert.equal(await newPoller(sms, () => T0, rec.logger).tick(), 1);
  assert.deepEqual(
    got.map((m) => m.id),
    ['ok'],
  );
  assert.ok(rec.lines.some((l) => l.level === 'warn' && /skipped/.test(l.m)));
  assert.equal(
    await sms.core.store.get(sms.core.tenant, 'poll:cursor'),
    '2026-10-27T10:00:02.000Z',
  );
});

test('poller retries a pending row whose processing failed', async () => {
  const { fake, sms, got } = await setup();
  const { optOuts } = sms.core;
  const add = optOuts.add.bind(optOuts);
  let fail = true;
  optOuts.add = async (n, s) => {
    if (fail) throw new Error('disk full');
    return add(n, s);
  };
  fake.inbound.push({
    id: 'g-1',
    from: PEER,
    to: FROM,
    body: 'STOP',
    timestamp: '2026-10-27T10:00:01Z',
  });
  await sms.core.poller.tick();
  assert.equal(got.length, 0);
  fail = false;
  await sms.core.poller.tick();
  assert.equal(got.length, 1);
  assert.equal(await optOuts.has(PEER), true);
});

test('poller without a from number does nothing', async () => {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  const sms = await connectedSms(fake, { now: () => T0, connect: false });
  cleanups.push(() => sms.close());
  assert.equal(await sms.core.poller.tick(), 0);
  assert.equal(fake.requests.length, 0);
});

test('cursor follows our own sends too, so the poll window stays short', async () => {
  const { fake, sms, got } = await setup();
  fake.inbound.push(
    { id: 'in', from: PEER, to: FROM, body: 'hi', timestamp: '2026-10-27T10:00:01Z' },
    {
      id: 'out',
      from: PEER,
      to: FROM,
      body: 'reply',
      timestamp: '2026-10-27T10:20:00Z',
      direction: 'OUT',
    },
  );
  assert.equal(await sms.core.poller.tick(), 1);
  assert.deepEqual(
    got.map((m) => m.id),
    ['in'],
  );
  assert.equal(
    await sms.core.store.get(sms.core.tenant, 'poll:cursor'),
    '2026-10-27T10:20:00.000Z',
  );
  fake.requests.length = 0;
  await sms.core.poller.tick();
  assert.equal(conversationQueries(fake)[0]!.get('oldestTimestamp'), '2026-10-27T10:15:00.000Z');
});

test('poller follows nextPageMarker: a STOP only on page 2 of conversations is handled', async () => {
  const { fake, sms, got } = await setup();
  fake.pollPageSize = 2;
  // Three contacts, so the conversations list spans two pages; the STOP is on the last one.
  const peers = ['+18015550201', '+18015550202', PEER];
  peers.forEach((from, i) =>
    fake.inbound.push({
      id: `g-${i}`,
      from,
      to: FROM,
      body: from === PEER ? 'STOP' : 'hi',
      timestamp: `2026-10-27T10:00:0${i + 1}Z`,
    }),
  );
  // And two messages from PEER, so its message list pages too.
  fake.inbound.push(
    { id: 'g-a', from: PEER, to: FROM, body: 'one', timestamp: '2026-10-27T10:00:04Z' },
    { id: 'g-b', from: PEER, to: FROM, body: 'two', timestamp: '2026-10-27T10:00:05Z' },
  );
  assert.equal(await sms.core.poller.tick(), 5);
  assert.deepEqual(got.map((m) => m.id).sort(), ['g-0', 'g-1', 'g-2', 'g-a', 'g-b']);
  assert.equal(await sms.core.optOuts.has(PEER), true);
  const markers = conversationQueries(fake).map((q) => q.get('pageMarker'));
  assert.deepEqual(markers, [null, '2']);
});

test('poller keeps the cursor when paging loops', async () => {
  const { fake, sms } = await setup();
  const rec = recorder();
  fake.inbound.push({
    id: 'g-1',
    from: PEER,
    to: FROM,
    body: 'hi',
    timestamp: '2026-10-27T10:00:01Z',
  });
  // A marker that repeats: the poller stops paging and must not advance the cursor.
  const loop = {
    items: [{ contactPhoneNumbers: [PEER], lastMessageTimestamp: '2026-10-27T10:00:01Z' }],
    nextPageMarker: 'same',
  };
  fake.failNext('GET', '/messaging/v1/conversations', 200, loop);
  fake.failNext('GET', '/messaging/v1/conversations', 200, loop);
  assert.equal(await newPoller(sms, () => T0, rec.logger).tick(), 1);
  assert.equal(await sms.core.store.get(sms.core.tenant, 'poll:cursor'), undefined);
  assert.ok(rec.lines.some((l) => l.level === 'warn' && /paging/.test(l.m)));
});
