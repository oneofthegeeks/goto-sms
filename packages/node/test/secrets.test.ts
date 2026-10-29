import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretBox, DecryptError, resolveEncryptionKey } from '../src/secrets.js';
import { GoToSmsError, NotConfiguredError } from '../src/errors.js';
import type { Logger } from '../src/types.js';

const warnings: string[] = [];
const logger: Logger = {
  debug() {},
  info() {},
  warn: (m) => void warnings.push(m),
  error() {},
};
const tmp = () => mkdtemp(join(tmpdir(), 'goto-sms-secrets-'));

test('seal/open round trip', () => {
  const box = new SecretBox(randomBytes(32));
  const sealed = box.seal('hunter2 ✓');
  assert.match(sealed, /^v1\.[^.]+\.[^.]+\.[^.]*$/);
  assert.equal(box.open(sealed), 'hunter2 ✓');
});

test('two seals of the same text differ', () => {
  const box = new SecretBox(randomBytes(32));
  assert.notEqual(box.seal('same'), box.seal('same'));
});

test('tampered ciphertext throws DecryptError', () => {
  const box = new SecretBox(randomBytes(32));
  const [v, iv, tag, ct] = box.seal('secret value').split('.');
  const bytes = Buffer.from(ct!, 'base64');
  bytes[0] = bytes[0]! ^ 0xff;
  assert.throws(() => box.open([v, iv, tag, bytes.toString('base64')].join('.')), DecryptError);
});

test('different key throws DecryptError', () => {
  const sealed = new SecretBox(randomBytes(32)).seal('x');
  assert.throws(() => new SecretBox(randomBytes(32)).open(sealed), DecryptError);
});

test('malformed sealed strings throw DecryptError, never a raw crypto error', () => {
  const box = new SecretBox(randomBytes(32));
  const good = box.seal('x');
  const [, iv, tag, ct] = good.split('.');
  for (const bad of [
    '',
    'garbage',
    `v2.${iv}.${tag}.${ct}`,
    `v1.${iv}.${tag}`,
    `v1.${iv}.${tag}.${ct}.extra`,
    `v1.!!!.${tag}.${ct}`,
    `v1.${iv}.AAAA.${ct}`, // wrong-length tag
    `v1.AAAA.${tag}.${ct}`, // wrong-length iv
  ]) {
    assert.throws(() => box.open(bad), DecryptError, bad);
  }
});

test('DecryptError has code decrypt_failed', () => {
  const e = new DecryptError();
  assert.ok(e instanceof GoToSmsError);
  assert.equal(e.code, 'decrypt_failed');
});

test('option and env keys are sha256 of the string; option wins', async () => {
  const env = { GOTO_SMS_ENCRYPTION_KEY: 'from-env' };
  const a = await resolveEncryptionKey({ optionKey: 'from-opt', env, logger });
  assert.equal(a.source, 'option');
  assert.deepEqual(a.key, createHash('sha256').update('from-opt', 'utf8').digest());
  const b = await resolveEncryptionKey({ env, logger });
  assert.equal(b.source, 'env');
  assert.deepEqual(b.key, createHash('sha256').update('from-env', 'utf8').digest());
});

test('keyfile is created once with mode 0600, reused, and warns', async () => {
  const dataDir = join(await tmp(), 'nested', 'data'); // dataDir does not exist yet
  warnings.length = 0;
  const first = await resolveEncryptionKey({ env: {}, dataDir, logger });
  assert.equal(first.source, 'keyfile');
  assert.equal(first.key.length, 32);
  const file = join(dataDir, '.goto-sms.key');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(warnings.some((w) => w.includes('set GOTO_SMS_ENCRYPTION_KEY in production')));
  assert.ok(warnings.every((w) => !w.includes(first.key.toString('hex'))));
  const second = await resolveEncryptionKey({ env: {}, dataDir, logger });
  assert.deepEqual(second.key, first.key);
  assert.deepEqual(await readFile(file), first.key);
});

test('concurrent first calls converge on the same key', async () => {
  const dataDir = await tmp();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => resolveEncryptionKey({ env: {}, dataDir, logger })),
  );
  for (const r of results) assert.deepEqual(r.key, results[0]!.key);
});

test('env key wins over an existing keyfile', async () => {
  const dataDir = await tmp();
  await resolveEncryptionKey({ env: {}, dataDir, logger });
  const r = await resolveEncryptionKey({ env: { GOTO_SMS_ENCRYPTION_KEY: 'k' }, dataDir, logger });
  assert.equal(r.source, 'env');
});

test('keyfile of the wrong length is an error, not regenerated', async () => {
  const dataDir = await tmp();
  const file = join(dataDir, '.goto-sms.key');
  await writeFile(file, Buffer.alloc(5));
  await assert.rejects(resolveEncryptionKey({ env: {}, dataDir, logger }), GoToSmsError);
  assert.equal((await readFile(file)).length, 5);
});

test('no key and no dataDir throws NotConfiguredError in plain words', async () => {
  await assert.rejects(resolveEncryptionKey({ env: {}, logger }), {
    name: 'NotConfiguredError',
    message:
      'Set GOTO_SMS_ENCRYPTION_KEY (or give a dataDir/store the package can keep a key file in)',
  });
});

test('a damaged keyfile: the error names no path (it reaches the page); the log does', async () => {
  const dataDir = await tmp();
  const file = join(dataDir, '.goto-sms.key');
  await writeFile(file, Buffer.alloc(5));
  warnings.length = 0;
  const err = await resolveEncryptionKey({ env: {}, dataDir, logger }).catch((e: unknown) => e);
  assert.ok(err instanceof GoToSmsError);
  assert.equal(err.code, 'bad_keyfile');
  assert.ok(!err.message.includes(dataDir), err.message);
  assert.match(err.message, /encryption key file is damaged/i);
  assert.ok(warnings.some((w) => w.includes(file)));
});

test('a CHANGEME or blank key is not used as the key', async () => {
  const dataDir = await tmp();
  for (const placeholder of ['CHANGEME', 'changeme', '  ', '']) {
    const r = await resolveEncryptionKey({
      optionKey: placeholder,
      env: { GOTO_SMS_ENCRYPTION_KEY: placeholder },
      dataDir,
      logger,
    });
    assert.equal(r.source, 'keyfile');
  }
  await assert.rejects(
    resolveEncryptionKey({ env: { GOTO_SMS_ENCRYPTION_KEY: 'CHANGEME' }, logger }),
    NotConfiguredError,
  );
});

test('a real key is hashed untrimmed', async () => {
  const r = await resolveEncryptionKey({ env: { GOTO_SMS_ENCRYPTION_KEY: ' k ' }, logger });
  assert.deepEqual(r.key, createHash('sha256').update(' k ', 'utf8').digest());
});

test('an ignored placeholder key logs a warning that names no value', async () => {
  const dataDir = await tmp();
  warnings.length = 0;
  await resolveEncryptionKey({ env: { GOTO_SMS_ENCRYPTION_KEY: 'CHANGEME' }, dataDir, logger });
  const w = warnings.find((m) => m.includes('GOTO_SMS_ENCRYPTION_KEY is a placeholder'));
  assert.ok(w, warnings.join('\n'));
  warnings.length = 0;
  await resolveEncryptionKey({ optionKey: '  ', env: {}, dataDir, logger });
  assert.ok(warnings.some((m) => m.includes('encryptionKey option is a placeholder')));
  // Unset (undefined) keys are not placeholders: no such warning.
  warnings.length = 0;
  await resolveEncryptionKey({ env: {}, dataDir, logger });
  assert.ok(!warnings.some((m) => m.includes('placeholder')));
});
