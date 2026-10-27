// Account and sending-number discovery: feeds the setup page's dropdowns.
// Modeled on party-invites listAccounts and swu-ideas listNumbers.
import type { GoToHttp } from './http.js';
import { normalizePhone } from './phone.js';

export interface GoToAccount {
  key: string;
  name: string;
}
export interface GoToNumber {
  number: string;
  name: string;
  accountKey: string;
  smsEnabled?: boolean;
}

const SCIM_GETGO = 'urn:scim:schemas:extension:getgo:1.0';
const PAGE_SIZE = '100';
const MAX_PAGES = 50;

interface MeResponse {
  [SCIM_GETGO]?: { accounts?: Array<{ value?: string; display?: string }> };
}
interface NumbersPage {
  items?: Array<{
    number?: string;
    name?: string;
    callerIdName?: string;
    smsEnabled?: boolean;
  }>;
  nextPageMarker?: string;
}

/** The GoTo accounts this login can act for. Accounts without a `value` are skipped. */
export async function listAccounts(http: GoToHttp): Promise<GoToAccount[]> {
  const me = await http.json<MeResponse>('GET', '/identity/v1/Users/me');
  const accounts: GoToAccount[] = [];
  for (const a of me[SCIM_GETGO]?.accounts ?? []) {
    if (a.value) accounts.push({ key: a.value, name: a.display || a.value });
  }
  return accounts;
}

/** Phone numbers on one account, in first-seen order, de-duplicated by E.164 number. */
export async function listNumbers(http: GoToHttp, accountKey: string): Promise<GoToNumber[]> {
  const found = new Map<string, GoToNumber>();
  let marker: string | undefined;
  // The cap only guards against a marker that never ends. Hitting it returns what we have
  // rather than throwing: a partial list still lets the admin pick a number.
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await http.json<NumbersPage>('GET', '/voice-admin/v1/phone-numbers', undefined, {
      query: { accountKey, pageSize: PAGE_SIZE, ...(marker ? { pageMarker: marker } : {}) },
    });
    for (const item of res.items ?? []) {
      // Normalization is the filter: anything that isn't a phone number is skipped silently.
      const number = normalizePhone(item.number ?? '');
      if (!number || found.has(number)) continue;
      // GoTo often puts the number itself in `name`; that's not a useful label.
      const name =
        item.callerIdName || (item.name && normalizePhone(item.name) !== number ? item.name : '');
      found.set(number, {
        number,
        name,
        accountKey,
        ...(item.smsEnabled === undefined ? {} : { smsEnabled: item.smsEnabled }),
      });
    }
    marker = res.nextPageMarker || undefined;
    if (!marker) break;
  }
  return [...found.values()];
}
