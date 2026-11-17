export function issueDays(value) {
  const parsed = Number(value ?? 2);
  const days = Number.isFinite(parsed) ? Math.trunc(parsed) : 2;
  return Math.max(1, Math.min(days, 14));
}
