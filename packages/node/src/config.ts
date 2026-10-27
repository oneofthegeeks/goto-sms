import { DecryptError, GoToSmsError } from './errors.js';
import { normalizePhone } from './phone.js';
import type { SecretBox } from './secrets.js';
import type { GoToSmsStore } from './store/types.js';

export type ConfigField = 'clientId' | 'clientSecret' | 'accountKey' | 'fromNumber';
export type Source = 'options' | 'env' | 'store' | 'unset';

export interface ResolvedConfig {
  clientId?: string;
  clientSecret?: string;
  accountKey?: string;
  fromNumber?: string;
  sources: Record<ConfigField, Source>;
  /** The stored client secret exists but can't be decrypted (wrong/changed encryption key). */
  credentialsUnreadable: boolean;
  /** An options/env fromNumber was set but isn't a valid phone number (value is then undefined). */
  invalidFromNumber?: true;
}

type ConfigInput = Partial<Record<ConfigField | 'refreshToken', string>>;

const FIELDS: ConfigField[] = ['clientId', 'clientSecret', 'accountKey', 'fromNumber'];
const ENV_NAMES: Record<ConfigField, string> = {
  clientId: 'GOTO_CLIENT_ID',
  clientSecret: 'GOTO_CLIENT_SECRET',
  accountKey: 'GOTO_ACCOUNT_KEY',
  fromNumber: 'GOTO_FROM_NUMBER',
};
const storeKey = (field: ConfigField) => `config:${field}`;
// '' counts as unset: Docker .env files commonly contain `GOTO_CLIENT_ID=`.
const nonEmpty = (v: string | undefined): string | undefined => (v ? v : undefined);

/** Resolves credentials with precedence options > env > store; only the store layer is writable. */
export class ConfigResolver {
  private readonly store: GoToSmsStore;
  private readonly tenant: string;
  private readonly box: SecretBox;
  private readonly options: ConfigInput;
  private readonly env: NodeJS.ProcessEnv;

  constructor(o: {
    store: GoToSmsStore;
    tenant: string;
    box: SecretBox;
    options: ConfigInput;
    env: NodeJS.ProcessEnv;
  }) {
    this.store = o.store;
    this.tenant = o.tenant;
    this.box = o.box;
    this.options = o.options;
    this.env = o.env;
  }

  /** Which non-store layer (if any) supplies `field`, with its raw value. */
  private fixedValue(field: ConfigField): { source: 'options' | 'env'; value: string } | undefined {
    const fromOption = nonEmpty(this.options[field]);
    if (fromOption) return { source: 'options', value: fromOption };
    const fromEnv = nonEmpty(this.env[ENV_NAMES[field]]);
    if (fromEnv) return { source: 'env', value: fromEnv };
    return undefined;
  }

  private async storedString(field: ConfigField): Promise<string | undefined> {
    const v = await this.store.get(this.tenant, storeKey(field));
    return typeof v === 'string' && v !== '' ? v : undefined;
  }

  async resolve(): Promise<ResolvedConfig> {
    const values: Partial<Record<ConfigField, string>> = {};
    const sources = {} as Record<ConfigField, Source>;
    let credentialsUnreadable = false;
    let invalidFromNumber = false;

    for (const field of FIELDS) {
      const fixed = this.fixedValue(field);
      let value: string | undefined;
      if (fixed) {
        sources[field] = fixed.source;
        value = fixed.value;
      } else {
        value = await this.storedString(field);
        sources[field] = value === undefined ? 'unset' : 'store';
      }

      if (value !== undefined && field === 'fromNumber' && fixed) {
        // Stored numbers were normalized on save; config-supplied ones need it now.
        const normalized = normalizePhone(value);
        if (normalized === null) invalidFromNumber = true;
        value = normalized ?? undefined;
      } else if (value !== undefined && field === 'clientSecret' && !fixed) {
        try {
          value = this.box.open(value);
        } catch (err) {
          if (!(err instanceof DecryptError)) throw err;
          credentialsUnreadable = true;
          value = undefined;
        }
      }
      if (value !== undefined) values[field] = value;
    }

    return {
      ...values,
      sources,
      credentialsUnreadable,
      ...(invalidFromNumber ? { invalidFromNumber: true as const } : {}),
    };
  }

  /**
   * Persist `patch` to the store. The whole patch is validated before anything is written.
   * An empty clientSecret means "keep the stored one" (the UI never echoes it back).
   */
  async save(patch: Partial<Record<ConfigField, string>>): Promise<void> {
    const writes: Array<[ConfigField, string]> = [];
    for (const field of FIELDS) {
      const raw = patch[field];
      if (raw === undefined) continue;
      if (field === 'clientSecret' && raw === '') continue;

      const fixed = this.fixedValue(field);
      if (fixed) {
        throw new GoToSmsError(
          `${field} is set by config (${fixed.source === 'options' ? 'options' : 'env'}) and can't be changed here`,
          'locked',
        );
      }

      let value = raw;
      if (field === 'fromNumber' && raw !== '') {
        const normalized = normalizePhone(raw);
        if (normalized === null) {
          throw new GoToSmsError(`"${raw}" is not a valid phone number`, 'invalid_number');
        }
        value = normalized;
      }
      writes.push([field, value]);
    }

    for (const [field, value] of writes) {
      if (value === '') await this.store.delete(this.tenant, storeKey(field));
      else
        await this.store.set(
          this.tenant,
          storeKey(field),
          field === 'clientSecret' ? this.box.seal(value) : value,
        );
    }
  }

  seedRefreshToken(): string | undefined {
    return nonEmpty(this.options.refreshToken) ?? nonEmpty(this.env.GOTO_REFRESH_TOKEN);
  }
}
