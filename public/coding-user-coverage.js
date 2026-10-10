/**
 * Read-only rendering model for the user's own engineering acceptance targets.
 * Named verifier outcomes are not execution receipts or proof tests ran.
 */
const label = value => String(value ?? '').replace(/\s+/g,' ').trim().slice(0,240);

export function codingUserCoverage(run) {
  const rows = run?.requirements?.items;
  if (!Array.isArray(rows)) return null;
  const items = rows
    .filter(item => item && item.explicitCoverage === true
      && item.required !== false && item.status !== 'superseded')
    .slice(0,12);
  if (!items.length) return null;
  const checked = items.filter(item => item.status === 'satisfied').length;
  const missing = items.filter(item => item.status !== 'satisfied');
  return Object.freeze({
    total: items.length, checked, remaining: missing.length,
    limited: run?.adaptation?.codingUserNeeds?.coverageLimited === true,
    complete: missing.length === 0,
    label: `${checked} of ${items.length} user-defined checks acknowledged`,
    items: Object.freeze(items.slice(0,7).map(item => Object.freeze({
      text:label(item.requirement),
      status: item.status === 'satisfied' ? 'acknowledged' : 'not-verified'
    }))),
    hidden: Math.max(0,items.length - 7),
    caveat:'Named verifier results, not proof that execution tests passed.'
  });
}
