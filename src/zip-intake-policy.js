/**
 * Pure ZIP intake preflight. Operates on metadata returned by a trusted ZIP parser.
 * It does not extract entries, grant permissions, or select a workspace for the user.
 */
const CODE = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle|dockerfile|src\/|tests?\/)|\.(?:js|jsx|ts|tsx|py|rs|go|java|kt|c|cpp|h|swift|cs)$/i;
const RESEARCH = /(?:^|\/)(?:references?\/|sources?\/|bibliography\.(?:bib|json)|literature\/)|\.(?:bib|ris|enw)$/i;
const DOCUMENT = /\.(?:pdf|docx?|pptx?|xlsx?|csv|txt|md|json)$/i;
const clampInt = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
export const ZIP_LIMITS = Object.freeze({
  maxEntries: 2000, maxExpandedBytes: 512 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024, maxCompressionRatio: 100
});

export function inspectZipManifest(entries, limits = ZIP_LIMITS) {
  if (!Array.isArray(entries)) return { accepted: false, reason: 'invalid-manifest' };
  if (entries.length > limits.maxEntries) return { accepted: false, reason: 'too-many-entries' };
  let expandedBytes = 0;
  let code = 0; let research = 0; let documents = 0;
  const names = new Set();
  for (const entry of entries) {
    const name = entry?.name;
    const parts = typeof name === 'string' ? name.split('/') : [];
    const directory = typeof name === 'string' && name.endsWith('/');
    const pathParts = directory ? parts.slice(0, -1) : parts;
    const normalized = typeof name === 'string' ? name.normalize('NFC').toLowerCase() : '';
    if (typeof name !== 'string' || !name || name.includes('\\')
        || name.includes('\0') || name.startsWith('/')
        || /^[A-Za-z]:/.test(name)
        || pathParts.some(part => part === '..' || part === '.' || part === '')
        || names.has(normalized)) {
      return { accepted: false, reason: 'unsafe-or-duplicate-path' };
    }
    names.add(normalized);
    // Symbolic links and special files may escape the extraction sandbox.
    if (entry.type && !['file', 'directory'].includes(entry.type)) return { accepted: false, reason: 'unsupported-entry-type' };
    const size = clampInt(entry.uncompressedSize);
    const compressed = clampInt(entry.compressedSize);
    if (size === null || compressed === null) return { accepted: false, reason: 'invalid-entry-size' };
    if (size > limits.maxEntryBytes) return { accepted: false, reason: 'entry-too-large' };
    if (size > 0 && (!compressed || size / compressed > limits.maxCompressionRatio)) {
      return { accepted: false, reason: 'compression-ratio-exceeded' };
    }
    expandedBytes += size;
    if (expandedBytes > limits.maxExpandedBytes) return { accepted: false, reason: 'expanded-size-exceeded' };
    if (name.endsWith('/')) continue;
    if (CODE.test(name)) code += 1;
    if (RESEARCH.test(name)) research += 1;
    if (DOCUMENT.test(name)) documents += 1;
  }
  const kind = code > 0 && research > 0 ? 'mixed'
    : code > 0 ? 'code'
      : research > 0 ? 'research'
        : documents > 0 ? 'documents' : 'general';
  return Object.freeze({
    accepted: true, kind, entryCount: entries.length, expandedBytes,
    suggestedWorkspace: kind === 'code' ? 'code'
      : kind === 'research' ? 'research' : null,
    requiresUserConfirmation: true
  });
}
