export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface GoToSmsStore {
  get(tenant: string, key: string): Promise<Json | undefined>;
  set(tenant: string, key: string, value: Json): Promise<void>;
  delete(tenant: string, key: string): Promise<void>;
  /** Entries whose key starts with `prefix`, sorted by key ascending. */
  list(tenant: string, prefix: string): Promise<Array<{ key: string; value: Json }>>;
  /** Atomically set `next` iff the current value deep-equals `expected` (`undefined` = absent). */
  compareAndSet(
    tenant: string,
    key: string,
    expected: Json | undefined,
    next: Json,
  ): Promise<boolean>;
  /** True if the key is free, expired, or already owned by `owner` (then lease is renewed). */
  claim(tenant: string, key: string, ttlMs: number, owner: string): Promise<boolean>;
}

/** Deep equality for JSON values; object key order is irrelevant. */
export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    );
  }
  const keysA = Object.keys(a);
  return (
    keysA.length === Object.keys(b).length &&
    keysA.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
  );
}

/**
 * Shared claim rule. Claims are stored as `{owner, expiresAt}` under the key.
 * Returns the new claim value to store, or undefined when someone else holds a live claim.
 * A value that isn't a claim record is treated as free.
 */
export function nextClaim(
  current: Json | undefined,
  owner: string,
  ttlMs: number,
  now: number,
): Json | undefined {
  if (
    typeof current === 'object' &&
    current !== null &&
    !Array.isArray(current) &&
    typeof current.owner === 'string' &&
    typeof current.expiresAt === 'number' &&
    current.owner !== owner &&
    current.expiresAt > now
  ) {
    return undefined;
  }
  return { owner, expiresAt: now + ttlMs };
}
