// Calls to the sending number as events: on('call'), CallWatcher, status. A port of
// aiogotoconnect's tests/sms/test_calls.py, test for test.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGoToSms, type GoToSms, type GoToSmsOptions } from '../src/client.js';
import { MemoryStore } from '../src/store/memory.js';
import type { InboundCall, Logger } from '../src/types.js';
import { FROM, PEER, recorder, silent } from './helpers/sms.js';

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
