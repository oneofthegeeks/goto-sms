// Calls to the sending number as events: on('call'), CallWatcher, status. A port of
// aiogotoconnect's tests/sms/test_calls.py, test for test.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGoToSms, type GoToSms, type GoToSmsOptions } from '../src/client.js';
import { buildStatus } from '../src/server/status.js';
import { MemoryStore } from '../src/store/memory.js';
import type { InboundCall, Logger } from '../src/types.js';
import { CallWatcher, REPORTS, SUMMARIES } from '../src/inbound/calls.js';
import { startFakeGoTo, type FakeCall, type FakeGoTo } from './helpers/fake-goto.js';
import { connectedSms, FROM, PEER, recorder, silent } from './helpers/sms.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A started client with no GoTo behind it: nothing is configured, so nothing is requested. */
async function bare(o: Partial<GoToSmsOptions> = {}, logger: Logger = silent): Promise<GoToSms> {
  const sms = createGoToSms({
    encryptionKey: 'test-key',
    publicUrl: 'https://app.example',
    env: {},
    store: new MemoryStore(),
    logger,
    ...o,
  });
  cleanups.push(() => sms.close());
  await sms.ready;
  return sms;
}

function aCall(over: Partial<InboundCall> = {}): InboundCall {
  return {
    id: 'c1',
    from: PEER,
    to: FROM,
    at: '2026-10-27T10:00:00.000Z',
    outcome: 'MISSED',
    raw: {},
    callerName: 'Pat Example',
    ...over,
  };
}

/** Lines at info or above, as one string each (message plus its details). */
const loud = (lines: Array<{ level: string; m: string; x?: object }>): string[] =>
  lines.filter((l) => l.level !== 'debug').map((l) => l.m + ' ' + JSON.stringify(l.x ?? {}));

// --- The event type, the options and on('call') ---

test('on call registers and emits in order', async () => {
  const sms = await bare({ watchCalls: true });
  const got: Array<[string, InboundCall]> = [];
  const first = (c: InboundCall): void => void got.push(['sync', c]);
  const second = async (c: InboundCall): Promise<void> => {
    await Promise.resolve();
    got.push(['async', c]);
  };
  assert.equal(sms.on('call', first).on('call', second), sms);
  const call = aCall();
  await sms.core.emitCall(call);
  assert.deepEqual(got, [
    ['sync', call],
    ['async', call],
  ]);
});

test('call handlers are awaited one at a time', async () => {
  const sms = await bare({ watchCalls: true });
  const order: string[] = [];
  sms.on('call', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('slow');
  });
  sms.on('call', () => void order.push('next'));
  await sms.core.emitCall(aCall());
  assert.deepEqual(order, ['slow', 'next']);
});

test('call handler exception does not stop the next', async () => {
  const { logger, lines } = recorder();
  const sms = await bare({ watchCalls: true }, logger);
  const got: InboundCall[] = [];
  sms
    .on('call', (c) => {
      throw new Error(`failed for ${c.from} ${String(c.callerName)}`);
    })
    .on('call', async (c) => {
      await Promise.resolve();
      throw new Error(`rejected for ${c.from} ${String(c.callerName)}`);
    })
    .on('call', (c) => void got.push(c));
  await sms.core.emitCall(aCall());
  assert.equal(got.length, 1);
  const said = loud(lines);
  assert.equal(said.length, 2);
  for (const line of said) {
    assert.equal(line.includes(PEER), false);
    assert.equal(line.includes('Pat Example'), false);
  }
});

test('message handlers do not get calls', async () => {
  const sms = await bare({ watchCalls: true });
  const got: unknown[] = [];
  sms.on('message', (m) => void got.push(m));
  await sms.core.emitCall(aCall());
  assert.deepEqual(got, []);
});

test('unknown event still throws', async () => {
  const sms = await bare();
  const on = sms.on.bind(sms) as (ev: string, fn: () => void) => GoToSms;
  const off = sms.off.bind(sms) as (ev: string, fn: () => void) => GoToSms;
  assert.throws(() => on('ring', () => {}), /'message'.*'call'/);
  assert.throws(() => off('ring', () => {}), /'message'.*'call'/);
});

test('on call without watchCalls warns once', async () => {
  const { logger, lines } = recorder();
  const sms = await bare({}, logger);
  sms.on('call', () => {});
  sms.on('call', () => {});
  const warnings = lines.filter((l) => l.level === 'warn').map((l) => l.m);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes('watchCalls: true'));
});

test('on call with watchCalls does not warn', async () => {
  const { logger, lines } = recorder();
  const sms = await bare({ watchCalls: true }, logger);
  sms.on('call', () => {});
  assert.deepEqual(
    lines.filter((l) => l.level === 'warn' || l.level === 'error'),
    [],
  );
});

test('off call removes the handler', async () => {
  const sms = await bare({ watchCalls: true });
  const got: InboundCall[] = [];
  const handler = (c: InboundCall): void => void got.push(c);
  sms.on('call', handler);
  sms.off('call', handler);
  await sms.core.emitCall(aCall());
  assert.deepEqual(got, []);
});

test('call poll interval option is resolved in milliseconds', async () => {
  const off = await bare();
  assert.equal(off.core.options.watchCalls, false);
  assert.equal(off.core.options.callPollIntervalMs, 120_000);
  const on = await bare({ watchCalls: true, callPollIntervalMs: 45_000 });
  assert.equal(on.core.options.watchCalls, true);
  assert.equal(on.core.options.callPollIntervalMs, 45_000);
});

// --- CallWatcher: one look at the call reports ---

const OTHER_LINE = '+18015550177';
const T0 = Date.parse('2026-10-27T10:00:00Z');
const MIN = 60_000;
const iso = (t: number): string => new Date(t).toISOString();

/**
 * A connected client (call watching off) on a fake GoTo, and a CallWatcher over its core
 * driven by hand, with a clock the test moves.
 */
async function rig(o: { accountKey?: boolean; logger?: Logger } = {}) {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  const clock = { t: T0 };
  const now = () => clock.t;
  const sms = await connectedSms(fake, {
    now,
    env: o.accountKey === false ? {} : { GOTO_ACCOUNT_KEY: 'acct-1' },
  });
  cleanups.push(() => sms.close());
  const { core } = sms;
  const got: InboundCall[] = [];
  const state = { emitThrows: false, listening: true };
  /** A fresh watcher over the same store, like a restarted process. */
  const newWatcher = (): CallWatcher =>
    new CallWatcher({
      http: core.http,
      config: core.config,
      store: core.store,
      tenant: core.tenant,
      emit: async (call) => {
        got.push(call);
        if (state.emitThrows) throw new Error('handler layer failed');
      },
      intervalMs: 120_000,
      hasListeners: () => state.listening,
      now,
      logger: o.logger ?? silent,
    });
  const watcher = newWatcher();
  fake.requests.length = 0;
  const self = {
    fake,
    clock,
    sms,
    store: core.store,
    tenant: core.tenant,
    got,
    state,
    watcher,
    newWatcher,
    /** Adds a call to the fake: inbound, missed, from PEER to our number, at clock - minutesAgo. */
    call(id: string, minutesAgo = 0, over: Partial<FakeCall> = {}): FakeCall {
      const c: FakeCall = {
        id,
        created: iso(clock.t - minutesAgo * MIN),
        dialled: FROM,
        callerNumber: PEER,
        callerName: 'Pat Example',
        ...over,
      };
      fake.calls.push(c);
      return c;
    },
    /** The first look only sets the cursor; move two minutes on, as the loop would. */
    async started() {
      assert.equal(await watcher.tick(), 0);
      clock.t += 2 * MIN;
      return self;
    },
    async look(minutesLater = 2): Promise<number> {
      const n = await watcher.tick();
      clock.t += minutesLater * MIN;
      return n;
    },
    summaries: (): URLSearchParams[] =>
      fake.callReportHits
        .filter((h) => h.startsWith(SUMMARIES))
        .map((h) => new URL(h, 'http://x').searchParams),
    reportFetches: (): number => fake.callReportHits.filter((h) => h.startsWith(REPORTS)).length,
    ids: (): string[] => got.map((c) => c.id),
    get: (key: string) => core.store.get(core.tenant, key),
  };
  return self;
}
const startedRig = async (o: Parameters<typeof rig>[0] = {}) => (await rig(o)).started();

test('first tick imports nothing', async () => {
  const r = await rig();
  r.call('old', 1);
  assert.equal(await r.watcher.tick(), 0);
  assert.deepEqual(r.got, []);
  assert.equal(await r.get('calls:cursor'), iso(T0));
  assert.equal(await r.get('calls:since'), iso(T0));
});

test('C27 an inbound call to the sending number is delivered once', async () => {
  const r = await startedRig();
  const created = r.call('c1', 1, { ended: iso(r.clock.t) }).created;
  assert.equal(await r.look(), 1);
  const call = r.got[0]!;
  assert.deepEqual([call.id, call.from, call.to, call.outcome], ['c1', PEER, FROM, 'MISSED']);
  assert.equal(call.callerName, 'Pat Example');
  assert.equal(call.at, created);
  assert.notEqual(call.endedAt, undefined);
  assert.equal((call.raw as { conversationSpaceId: string }).conversationSpaceId, 'c1');
  for (let i = 0; i < 3; i++) assert.equal(await r.look(), 0);
  assert.deepEqual(r.ids(), ['c1']);
  // The summary named the dialled number, so the full report was never needed.
  assert.equal(r.reportFetches(), 0);
});

test('summaries are asked for the account with a two hour reach back', async () => {
  const r = await startedRig();
  await r.look();
  const q = r.summaries().at(-1)!;
  assert.equal(q.get('accountKey'), 'acct-1');
  assert.equal(q.get('startTime'), '2026-10-27T08:00:00Z'); // cursor (10:00) - 2 h
  assert.equal(q.get('endTime'), '2026-10-27T10:02:00Z');
  assert.equal(q.get('pageSize'), '100');
});

test('C27 a call to another number on the account is not delivered', async () => {
  const r = await startedRig();
  r.call('c1', 1, { dialled: OTHER_LINE });
  assert.equal(await r.look(), 0);
  assert.deepEqual(r.got, []);
});

test('C27 an outbound call is not delivered', async () => {
  const r = await startedRig();
  r.call('c1', 1, { direction: 'OUTBOUND', summaryHasDialled: false });
  assert.equal(await r.look(), 0);
  assert.deepEqual(r.got, []);
  assert.equal(r.reportFetches(), 0);
  // Not in the Python suite: the direction decides even when the rest looks like ours.
  r.fake.callSummariesRaw = [
    {
      conversationSpaceId: 'out-2',
      direction: 'OUTBOUND',
      callCreated: iso(r.clock.t - MIN),
      caller: { number: PEER, type: { value: 'PHONE_NUMBER', number: FROM } },
    },
  ];
  assert.equal(await r.look(), 0);
  assert.deepEqual(r.got, []);
});

test('C29 double ring in one tick is one event', async () => {
  const r = await startedRig();
  r.call('c1', 1);
  r.call('c2', 0.9);
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['c1']);
});

test('C29 double ring across two ticks is one event', async () => {
  const r = await startedRig();
  r.call('c1', 0.5);
  assert.equal(await r.look(0.5), 1);
  r.call('c2', 0); // 60 s after c1
  assert.equal(await r.look(), 0);
  assert.equal(await r.newWatcher().tick(), 0); // nor after a restart
  assert.deepEqual(r.ids(), ['c1']);
});

test('C29 the same caller three minutes later is a second event', async () => {
  const r = await startedRig();
  r.call('c1', 1);
  assert.equal(await r.look(), 1);
  r.call('c2', 0); // 3 min after c1
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['c1', 'c2']);
});

test('a ring on another line does not hide the call to ours', async () => {
  const r = await startedRig();
  r.call('other', 1, { dialled: OTHER_LINE });
  r.call('ours', 0.5);
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['ours']);
});

test('withheld number is delivered with empty from', async () => {
  const r = await startedRig();
  r.call('c1', 1, { callerNumber: null, callerName: null });
  assert.equal(await r.look(), 1);
  assert.equal(r.got[0]!.from, '');
  assert.equal(r.got[0]!.callerName, undefined);
  assert.equal('callerName' in r.got[0]!, false);
});

test('C29 two withheld callers a minute apart both deliver', async () => {
  const r = await startedRig();
  r.call('c1', 1.5, { callerNumber: null });
  r.call('c2', 0.5, { callerNumber: null });
  assert.equal(await r.look(), 2);
  assert.deepEqual(r.ids(), ['c1', 'c2']);
});

test('C28 a call that started before watching was switched on is not delivered', async () => {
  const r = await rig();
  assert.equal(await r.watcher.tick(), 0); // since = T0
  r.fake.calls.push({ id: 'early', created: iso(T0 - 5 * MIN), dialled: FROM, callerNumber: PEER });
  r.clock.t += 2 * MIN;
  assert.equal(await r.look(), 0);
  assert.equal(await r.look(), 0);
  assert.deepEqual(r.got, []);
});

test('missing dialled number in the summary falls back to the report', async () => {
  const r = await startedRig();
  r.call('c1', 1, { summaryHasDialled: false });
  r.call('c2', 0.5, { summaryHasDialled: false, dialled: OTHER_LINE });
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['c1']);
  // The report, since it had to be read.
  assert.ok((r.got[0]!.raw as { participants: unknown[] }).participants.length > 0);
  assert.equal(r.reportFetches(), 2);
});

test('failed report fetch is retried next tick', async () => {
  const r = await startedRig();
  r.call('c1', 1, { summaryHasDialled: false });
  r.fake.failNext('GET', REPORTS, 500);
  assert.equal(await r.look(), 0);
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['c1']);
});

test('caller name is collapsed and cut', async () => {
  const r = await startedRig();
  r.call('c1', 1, { callerName: '  Evil \n  Name ' + 'x'.repeat(60) });
  await r.look();
  const name = r.got[0]!.callerName;
  assert.ok(name !== undefined);
  assert.ok(name.startsWith('Evil Name x'));
  assert.equal(name.length, 40);
});

test('unnormalisable caller number is cut to 20', async () => {
  const r = await startedRig();
  const text = 'anonymous@' + '9'.repeat(40);
  r.call('c1', 1, { callerNumber: text });
  await r.look();
  assert.equal(r.got[0]!.from, text.slice(0, 20));
});

test('loosely formatted caller number is normalised', async () => {
  const r = await startedRig();
  r.call('c1', 1, { callerNumber: '(801) 555-0123', dialled: '18015550100' });
  await r.look();
  assert.deepEqual([r.got[0]!.from, r.got[0]!.to], [PEER, FROM]);
});

test('handler error in emit does not redeliver', async () => {
  const r = await startedRig();
  r.state.emitThrows = true;
  r.call('c1', 1);
  r.call('c2', 0.5, { callerNumber: '+18015550144' });
  assert.equal(await r.look(), 2);
  assert.equal(await r.look(), 0);
  assert.deepEqual(r.ids(), ['c1', 'c2']);
});

test('transferred call with two phone participants is delivered once', async () => {
  const r = await startedRig();
  const elsewhere = {
    type: {
      value: 'PHONE_NUMBER',
      number: OTHER_LINE,
      caller: { name: 'Someone Else', number: '+18015550155' },
    },
  };
  r.call('c1', 1, { summaryHasDialled: false, extraParticipants: [elsewhere] });
  assert.equal(await r.look(), 1);
  assert.equal(await r.look(), 0);
  assert.deepEqual([r.got[0]!.from, r.got[0]!.to], [PEER, FROM]);
});

test('odd shapes never throw and the cursor advances', async () => {
  const r = await startedRig();
  r.fake.callSummariesRaw = [
    null,
    'text',
    { direction: 'INBOUND' }, // no id
    { conversationSpaceId: 'odd-1', direction: 'INBOUND', caller: 'nope' },
    {
      conversationSpaceId: 'odd-2',
      direction: 'INBOUND',
      callCreated: 'nope',
      caller: { number: PEER, type: { value: 'PHONE_NUMBER', number: FROM } },
    },
  ];
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['odd-2']);
  assert.equal(r.got[0]!.at, iso(T0 + 2 * MIN)); // unparseable start time: now
  assert.equal(r.got[0]!.outcome, '');
  assert.equal(await r.get('calls:cursor'), iso(T0 + 2 * MIN));
  // An answer with no items at all is an empty look, not an error.
  r.fake.failNext('GET', SUMMARIES, 200, {});
  assert.equal(await r.look(), 0);
  assert.equal(await r.get('calls:cursor'), iso(T0 + 4 * MIN));
});

test('many calls to other lines do not evict recent seen', async () => {
  const r = await startedRig();
  for (let i = 0; i < 450; i++) r.call(`o${i}`, 1, { dialled: OTHER_LINE, callerNumber: null });
  r.call('ours', 1.5);
  assert.equal(await r.look(), 1);
  assert.equal(await r.look(), 0);
  assert.equal(await r.look(), 0);
  assert.deepEqual(r.ids(), ['ours']);
});

test('old seen entries are dropped down to the cap', async () => {
  const r = await startedRig();
  for (let i = 0; i < 450; i++) r.call(`o${i}`, 1, { dialled: OTHER_LINE });
  await r.look();
  let seen = await r.get('calls:seen');
  assert.ok(Array.isArray(seen) && seen.length === 450);
  r.clock.t += 180 * MIN; // all of them are now older than the reach-back
  await r.look();
  seen = await r.get('calls:seen');
  assert.ok(Array.isArray(seen) && seen.length === 400);
});

test('the seen list is stored as [id, ring, atMs] triples', async () => {
  const r = await startedRig();
  const at = r.clock.t - MIN;
  r.call('ours', 1);
  r.call('theirs', 0.5, { dialled: OTHER_LINE });
  await r.look();
  assert.deepEqual(await r.get('calls:seen'), [
    ['ours', `${PEER}|MISSED`, at],
    ['theirs', '', at + 0.5 * MIN],
  ]);
});

test('every page of summaries is read', async () => {
  const r = await startedRig();
  r.fake.pollPageSize = 2;
  for (let i = 0; i < 5; i++) r.call(`c${i}`, 1, { callerNumber: `+1801555020${i}` });
  const before = r.summaries().length;
  assert.equal(await r.look(), 5);
  assert.equal(r.summaries().length - before, 3);
});

test('changing the sending number takes effect next tick', async () => {
  const r = await startedRig();
  r.call('c1', 1);
  assert.equal(await r.look(), 1);
  await r.sms.core.config.save({ fromNumber: OTHER_LINE });
  r.call('to-old', 0, { callerNumber: '+18015550144' });
  r.call('to-new', 0, { callerNumber: '+18015550155', dialled: OTHER_LINE });
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['c1', 'to-new']);
  assert.equal(r.got[1]!.to, OTHER_LINE);
});

test('no account key or number makes no requests', async () => {
  const r = await rig({ accountKey: false });
  assert.equal(await r.watcher.tick(), 0);
  r.clock.t += 2 * MIN;
  assert.equal(await r.watcher.tick(), 0);
  assert.deepEqual(r.fake.callReportHits, []);
  assert.equal(await r.get('calls:cursor'), undefined);
});

test('reach back is clamped to 24 hours', async () => {
  const r = await startedRig();
  r.clock.t += 3 * 24 * 60 * MIN;
  await r.look();
  assert.equal(r.summaries().at(-1)!.get('startTime'), '2026-10-29T10:02:00Z');
});

test('C31 caller details never reach info logs', async () => {
  const { logger, lines } = recorder();
  const r = await startedRig({ logger });
  r.state.emitThrows = true;
  r.call('c1', 1);
  r.call('c2', 0.5, { summaryHasDialled: false, callerNumber: '+18015550144' });
  r.fake.failNext('GET', REPORTS, 500);
  await r.look();
  assert.ok(loud(lines).length > 0);
  for (const line of loud(lines)) {
    assert.equal(line.includes(PEER), false);
    assert.equal(line.includes('+18015550144'), false);
    assert.equal(line.includes('Pat Example'), false);
  }
});

// --- Refusals and the back-off ---

const SCOPE_MESSAGE =
  'GoTo refused the call reports. Enable the scope cr.v1.read on the OAuth client, ' +
  'then reconnect.';

/** Every summaries request from now on answers `status`, whatever the token. */
const refuse = (fake: FakeGoTo, status: number): void => void (fake.callReportsRefuse = status);
const tokenRequests = (fake: FakeGoTo): number =>
  fake.requests.filter((q) => q.path.startsWith('/oauth/token')).length;

test('first look checks access but delivers nothing', async () => {
  const r = await rig();
  r.call('old', 1);
  assert.equal(await r.watcher.tick(), 0);
  const q = r.summaries();
  assert.equal(q.length, 1);
  // GoTo answers 400 to an empty window, so the first look reaches back one minute...
  assert.deepEqual(
    [q[0]!.get('startTime'), q[0]!.get('endTime')],
    ['2026-10-27T09:59:00Z', '2026-10-27T10:00:00Z'],
  );
  // ...without delivering what it finds there, and without an error.
  assert.deepEqual(r.got, []);
  assert.equal(await r.get('calls:error'), undefined);
});

test('C30 a 403 sets calls_scope and a good look clears it', async () => {
  const r = await startedRig();
  const cursor = await r.get('calls:cursor');
  r.call('c1', 1);
  r.fake.failNext('GET', SUMMARIES, 403, { error: 'forbidden' });
  assert.equal(await r.look(), 0);
  assert.deepEqual(await r.get('calls:error'), {
    error: 'calls_scope',
    message: SCOPE_MESSAGE,
    gotoStatus: 403,
  });
  assert.equal(await r.get('calls:cursor'), cursor);
  r.clock.t += 60 * MIN; // past the back-off
  assert.equal(await r.look(), 1);
  assert.equal(await r.get('calls:error'), undefined);
});

test('C30 repeated 401 never marks the login expired and backs off', async () => {
  const r = await startedRig();
  refuse(r.fake, 401);
  const tokensBefore = tokenRequests(r.fake);
  const looksBefore = r.summaries().length;
  for (let i = 0; i < 5; i++) assert.equal(await r.look(), 0);
  // One look: the request, one forced refresh, the retry. Then nothing for an hour.
  assert.equal(r.summaries().length - looksBefore, 2);
  assert.equal(tokenRequests(r.fake) - tokensBefore, 1);
  assert.notEqual(await r.get('login_expired'), true);
  assert.equal((await r.sms.core.auth.status()).connected, true);
  assert.deepEqual(await r.get('calls:error'), {
    error: 'calls_scope',
    message: SCOPE_MESSAGE,
    gotoStatus: 401,
  });
  r.clock.t += 60 * MIN;
  await r.look();
  assert.equal(r.summaries().length - looksBefore, 4);
});

test('a restart looks once while refused', async () => {
  const r = await startedRig();
  refuse(r.fake, 403);
  await r.look();
  const before = r.summaries().length;
  const again = r.newWatcher();
  await again.tick();
  await again.tick();
  assert.equal(r.summaries().length - before, 1);
});

test('a 500 sets goto_api and keeps the normal interval', async () => {
  const r = await startedRig();
  r.fake.failNext('GET', SUMMARIES, 500);
  assert.equal(await r.look(), 0);
  assert.deepEqual(await r.get('calls:error'), {
    error: 'goto_api',
    message: 'GoTo API error 500',
    gotoStatus: 500,
  });
  r.call('c1', 1);
  assert.equal(await r.look(), 1); // two minutes later, not an hour
  assert.equal(await r.get('calls:error'), undefined);
});

test('network failure sets goto_unreachable', async () => {
  const r = await startedRig();
  await r.fake.close();
  assert.equal(await r.look(), 0);
  assert.deepEqual(await r.get('calls:error'), {
    error: 'goto_unreachable',
    message: 'GoTo could not be reached',
  });
});

test('a really expired login is not called a scope problem', async () => {
  const r = await startedRig();
  await r.store.set(r.tenant, 'login_expired', true);
  const before = r.summaries().length;
  assert.equal(await r.look(), 0);
  assert.equal(await r.look(), 0);
  assert.equal(r.summaries().length, before); // no request leaves without a login
  const error = await r.get('calls:error');
  assert.equal((error as { error: string }).error, 'login_expired');
});

test('scope warning is logged once', async () => {
  const { logger, lines } = recorder();
  const r = await startedRig({ logger });
  refuse(r.fake, 403);
  for (let i = 0; i < 3; i++) await r.look(61);
  const warnings = lines.filter((l) => l.level === 'warn' || l.level === 'error').map((l) => l.m);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes('cr.v1.read'));
});

test('C30 texting still works while calls are refused', async () => {
  const r = await startedRig();
  refuse(r.fake, 401);
  for (let i = 0; i < 3; i++) await r.look(61);
  // The same login still reaches the rest of the API.
  assert.equal((await r.sms.send(PEER, 'still here')).status, 'sent');
  assert.equal(r.fake.sent.at(-1)!.body, 'still here');
});

test('C30 a new login lifts the back off', async () => {
  // The admin enables the scope and reconnects: the next look must go out, not wait an hour.
  const r = await startedRig();
  r.call('c1', 1);
  r.fake.failNext('GET', SUMMARIES, 403);
  assert.equal(await r.look(), 0);
  assert.equal(await r.look(), 0); // same login: backing off
  await r.sms.core.auth.forceRefresh(); // what a reconnect does to the stored login: new tokens
  assert.equal(await r.look(), 1);
  assert.equal(await r.get('calls:error'), undefined);
});

test('inbound summary without a caller type falls back to the report', async () => {
  const r = await startedRig();
  r.call('c1', 1, { summaryHasType: false });
  r.call('c2', 0.5, { summaryHasType: false, dialled: OTHER_LINE });
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['c1']);
  assert.equal(r.reportFetches(), 2);
});

test('C29 voicemail then missed from the same caller are two events', async () => {
  const r = await startedRig();
  r.call('c1', 1.5, { outcome: 'LEFT_DIAL_PLAN' });
  r.call('c2', 0.2, { outcome: 'MISSED' }); // 78 s later
  assert.equal(await r.look(), 2);
  assert.deepEqual(
    r.got.map((c) => c.outcome),
    ['LEFT_DIAL_PLAN', 'MISSED'],
  );
});

test('two callers shown as the same text both deliver', async () => {
  const r = await startedRig();
  r.call('c1', 1.5, { callerNumber: 'anonymous' });
  r.call('c2', 0.5, { callerNumber: 'anonymous' });
  assert.equal(await r.look(), 2);
  assert.deepEqual(
    r.got.map((c) => c.from),
    ['anonymous', 'anonymous'],
  );
});

test('a long call reported after it ends is delivered', async () => {
  const r = await startedRig();
  // 28 quiet minutes while the call is still going.
  for (let i = 0; i < 14; i++) assert.equal(await r.look(), 0);
  r.call('long', 25, { ended: iso(r.clock.t) });
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['long']);
});

// --- Status: the `calls` key and the conditional scope ---

const BASE_SCOPES = [
  'messaging.v1.send',
  'messaging.v1.read',
  'messaging.v1.notifications.manage',
  'voice-admin.v1.read',
];

async function fakeGoTo(): Promise<FakeGoTo> {
  const fake = await startFakeGoTo();
  cleanups.push(() => fake.close());
  return fake;
}

/** A started client with watchCalls on (its own loop an hour apart), driven by hand. */
async function watchingSms(fake: FakeGoTo, o: Partial<GoToSmsOptions> = {}) {
  const sms = await connectedSms(fake, {
    watchCalls: true,
    callPollIntervalMs: 3_600_000,
    env: { GOTO_ACCOUNT_KEY: 'acct-1' },
    ...o,
  });
  cleanups.push(() => sms.close());
  // A look does nothing while no call handler is registered.
  sms.on('call', () => {});
  const watcher = sms.core.calls;
  assert.ok(watcher);
  // The look started at startup ran before anything was configured; let it finish.
  await watcher.idle();
  return { sms, watcher };
}

test('C26 status has no calls key and no call scope when off', async () => {
  const fake = await fakeGoTo();
  const sms = await connectedSms(fake);
  cleanups.push(() => sms.close());
  const status = await sms.status();
  assert.equal('calls' in status, false);
  assert.deepEqual(status.requiredScopes, BASE_SCOPES);
  const viaRoute = await buildStatus(sms.core.options, sms.core, undefined, {
    includeWebhookUrl: true,
  });
  assert.equal('calls' in viaRoute, false);
  assert.deepEqual(viaRoute.requiredScopes, BASE_SCOPES);
});

test('requiredScopes lists cr.v1.read only when watching calls', async () => {
  const fake = await fakeGoTo();
  const { sms } = await watchingSms(fake);
  assert.deepEqual((await sms.status()).requiredScopes, [...BASE_SCOPES, 'cr.v1.read']);
  // Also before startup could finish (no encryption key): the admin still has to tick it.
  const broken = createGoToSms({ watchCalls: true, store: new MemoryStore(), env: {} });
  cleanups.push(() => broken.close());
  const status = await broken.status();
  assert.ok(status.startupError);
  assert.deepEqual(status.requiredScopes, [...BASE_SCOPES, 'cr.v1.read']);
  assert.equal('calls' in status, false);
});

test('status calls watching is true after a good look', async () => {
  const fake = await fakeGoTo();
  const { sms, watcher } = await watchingSms(fake);
  assert.deepEqual((await sms.status()).calls, { watching: false });
  await watcher.tick();
  assert.deepEqual((await sms.status()).calls, { watching: true });
});

test('C30 status calls carries the error', async () => {
  const fake = await fakeGoTo();
  const { sms, watcher } = await watchingSms(fake);
  await watcher.tick();
  refuse(fake, 403);
  await watcher.tick();
  const expected = {
    watching: false,
    error: { error: 'calls_scope', message: SCOPE_MESSAGE, gotoStatus: 403 },
  };
  assert.deepEqual((await sms.status()).calls, expected);
  const viaRoute = await buildStatus(sms.core.options, sms.core, undefined, {
    includeWebhookUrl: true,
  });
  assert.deepEqual(viaRoute.calls, expected);
  assert.equal((await sms.status()).connected, true);
});

test('C31 the status payload never carries a caller number or caller ID', async () => {
  const fake = await fakeGoTo();
  const clock = { t: T0 };
  const { sms, watcher } = await watchingSms(fake, { now: () => clock.t });
  const got: InboundCall[] = [];
  sms.on('call', (c) => void got.push(c));
  await watcher.tick();
  clock.t += 2 * MIN;
  fake.calls.push(fakeCall('c1', clock.t - MIN));
  assert.equal(await watcher.tick(), 1);
  assert.equal(got[0]!.from, PEER);
  for (const status of [
    await sms.status(),
    await buildStatus(sms.core.options, sms.core, undefined, { includeWebhookUrl: true }),
  ]) {
    const text = JSON.stringify(status);
    assert.equal(text.includes(PEER), false);
    assert.equal(text.includes('Pat Example'), false);
  }
});

// --- Wired into the client ---

const fakeCall = (id: string, atMs: number, over: Partial<FakeCall> = {}): FakeCall => ({
  id,
  created: iso(atMs),
  dialled: FROM,
  callerNumber: PEER,
  callerName: 'Pat Example',
  ...over,
});

async function live(o: Partial<GoToSmsOptions> = {}) {
  const fake = await fakeGoTo();
  const clock = { t: T0 };
  const sms = await connectedSms(fake, {
    now: () => clock.t,
    env: { GOTO_ACCOUNT_KEY: 'acct-1' },
    ...o,
  });
  cleanups.push(() => sms.close());
  return { fake, sms, clock };
}

test('end to end: a call reaches the handler', async () => {
  const r = await live({ watchCalls: true, callPollIntervalMs: 3_600_000 });
  const got: InboundCall[] = [];
  r.sms.on('call', (c) => void got.push(c));
  const watcher = r.sms.core.calls;
  assert.ok(watcher?.running);
  await watcher.idle();
  await watcher.tick(); // the first look: sets the cursor
  r.clock.t += 2 * MIN;
  r.fake.calls.push(fakeCall('c1', r.clock.t - MIN));
  assert.equal(await watcher.tick(), 1);
  assert.deepEqual(
    got.map((c) => [c.id, c.from, c.to]),
    [['c1', PEER, FROM]],
  );
  assert.deepEqual((await r.sms.status()).calls, { watching: true });
});

test('C26 watchCalls off makes no call report requests', async () => {
  const r = await live();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(r.sms.core.calls, undefined);
  assert.deepEqual(r.fake.callReportHits, []);
  assert.equal(
    r.fake.requests.some((q) => q.path.includes('call-events-report')),
    false,
  );
});

for (const mode of ['webhook', 'polling', undefined] as const) {
  test(`watcher runs in every incoming mode (${mode ?? 'off'})`, async () => {
    const store = new MemoryStore();
    if (mode) await store.set('default', 'inbound:mode', mode);
    const r = await live({ watchCalls: true, store });
    assert.equal(r.sms.core.calls?.running, true);
  });
}

test('the watcher loop looks on its own', async () => {
  // The shortest interval the option allows.
  const r = await live({ watchCalls: true, callPollIntervalMs: 1000 });
  r.sms.on('call', () => {});
  for (let i = 0; i < 100 && r.fake.callReportHits.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(r.fake.callReportHits.length >= 2);
});

test('close waits for a running call handler', async () => {
  const r = await live({ watchCalls: true, callPollIntervalMs: 3_600_000 });
  let entered!: () => void;
  let release!: () => void;
  const enteredP = new Promise<void>((resolve) => (entered = resolve));
  const releaseP = new Promise<void>((resolve) => (release = resolve));
  r.sms.on('call', async () => {
    entered();
    await releaseP;
  });
  const core = r.sms.core;
  const watcher = core.calls;
  assert.ok(watcher);
  await watcher.idle();
  await watcher.tick();
  r.clock.t += 2 * MIN;
  r.fake.calls.push(fakeCall('c1', r.clock.t - MIN));
  const look = watcher.tick();
  await enteredP;
  let closed = false;
  const closing = r.sms.close().then(() => (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, false);
  // Not saved as seen while the handler is still running.
  assert.equal(await core.store.get(core.tenant, 'calls:seen'), undefined);
  release();
  await closing;
  assert.equal(await look, 1);
  const seen = await core.store.get(core.tenant, 'calls:seen');
  assert.ok(Array.isArray(seen));
  assert.deepEqual(
    seen.map((entry) => (entry as unknown[])[0]),
    ['c1'],
  );
  assert.equal(watcher.running, false);
});

test('start twice starts one watcher', async () => {
  const r = await live({ watchCalls: true, callPollIntervalMs: 3_600_000 });
  const first = r.sms.core.calls;
  assert.ok(first);
  await first.idle();
  const before = r.fake.callReportHits.length;
  // Node starts in createGoToSms (there is no start()): awaiting ready again, or starting the
  // running watcher again, must not make a second watcher or a second loop.
  await r.sms.ready;
  first.start();
  await first.idle();
  assert.equal(r.sms.core.calls, first);
  assert.equal(r.fake.callReportHits.length, before);
});

// --- No handler, no look ---

test('a look does nothing while no call handler is registered', async () => {
  const r = await startedRig();
  r.call('c1', 1);
  const before = { hits: r.fake.callReportHits.length, cursor: await r.get('calls:cursor') };
  r.state.listening = false;
  r.fake.callReportsRefuse = 403; // would be recorded as an error, if a request went out
  assert.equal(await r.look(), 0);
  assert.equal(await r.look(), 0);
  assert.equal(r.fake.callReportHits.length, before.hits);
  assert.equal(await r.get('calls:cursor'), before.cursor);
  assert.equal(await r.get('calls:seen'), undefined);
  assert.equal(await r.get('calls:error'), undefined);
  delete r.fake.callReportsRefuse;
  r.state.listening = true;
  assert.equal(await r.look(), 1);
  assert.deepEqual(r.ids(), ['c1']);
});

test('nothing is asked of GoTo, and status says not watching, until on(call) is registered', async () => {
  const r = await live({ watchCalls: true, callPollIntervalMs: 3_600_000 });
  const watcher = r.sms.core.calls;
  assert.ok(watcher);
  await watcher.idle();
  assert.equal(await watcher.tick(), 0);
  assert.deepEqual(r.fake.callReportHits, []);
  assert.equal(await r.sms.core.store.get(r.sms.core.tenant, 'calls:cursor'), undefined);
  assert.deepEqual((await r.sms.status()).calls, { watching: false });
  // The first real look happens once a handler exists.
  r.sms.on('call', () => {});
  assert.equal(await watcher.tick(), 0);
  assert.equal(r.fake.callReportHits.length, 1);
  assert.deepEqual((await r.sms.status()).calls, { watching: true });
});

test('a call waiting at startup is delivered to a handler registered late', async () => {
  const fake = await fakeGoTo();
  const clock = { t: T0 };
  const store = new MemoryStore(() => clock.t);
  const options = {
    store,
    now: () => clock.t,
    env: { GOTO_ACCOUNT_KEY: 'acct-1' },
    watchCalls: true,
    callPollIntervalMs: 3_600_000,
  };
  // An earlier run of the app: watching was switched on and the cursor saved.
  const earlier = await connectedSms(fake, options);
  earlier.on('call', () => {});
  await earlier.core.calls!.idle();
  await earlier.core.calls!.tick();
  await earlier.close();

  // Someone rings while it is down; then it starts and registers its handler late.
  clock.t += 2 * MIN;
  fake.calls.push(fakeCall('c1', clock.t - MIN));
  const sms = await connectedSms(fake, { ...options, connect: false });
  cleanups.push(() => sms.close());
  const watcher = sms.core.calls!;
  await watcher.idle(); // the look at startup
  const hits = fake.callReportHits.length;
  assert.equal(await watcher.tick(), 0);
  assert.equal(fake.callReportHits.length, hits);
  assert.equal(await store.get('default', 'calls:seen'), undefined);

  const got: InboundCall[] = [];
  sms.on('call', (c) => void got.push(c));
  assert.equal(await watcher.tick(), 1);
  assert.equal(await watcher.tick(), 0);
  assert.deepEqual(
    got.map((c) => c.id),
    ['c1'],
  );
});

// --- callPollIntervalMs is made safe for a timer ---

for (const [given, resolved] of [
  [Number.NaN, 120_000],
  [Number.POSITIVE_INFINITY, 120_000],
  [0, 120_000],
  [-5, 120_000],
  [999, 120_000],
  [1000, 1000],
  [2_147_483_647, 2_147_483_647],
  [2_147_483_648, 2_147_483_647],
  [3e12, 2_147_483_647],
] as const) {
  test(`callPollIntervalMs ${given} is resolved to ${resolved}`, async () => {
    const sms = await bare({ watchCalls: true, callPollIntervalMs: given });
    assert.equal(sms.core.options.callPollIntervalMs, resolved);
  });
}

test('a NaN callPollIntervalMs does not make the watcher spin', async () => {
  const r = await live({ watchCalls: true, callPollIntervalMs: Number.NaN });
  r.sms.on('call', () => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(r.fake.callReportHits.length <= 1, `${r.fake.callReportHits.length} looks`);
});
