/**
 * Money is integer paise everywhere, carried as bigint. It becomes a number
 * exactly once, here, at the last step before rendering.
 */
export function formatRupees(minor: bigint | string | null): string {
  if (minor === null) return '—';
  const value = typeof minor === 'string' ? BigInt(minor) : minor;
  const rupees = Number(value) / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(rupees);
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(iso));
}
