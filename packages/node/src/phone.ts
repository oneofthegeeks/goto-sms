// Phone normalisation to E.164. A phone number is a caller's identity for
// keyword handling and dedupe, so loosely formatted input such as
// "(801) 555-0123" or "+1 801-555-0123" must resolve to one canonical form.
//
// Returns null for anything that isn't clearly a phone number rather than
// guessing. Callers treat null as invalid input.

const NANP_COUNTRY_CODE = '1';

// NANP: area code and exchange both start with 2-9. N11 area codes (211, 911…)
// are service codes, never subscriber numbers.
function isValidNanp(tenDigits: string): boolean {
  if (!/^\d{10}$/.test(tenDigits)) return false;
  const area = tenDigits.slice(0, 3);
  const exchange = tenDigits.slice(3, 6);
  if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exchange)) return false;
  if (area[1] === '1' && area[2] === '1') return false;
  return true;
}

export function normalizePhone(raw: string): string | null {
  const text = raw.trim();
  // Only a leading '+' plus digits, whitespace, and the usual separators are
  // allowed. Letters or other symbols make the input invalid rather than being
  // silently stripped (e.g. "call 801-555-0123" or "555-0123 ext 4").
  if (!/^\+?[\d\s().-]+$/.test(text)) return null;

  const hasPlus = text.startsWith('+');
  const digits = text.replace(/\D/g, '');

  // A '+' followed by a non-NANP country code: any length from 8 to 15 digits.
  if (hasPlus && !digits.startsWith(NANP_COUNTRY_CODE)) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  // NANP. "1" followed by ten digits is the country-code form; a bare ten
  // digits is the national form. A '+' must use the country-code form, so
  // "+1" with a wrong length is rejected rather than treated as national.
  const hasCountryCode = digits.length === 11 && digits.startsWith(NANP_COUNTRY_CODE);
  if (hasPlus && !hasCountryCode) return null;
  const national = hasCountryCode ? digits.slice(1) : digits;
  if (!isValidNanp(national)) return null;

  return `+${NANP_COUNTRY_CODE}${national}`;
}
