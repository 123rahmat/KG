/** Exact or single-ended wildcard rules shared by policy and privacy gates. */
export function policyMatches(rule, value) {
  if (typeof rule !== 'string' || !value) return false;
  return rule === '*' || rule === value
    || (rule.endsWith('*') && value.startsWith(rule.slice(0, -1)))
    || (rule.startsWith('*') && value.endsWith(rule.slice(1)));
}
