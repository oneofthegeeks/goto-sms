import type { Database, Statement } from 'better-sqlite3';
import { jsonEqual, nextClaim, type GoToSmsStore, type Json } from './types.js';

/**
 * SQLite adapter. The caller owns the `better-sqlite3` Database (it is an optional peer
 * dependency, so this module only imports its types). Uses the sync API; every
 * read-modify-write runs in a BEGIN IMMEDIATE transaction so it is atomic across processes too.
 */
export class SqliteStore implements GoToSmsStore {
  private readonly now: () => number;
  private readonly stmts: {
    get: Statement<unknown[]>;
    set: Statement<unknown[]>;
    del: Statement<unknown[]>;
    list: Statement<unknown[]>;
  };
  private readonly casTx: (t: string, k: string, e: Json | undefined, n: Json) => boolean;
  private readonly claimTx: (t: string, k: string, ttl: number, o: string) => boolean;

  constructor(db: Database, opts: { table?: string; now?: () => number } = {}) {
    const table = opts.table ?? 'goto_sms_kv';
    // The table name is interpolated into SQL (it cannot be a bound parameter), so restrict it.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`invalid table name: ${table}`);
    this.now = opts.now ?? Date.now;

    db.pragma('journal_mode = WAL');
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (
         tenant TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
         PRIMARY KEY (tenant, key))`,
    );
    this.stmts = {
      get: db.prepare(`SELECT value FROM ${table} WHERE tenant = ? AND key = ?`),
      set: db.prepare(
        `INSERT INTO ${table} (tenant, key, value) VALUES (?, ?, ?)
         ON CONFLICT (tenant, key) DO UPDATE SET value = excluded.value`,
      ),
      del: db.prepare(`DELETE FROM ${table} WHERE tenant = ? AND key = ?`),
      // substr compare, not LIKE: prefixes may contain % or _.
      list: db.prepare(
        `SELECT key, value FROM ${table}
         WHERE tenant = ? AND substr(key, 1, length(?)) = ? ORDER BY key`,
      ),
    };
    const cas = db.transaction((t: string, k: string, expected: Json | undefined, next: Json) => {
      if (!jsonEqual(this.read(t, k), expected)) return false;
      this.stmts.set.run(t, k, JSON.stringify(next));
      return true;
    });
    // Call through a closure: `.immediate` is a method that needs its transaction as `this`.
    this.casTx = (...args) => cas.immediate(...args);
    const claim = db.transaction((t: string, k: string, ttlMs: number, owner: string) => {
      const next = nextClaim(this.read(t, k), owner, ttlMs, this.now());
      if (next === undefined) return false;
      this.stmts.set.run(t, k, JSON.stringify(next));
      return true;
    });
    this.claimTx = (...args) => claim.immediate(...args);
  }

  async get(tenant: string, key: string): Promise<Json | undefined> {
    return this.read(tenant, key);
  }

  async set(tenant: string, key: string, value: Json): Promise<void> {
    this.stmts.set.run(tenant, key, JSON.stringify(value));
  }

  async delete(tenant: string, key: string): Promise<void> {
    this.stmts.del.run(tenant, key);
  }

  async list(tenant: string, prefix: string): Promise<Array<{ key: string; value: Json }>> {
    const rows = this.stmts.list.all(tenant, prefix, prefix) as Array<{
      key: string;
      value: string;
    }>;
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) as Json }));
  }

  async compareAndSet(
    tenant: string,
    key: string,
    expected: Json | undefined,
    next: Json,
  ): Promise<boolean> {
    return this.casTx(tenant, key, expected, next);
  }

  async claim(tenant: string, key: string, ttlMs: number, owner: string): Promise<boolean> {
    return this.claimTx(tenant, key, ttlMs, owner);
  }

  private read(tenant: string, key: string): Json | undefined {
    const row = this.stmts.get.get(tenant, key) as { value: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as Json);
  }
}
