import { GoToSmsError } from './errors.js';
import { normalizePhone } from './phone.js';
import type { GoToSmsStore, Json } from './store/types.js';

const PREFIX = 'optout:';

export type OptOutSource = 'keyword' | 'admin';

function toE164(number: string): string {
  const e164 = normalizePhone(number);
  if (e164 === null) {
    throw new GoToSmsError(`"${number}" is not a valid phone number`, 'invalid_number');
  }
  return e164;
}

/** Numbers that replied STOP (or an admin added). Stored as `optout:<e164>` = `{ at, source }`. */
export class OptOuts {
  constructor(
    private readonly store: GoToSmsStore,
    private readonly tenant: string,
    private readonly now: () => number,
  ) {}

  async has(e164: string): Promise<boolean> {
    const n = normalizePhone(e164);
    return n !== null && (await this.store.get(this.tenant, PREFIX + n)) !== undefined;
  }

  async add(e164: string, source: OptOutSource): Promise<void> {
    await this.store.set(this.tenant, PREFIX + toE164(e164), {
      at: new Date(this.now()).toISOString(),
      source,
    });
  }

  async remove(e164: string): Promise<void> {
    await this.store.delete(this.tenant, PREFIX + toE164(e164));
  }

  /** Newest first. */
  async list(): Promise<Array<{ number: string; at: string; source: string }>> {
    const field = (v: Json, k: string): string => {
      const x = typeof v === 'object' && v !== null && !Array.isArray(v) ? v[k] : undefined;
      return typeof x === 'string' ? x : '';
    };
    return (await this.store.list(this.tenant, PREFIX))
      .map(({ key, value }) => ({
        number: key.slice(PREFIX.length),
        at: field(value, 'at'),
        source: field(value, 'source'),
      }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }
}
