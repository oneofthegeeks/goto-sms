import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DecryptError, GoToSmsError, NotConfiguredError } from './errors.js';
import type { Logger } from './types.js';

export { DecryptError };

const VERSION = 'v1';
const IV_BYTES = 12; // standard GCM nonce size
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** AES-256-GCM sealing of small secrets as "v1.<iv>.<tag>.<ciphertext>" (base64 parts). */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES)
      throw new GoToSmsError('Encryption key must be 32 bytes', 'bad_key');
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), ct]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
      .join('.');
  }

  /** Throws DecryptError for any malformed input or auth failure; never a raw crypto error. */
  open(sealed: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new DecryptError();
    // Node's base64 decoder silently skips invalid characters, so validate strictly first.
    if (!parts.slice(1).every((p) => /^[A-Za-z0-9+/]*={0,2}$/.test(p))) throw new DecryptError();
    const iv = Buffer.from(parts[1]!, 'base64');
    const tag = Buffer.from(parts[2]!, 'base64');
    const ct = Buffer.from(parts[3]!, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptError();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new DecryptError();
    }
  }
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

export async function resolveEncryptionKey(o: {
  optionKey?: string;
  env: NodeJS.ProcessEnv;
  dataDir?: string;
  logger: Logger;
}): Promise<{ key: Buffer; source: 'option' | 'env' | 'keyfile' }> {
  if (o.optionKey) return { key: sha256(o.optionKey), source: 'option' };
  const envKey = o.env.GOTO_SMS_ENCRYPTION_KEY;
  if (envKey) return { key: sha256(envKey), source: 'env' };
  if (!o.dataDir) {
    throw new NotConfiguredError('Set GOTO_SMS_ENCRYPTION_KEY (required when no dataDir is used)');
  }

  const file = join(o.dataDir, '.goto-sms.key');
  await mkdir(o.dataDir, { recursive: true });
  const fresh = randomBytes(KEY_BYTES);
  try {
    // 'wx' fails if the file exists, so concurrent callers never overwrite each other's key.
    await writeFile(file, fresh, { flag: 'wx', mode: 0o600 });
    o.logger.warn(`Created encryption keyfile ${file}; set GOTO_SMS_ENCRYPTION_KEY in production`);
    return { key: fresh, source: 'keyfile' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Another caller created it. 'wx' creates the file before the bytes land, so a
  // concurrent reader can briefly see it empty; retry a few times before giving up.
  let key = await readFile(file);
  for (let i = 0; i < 20 && key.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
    key = await readFile(file);
  }
  if (key.length !== KEY_BYTES) {
    throw new GoToSmsError(
      `Encryption keyfile ${file} is ${key.length} bytes, expected ${KEY_BYTES}; delete it only if no stored secrets need it`,
      'bad_keyfile',
    );
  }
  return { key, source: 'keyfile' };
}
