import { readFileSync, renameSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../types.js';
import { MemoryStore } from './memory.js';
import type { Json } from './types.js';

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

type Snapshot = Record<string, Record<string, Json>>;

/**
 * JSON-file store: an in-memory map (MemoryStore) flushed to disk after every
 * mutation. Flushes are serialized through one promise chain and written as
 * `path.tmp` then renamed, so readers never see a half-written file.
 * Single-process only; cross-process exclusion is the caller's job (claim).
 */
export class FileStore extends MemoryStore {
  private readonly path: string;
  private readonly logger: Logger;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: { path: string; now?: () => number; logger?: Logger }) {
    super(opts.now);
    this.path = opts.path;
    this.logger = opts.logger ?? silentLogger;
    this.load();
  }

  override async set(tenant: string, key: string, value: Json): Promise<void> {
    await super.set(tenant, key, value);
    await this.flush();
  }

  override async delete(tenant: string, key: string): Promise<void> {
    await super.delete(tenant, key);
    await this.flush();
  }

  override async compareAndSet(
    tenant: string,
    key: string,
    expected: Json | undefined,
    next: Json,
  ): Promise<boolean> {
    const won = await super.compareAndSet(tenant, key, expected, next);
    if (won) await this.flush();
    return won;
  }

  override async claim(
    tenant: string,
    key: string,
    ttlMs: number,
    owner: string,
  ): Promise<boolean> {
    const won = await super.claim(tenant, key, ttlMs, owner);
    if (won) await this.flush();
    return won;
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const snapshot = JSON.parse(text) as unknown;
      if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
        throw new Error('unexpected file shape');
      }
      for (const [tenant, entries] of Object.entries(snapshot as Snapshot)) {
        this.data.set(tenant, new Map(Object.entries(entries)));
      }
    } catch {
      // Keep the unreadable file for forensics rather than overwrite it, and start empty.
      this.data.clear();
      const aside = `${this.path}.corrupt-${this.now()}`;
      renameSync(this.path, aside);
      this.logger.warn('goto-sms: store file was not valid JSON; moved aside and starting empty', {
        movedTo: aside,
      });
    }
  }

  private flush(): Promise<void> {
    const write = async (): Promise<void> => {
      const snapshot: Snapshot = {};
      for (const [tenant, bucket] of this.data) snapshot[tenant] = Object.fromEntries(bucket);
      const tmp = `${this.path}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(tmp, this.path);
    };
    const result = this.chain.then(write);
    // A failed write must not wedge later writes; the caller still sees the error via `result`.
    this.chain = result.catch(() => {});
    return result;
  }
}
