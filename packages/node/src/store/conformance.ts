import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GoToSmsStore } from './types.js';

/**
 * Registers the behavioural contract every GoToSmsStore must satisfy.
 * `make` must return a fresh, empty store; it receives a clock it should use
 * so the claim-expiry case can advance time deterministically.
 */
export function runStoreConformance(
  name: string,
  make: (now: () => number) => Promise<GoToSmsStore>,
): void {
  const t = (title: string, fn: (s: GoToSmsStore, clock: { ms: number }) => Promise<void>) =>
    void test(`${name}: ${title}`, async () => {
      const clock = { ms: 1_000_000 };
      await fn(await make(() => clock.ms), clock);
    });

  t('set/get round trip and missing key', async (s) => {
    assert.equal(await s.get('t', 'missing'), undefined);
    const value = { a: [1, 'two', null, true], b: { c: 'd' } };
    await s.set('t', 'k', value);
    assert.deepEqual(await s.get('t', 'k'), value);
    await s.set('t', 'k', 'overwritten');
    assert.equal(await s.get('t', 'k'), 'overwritten');
  });

  t('delete removes the key and tolerates a missing one', async (s) => {
    await s.set('t', 'k', 1);
    await s.delete('t', 'k');
    assert.equal(await s.get('t', 'k'), undefined);
    await s.delete('t', 'never-existed');
  });

  t('list returns only the prefix, sorted by key', async (s) => {
    await s.set('t', 'log:b', 2);
    await s.set('t', 'log:a', 1);
    await s.set('t', 'log:c', 3);
    await s.set('t', 'optout:x', 9);
    await s.set('t', 'lo%', 8); // LIKE wildcard must not leak into prefix matching
    assert.deepEqual(await s.list('t', 'log:'), [
      { key: 'log:a', value: 1 },
      { key: 'log:b', value: 2 },
      { key: 'log:c', value: 3 },
    ]);
    assert.deepEqual(await s.list('t', 'nothing:'), []);
    assert.deepEqual(await s.list('t', 'lo%'), [{ key: 'lo%', value: 8 }]);
  });

  t('tenants are isolated', async (s) => {
    await s.set('one', 'k', 'x');
    await s.set('two', 'k', 'y');
    assert.equal(await s.get('one', 'k'), 'x');
    assert.equal(await s.get('two', 'k'), 'y');
    assert.equal((await s.list('one', '')).length, 1);
    await s.delete('one', 'k');
    assert.equal(await s.get('two', 'k'), 'y');
  });

  t('compareAndSet succeeds on match (incl. absent) and fails otherwise', async (s) => {
    assert.equal(await s.compareAndSet('t', 'k', undefined, { n: 1 }), true);
    assert.equal(await s.compareAndSet('t', 'k', undefined, { n: 2 }), false);
    assert.deepEqual(await s.get('t', 'k'), { n: 1 });
    assert.equal(await s.compareAndSet('t', 'k', { n: 99 }, { n: 2 }), false);
    // Deep equality, independent of object key order.
    assert.equal(await s.compareAndSet('t', 'k', { n: 1 }, { n: 2, m: [1] }), true);
    assert.equal(await s.compareAndSet('t', 'k', { m: [1], n: 2 }, 'done'), true);
    assert.equal(await s.get('t', 'k'), 'done');
  });

  t('compareAndSet lets exactly one of two concurrent callers win', async (s) => {
    await s.set('t', 'k', 0);
    const results = await Promise.all([
      s.compareAndSet('t', 'k', 0, 1),
      s.compareAndSet('t', 'k', 0, 2),
    ]);
    assert.deepEqual(results.filter(Boolean).length, 1);
  });

  t('claim: first wins, others wait for TTL, owner may re-claim', async (s, clock) => {
    assert.equal(await s.claim('t', 'lock', 1000, 'a'), true);
    assert.equal(await s.claim('t', 'lock', 1000, 'b'), false);
    assert.equal(await s.claim('t', 'lock', 1000, 'a'), true); // same owner re-claims
    clock.ms += 999;
    assert.equal(await s.claim('t', 'lock', 1000, 'b'), false);
    clock.ms += 1000; // past the (renewed) expiry
    assert.equal(await s.claim('t', 'lock', 1000, 'b'), true);
    assert.equal(await s.claim('t', 'lock', 1000, 'a'), false);
  });
}
