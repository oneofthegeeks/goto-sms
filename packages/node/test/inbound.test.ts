import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoToAuth } from '../src/oauth.js';
import { createGoToHttp } from '../src/http.js';
import { ConfigResolver } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { FileStore } from '../src/store/file.js';
import { SecretBox } from '../src/secrets.js';
import { OptOuts } from '../src/optouts.js';
import { MessageLog } from '../src/log.js';
import { Sender } from '../src/send.js';
import { DEFAULT_REPLIES, detectKeyword } from '../src/inbound/keywords.js';
import { InboundProcessor } from '../src/inbound/processor.js';
import type { GoToSmsStore, Json } from '../src/store/types.js';
import type { InboundMessage, Logger } from '../src/types.js';
import { startFakeGoTo, type FakeGoTo } from './helpers/fake-goto.js';

const T = 't1';
const FROM = '+18015550100'; // our sending number
const PEER = '+18015550123'; // the person texting in
const HOUR = 3_600_000;
const DAY = 86_400_000;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const ENV = { GOTO_CLIENT_ID: 'cid', GOTO_CLIENT_SECRET: 'csecret', GOTO_FROM_NUMBER: FROM };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(
  o: {
    fake?: FakeGoTo;
    box?: SecretBox;
    store?: GoToSmsStore;
    clock?: { t: number };
    emit?: (m: InboundMessage) => void;
    connect?: boolean;
  } = {},
) {
  let fake = o.fake;
  if (!fake) {
    const f = await startFakeGoTo();
    cleanups.push(() => f.close());
    fake = f;
  }
  const clock = o.clock ?? { t: 1_000_000_000_000 };
  const now = () => clock.t;
  const store = o.store ?? new MemoryStore(now);
  const box = o.box ?? new SecretBox(randomBytes(32));
  const config = new ConfigResolver({ store, tenant: T, box, options: {}, env: { ...ENV } });
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
  const sender = new Sender({
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
    env: { ...ENV },
    logger: silent,
  });
  if (o.connect ?? true) {
    const state = new URL(await auth.startConnect()).searchParams.get('state')!;
    await auth.finishConnect('code-ok', state);
  }
  const emitted: InboundMessage[] = [];
  const proc = new InboundProcessor({
    store,
    tenant: T,
    sender,
    optOuts,
    log,
    emit: o.emit ?? ((m) => void emitted.push(m)),
    replies: { ...DEFAULT_REPLIES },
    yesIsOptIn: true,
    perHour: 10,
    now,
    logger: silent,
  });
  let n = 0;
  const msg = (text: string, over: Partial<InboundMessage> = {}) => ({
    id: `g-${++n}`,
    from: PEER,
    to: FROM,
    text,
    receivedAt: new Date(clock.t).toISOString(),
    raw: { goto: 'payload', text },
    ...over,
  });
  /** persist + process, the normal path. */
  const receive = async (text: string, over: Partial<InboundMessage> = {}) => {
    const m = msg(text, over);
    assert.equal(await proc.persist(m), true);
    await proc.process(m.id);
    return m;
  };
  const repliesTo = (body: string) =>
    fake.sent.filter((s) => s.contactPhoneNumbers[0] === PEER && s.body === body);
  const inboundLog = async () => (await log.list(500)).filter((e) => e.direction === 'inbound');
  return {
    fake,
    clock,
    store,
    box,
    optOuts,
    log,
    sender,
    proc,
    emitted,
    msg,
    receive,
    repliesTo,
    inboundLog,
  };
}

// --- detectKeyword (Review Focus 2) ---

test('detectKeyword: punctuation and padding still match STOP', () => {
  for (const t of ['Stop.', ' stop ', 'STOP!', 'stop?!', 'Quit,', 'unsubscribe']) {
    assert.equal(detectKeyword(t, { yesIsOptIn: true }), 'STOP', t);
  }
});

test('detectKeyword: only a whole-message match counts', () => {
  for (const t of ['Unsubscribe please', 'please stop', 'stop it', 'STOP STOP', '', '.']) {
    assert.equal(detectKeyword(t, { yesIsOptIn: true }), undefined, t);
  }
});

test('detectKeyword: START, HELP and YES only when yesIsOptIn', () => {
  assert.equal(detectKeyword('unstop', { yesIsOptIn: false }), 'START');
  assert.equal(detectKeyword('Start!', { yesIsOptIn: false }), 'START');
  assert.equal(detectKeyword('info', { yesIsOptIn: false }), 'HELP');
  assert.equal(detectKeyword('Help?', { yesIsOptIn: false }), 'HELP');
  assert.equal(detectKeyword('yes', { yesIsOptIn: true }), 'START');
  assert.equal(detectKeyword('yes', { yesIsOptIn: false }), undefined);
});

// --- keywords ---

test('C20 STOP adds opt-out, sends exactly one confirmation even though now opted out, emits with keyword', async () => {
  const s = await setup();
  const m = await s.receive('Stop.');
  assert.equal(await s.optOuts.has(PEER), true);
  assert.equal((await s.optOuts.list())[0]?.source, 'keyword');
  assert.equal(s.repliesTo(DEFAULT_REPLIES.stop).length, 1);
  assert.equal(s.fake.sent.length, 1);
  assert.equal(s.emitted.length, 1);
  assert.equal(s.emitted[0]?.keyword, 'STOP');
  assert.equal(s.emitted[0]?.text, 'Stop.');
  assert.deepEqual(s.emitted[0]?.raw, m.raw);

  // Processing the same id again is a no-op: no second confirmation, no second emit.
  await s.proc.process(m.id);
  assert.equal(await s.proc.persist(m), false);
  assert.equal(s.fake.sent.length, 1);
  assert.equal(s.emitted.length, 1);

  // A regular send to the now opted-out number is refused.
  assert.equal((await s.sender.send(PEER, 'promo')).status, 'opted_out');
});

test('STOP replayed after a crash past the reply sends no second confirmation', async () => {
  // Fail the "seen" write once: the reply has gone out but the message stays pending.
  class FlakyStore extends MemoryStore {
    failSeen = true;
    override async set(tenant: string, key: string, value: Json): Promise<void> {
      if (this.failSeen && key.startsWith('inbound:seen:')) {
        this.failSeen = false;
        throw new Error('disk full');
      }
      return super.set(tenant, key, value);
    }
  }
  const clock = { t: 1_000_000_000_000 };
  const s = await setup({ clock, store: new FlakyStore(() => clock.t) });
  const m = s.msg('STOP');
  await s.proc.persist(m);
  await assert.rejects(s.proc.process(m.id), /disk full/);
  assert.equal(await s.optOuts.has(PEER), true);

  assert.equal(await s.proc.replayPending(), 1);
  assert.equal(s.repliesTo(DEFAULT_REPLIES.stop).length, 1);
  assert.equal(await s.proc.persist(m), false);
});

test('C20 START removes', async () => {
  const s = await setup();
  await s.optOuts.add(PEER, 'keyword');
  await s.receive('start');
  assert.equal(await s.optOuts.has(PEER), false);
  assert.equal(s.repliesTo(DEFAULT_REPLIES.start).length, 1);
  assert.equal(s.emitted[0]?.keyword, 'START');
});

test('C20 HELP replies with configured text', async () => {
  const s = await setup();
  await s.optOuts.add(PEER, 'admin');
  const help = 'Acme Clinic: reply STOP to opt out. Call 801-555-0199.';
  const proc = new InboundProcessor({
    store: s.store,
    tenant: T,
    sender: s.sender,
    optOuts: s.optOuts,
    log: s.log,
    emit: (m) => void s.emitted.push(m),
    replies: { ...DEFAULT_REPLIES, help },
    yesIsOptIn: true,
    perHour: 10,
    now: () => s.clock.t,
    logger: silent,
  });
  const m = s.msg('help');
  await proc.persist(m);
  await proc.process(m.id);
  // Answered even though the number opted out; HELP doesn't change the opt-out.
  assert.equal(s.repliesTo(help).length, 1);
  assert.equal(await s.optOuts.has(PEER), true);
  assert.equal(s.emitted[0]?.keyword, 'HELP');
});

test('plain text: no reply, emitted without keyword, logged without body', async () => {
  const s = await setup();
  await s.receive('Is my appointment still on?');
  assert.equal(s.fake.sent.length, 0);
  assert.equal(s.emitted.length, 1);
  assert.equal('keyword' in s.emitted[0]!, false);
  const entries = await s.inboundLog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.status, 'received');
  assert.equal(entries[0]?.gotoId, 'g-1');
  assert.equal(entries[0]?.from, PEER);
  assert.equal(JSON.stringify(entries).includes('appointment'), false);
});

// --- rate limit (C21) ---

test('C21 11th text in an hour is logged and not emitted', async () => {
  const s = await setup();
  for (let i = 0; i < 11; i++) await s.receive(`hello ${i}`);
  assert.equal(s.emitted.length, 10);
  const statuses = (await s.inboundLog()).map((e) => e.status);
  assert.equal(statuses.filter((x) => x === 'received').length, 10);
  assert.equal(statuses.filter((x) => x === 'rate_limited').length, 1);
  // The limited message is finished, not left pending.
  assert.equal(await s.proc.replayPending(), 0);

  // The next hour starts a fresh bucket.
  s.clock.t += HOUR;
  await s.receive('new hour');
  assert.equal(s.emitted.length, 11);
});

test('STOP as 12th text in the hour still opts out', async () => {
  const s = await setup();
  for (let i = 0; i < 11; i++) await s.receive(`spam ${i}`);
  await s.receive('STOP');
  assert.equal(await s.optOuts.has(PEER), true);
  assert.equal(s.repliesTo(DEFAULT_REPLIES.stop).length, 1);
  assert.equal(s.emitted.length, 10);
  assert.equal(
    s.emitted.some((m) => m.keyword === 'STOP'),
    false,
  );
});

test('rate limit is per number', async () => {
  const s = await setup();
  for (let i = 0; i < 11; i++) await s.receive(`a ${i}`);
  await s.receive('other person', { from: '+18015550124' });
  assert.equal(s.emitted.length, 11);
  assert.equal(s.emitted.at(-1)?.from, '+18015550124');
});

// --- durability and dedupe ---

test('pending inbound replayed after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goto-inbound-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.json');
  const box = new SecretBox(randomBytes(32));
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());

  const A = await setup({ fake, box, store: new FileStore({ path }) });
  const m = A.msg('STOP');
  assert.equal(await A.proc.persist(m), true);
  // "Crash" before process(): nothing emitted, no opt-out yet.
  assert.equal(A.emitted.length, 0);

  const B = await setup({ fake, box, store: new FileStore({ path }), connect: false });
  assert.equal(await B.proc.replayPending(), 1);
  assert.equal(B.emitted.length, 1);
  assert.equal(B.emitted[0]?.id, m.id);
  assert.equal(B.emitted[0]?.keyword, 'STOP');
  assert.equal(await B.optOuts.has(PEER), true);
  assert.equal(B.repliesTo(DEFAULT_REPLIES.stop).length, 1);

  // Nothing left: a second replay (or a third process) emits nothing more.
  assert.equal(await B.proc.replayPending(), 0);
  const C = await setup({ fake, box, store: new FileStore({ path }), connect: false });
  assert.equal(await C.proc.replayPending(), 0);
  assert.equal(await C.proc.persist(m), false);
  assert.equal(B.emitted.length + C.emitted.length, 1);
});

test('replay applies pending keywords in arrival order, not id order', async () => {
  const s = await setup();
  // 'g-10' sorts before 'g-2' by key, but the STOP arrived last and must win.
  await s.proc.persist(
    s.msg('START', { id: 'g-2', receivedAt: new Date(s.clock.t).toISOString() }),
  );
  await s.proc.persist(
    s.msg('STOP', { id: 'g-10', receivedAt: new Date(s.clock.t + 1000).toISOString() }),
  );
  assert.equal(await s.proc.replayPending(), 2);
  assert.equal(await s.optOuts.has(PEER), true);
  assert.deepEqual(
    s.emitted.map((m) => m.id),
    ['g-2', 'g-10'],
  );
});

test('duplicate GoTo id emitted once', async () => {
  const s = await setup();
  const m = s.msg('hi');
  assert.equal(await s.proc.persist(m), true);
  assert.equal(await s.proc.persist(m), false); // still pending
  await Promise.all([s.proc.process(m.id), s.proc.process(m.id)]);
  assert.equal(await s.proc.persist(m), false); // already seen
  await s.proc.process(m.id);
  assert.equal(s.emitted.length, 1);
  assert.equal((await s.inboundLog()).length, 1);
});

test('concurrent duplicate STOP sends one confirmation', async () => {
  const s = await setup();
  const m = s.msg('STOP');
  await s.proc.persist(m);
  await Promise.all([s.proc.process(m.id), s.proc.process(m.id)]);
  assert.equal(s.repliesTo(DEFAULT_REPLIES.stop).length, 1);
});

test("handler that throws doesn't stop processing", async () => {
  let calls = 0;
  const seen: string[] = [];
  const s = await setup({
    emit: (m) => {
      calls++;
      if (calls === 1) throw new Error('handler bug');
      seen.push(m.id);
    },
  });
  const first = await s.receive('first');
  // The throwing message is finished: marked seen, nothing pending.
  assert.equal(await s.proc.persist(first), false);
  assert.equal(await s.proc.replayPending(), 0);
  const second = await s.receive('second');
  assert.deepEqual(seen, [second.id]);
});

test('a failed reply does not block the opt-out or the emit', async () => {
  const s = await setup({ connect: false }); // not connected: the reply can't be sent
  await s.receive('STOP');
  assert.equal(await s.optOuts.has(PEER), true);
  assert.equal(s.fake.sent.length, 0);
  assert.equal(s.emitted[0]?.keyword, 'STOP');
});

// --- prune ---

test('prune drops old rate buckets and expired seen ids', async () => {
  const s = await setup();
  await s.receive('old');
  s.clock.t += 91 * DAY;
  await s.receive('new');
  await s.proc.prune();
  const keys = [
    ...(await s.store.list(T, 'rate:')),
    ...(await s.store.list(T, 'inbound:seen:')),
  ].map((e) => e.key);
  const bucket = Math.floor(s.clock.t / HOUR);
  assert.deepEqual(keys.sort(), [`inbound:seen:g-2`, `rate:${PEER}:${bucket}`].sort());
});
