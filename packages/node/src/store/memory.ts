import { jsonEqual, nextClaim, type GoToSmsStore, type Json } from './types.js';

/**
 * In-process store. All operations are synchronous under the hood, so each is
 * atomic with respect to the event loop. Values are cloned on the way in and out.
 * FileStore extends this and persists after each mutation.
 */
export class MemoryStore implements GoToSmsStore {
  protected readonly data = new Map<string, Map<string, Json>>();

  constructor(protected readonly now: () => number = Date.now) {}

  async get(tenant: string, key: string): Promise<Json | undefined> {
    const value = this.data.get(tenant)?.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async set(tenant: string, key: string, value: Json): Promise<void> {
    this.put(tenant, key, value);
  }

  async delete(tenant: string, key: string): Promise<void> {
    this.data.get(tenant)?.delete(key);
  }

  async list(tenant: string, prefix: string): Promise<Array<{ key: string; value: Json }>> {
    return [...(this.data.get(tenant) ?? [])]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value: structuredClone(value) }));
  }

  async compareAndSet(
    tenant: string,
    key: string,
    expected: Json | undefined,
    next: Json,
  ): Promise<boolean> {
    if (!jsonEqual(this.data.get(tenant)?.get(key), expected)) return false;
    this.put(tenant, key, next);
    return true;
  }

  async claim(tenant: string, key: string, ttlMs: number, owner: string): Promise<boolean> {
    const next = nextClaim(this.data.get(tenant)?.get(key), owner, ttlMs, this.now());
    if (next === undefined) return false;
    this.put(tenant, key, next);
    return true;
  }

  private put(tenant: string, key: string, value: Json): void {
    let bucket = this.data.get(tenant);
    if (!bucket) this.data.set(tenant, (bucket = new Map()));
    bucket.set(key, structuredClone(value));
  }
}
