/**
 * Pull one JSON object out of model text. Models wrap JSON in prose or code
 * fences; the result is still untrusted and must be validated by the caller.
 */
export function parseJsonObject(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  for (const candidate of [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], raw.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}
