/**
 * Money is integer paise everywhere. It becomes a number exactly once, here, at
 * the last step before rendering.
 *
 * The wire format is the wrinkle: PostgREST serialises `bigint` as a JSON
 * number, so a value arrives as `number` even though the column is int8. At
 * paise scale that is exact — ₹1 crore is 10^9 paise, well inside 2^53, and the
 * pipeline refuses anything larger — but it is normalised through BigInt here
 * anyway so that no arithmetic ever happens on the float.
 */
export type Minor = bigint | string | number | null | undefined;

export function toMinor(value: Minor): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.round(value)) : null;
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? BigInt(trimmed) : null;
}

export function formatRupees(value: Minor): string {
  const minor = toMinor(value);
  if (minor === null) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Number(minor) / 100);
}

/** For an input box, where the owner types rupees. */
export function minorToRupeeInput(value: Minor): string {
  const minor = toMinor(value);
  if (minor === null) return '';
  return (Number(minor) / 100).toString();
}

export function rupeeInputToMinor(text: string): bigint | null {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 100));
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(iso));
}

export function formatAge(days: number | null | undefined): string {
  if (days === null || days === undefined) return '';
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}
