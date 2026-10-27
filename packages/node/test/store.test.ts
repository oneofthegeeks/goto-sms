import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStoreConformance } from '../src/store/conformance.js';
import { MemoryStore, FileStore, SqliteStore } from '../src/index.js';
import type { Logger } from '../src/index.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'goto-sms-store-'));
}

const dirs: string[] = [];
async function freshDir(): Promise<string> {
  const d = await tmpDir();
  dirs.push(d);
  return d;
}
test.after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

runStoreConformance('MemoryStore', async (now) => new MemoryStore(now));

runStoreConformance(
  'FileStore',
  async (now) => new FileStore({ path: join(await freshDir(), 'goto-sms.json'), now }),
);

// better-sqlite3 is an optional peer; skip the adapter run when it isn't installed.
type SqliteCtor = new (file: string) => import('better-sqlite3').Database;
let Database: SqliteCtor | undefined;
try {
  Database = (await import('better-sqlite3')).default as unknown as SqliteCtor;
  new Database(':memory:').close(); // also catches a missing native binding
} catch {
  Database = undefined;
}
if (Database) {
  const Db = Database;
  runStoreConformance('SqliteStore', async (now) => new SqliteStore(new Db(':memory:'), { now }));
} else {
  test('SqliteStore conformance', { skip: 'better-sqlite3 not available' }, () => {});
}

test('FileStore: a new instance on the same path sees earlier writes', async () => {
  const path = join(await freshDir(), 'goto-sms.json');
  await new FileStore({ path }).set('t', 'k', { v: 1 });
  assert.deepEqual(await new FileStore({ path }).get('t', 'k'), { v: 1 });
});

test('FileStore: atomic write leaves no .tmp file behind', async () => {
  const dir = await freshDir();
  const store = new FileStore({ path: join(dir, 'goto-sms.json') });
  await store.set('t', 'a', 1);
  await store.set('t', 'b', 2);
  await Promise.all([store.set('t', 'c', 3), store.delete('t', 'a')]);
  assert.deepEqual(await readdir(dir), ['goto-sms.json']);
});

test('FileStore: file is created with mode 0600', async () => {
  const path = join(await freshDir(), 'goto-sms.json');
  await new FileStore({ path }).set('t', 'k', 1);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('FileStore: corrupt file is renamed, store starts empty, warning logged', async () => {
  const dir = await freshDir();
  const path = join(dir, 'goto-sms.json');
  await writeFile(path, '{not json');
  const warnings: string[] = [];
  const store = new FileStore({
    path,
    now: () => 12345,
    logger: { ...silent, warn: (m) => void warnings.push(m) },
  });
  assert.deepEqual(await store.list('t', ''), []);
  assert.equal(warnings.length, 1);
  assert.deepEqual((await readdir(dir)).sort(), ['goto-sms.json.corrupt-12345']);
  assert.equal(await readFile(join(dir, 'goto-sms.json.corrupt-12345'), 'utf8'), '{not json');
  await store.set('t', 'k', 1); // usable afterwards
  assert.equal(await new FileStore({ path }).get('t', 'k'), 1);
});
