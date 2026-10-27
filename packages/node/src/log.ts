import { randomBytes } from 'node:crypto';
import type { GoToSmsStore, Json } from './store/types.js';
import type { LogEntry } from './types.js';

const PREFIX = 'log:';
const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_LIST_LIMIT = 50;
// Prune on every Nth append instead of on a timer, so the store stays small on its own.
const PRUNE_EVERY = 100;

/** The ms timestamp encoded in a `log:<15-digit ms>:<hex>` key. */
const keyTime = (key: string): number => Number(key.slice(PREFIX.length, PREFIX.length + 15));

function asLogEntry(v: Json): LogEntry | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  return v as unknown as LogEntry;
}

/**
 * Message log, capped by age and count. Keys sort by time (zero-padded ms), so the
 * store's ascending key order is oldest first. Message bodies are never stored.
 */
export class MessageLog {
  readonly retentionDays: number;
  private readonly maxEntries: number;
  private appends = 0;

  constructor(
    private readonly store: GoToSmsStore,
    private readonly tenant: string,
    private readonly now: () => number,
    o: { retentionDays?: number; maxEntries?: number } = {},
  ) {
    this.retentionDays = o.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.maxEntries = o.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async append(e: Omit<LogEntry, 'id' | 'at'>): Promise<LogEntry> {
    const t = this.now();
    const id = `${String(t).padStart(15, '0')}:${randomBytes(4).toString('hex')}`;
    // Fields are picked one by one so nothing else a caller passes (a body) gets stored.
    const entry: LogEntry = {
      id,
      direction: e.direction,
      from: e.from,
      to: e.to,
      status: e.status,
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
      ...(e.gotoId !== undefined ? { gotoId: e.gotoId } : {}),
      at: new Date(t).toISOString(),
    };
    await this.store.set(this.tenant, PREFIX + id, entry as unknown as Json);
    if (++this.appends % PRUNE_EVERY === 0) await this.prune();
    return entry;
  }

  /** Newest first. */
  async list(limit = DEFAULT_LIST_LIMIT): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    const all = await this.store.list(this.tenant, PREFIX);
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = asLogEntry(all[i]!.value);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** Drops entries older than the retention period, then all but the newest maxEntries. */
  async prune(): Promise<void> {
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    const keys = (await this.store.list(this.tenant, PREFIX)).map((e) => e.key);
    const expired = keys.filter((k) => keyTime(k) < cutoff);
    const live = keys.filter((k) => !(keyTime(k) < cutoff));
    // Oldest first, so the overflow is the front of what's left.
    const overflow = live.slice(0, Math.max(0, live.length - this.maxEntries));
    for (const key of [...expired, ...overflow]) await this.store.delete(this.tenant, key);
  }
}
