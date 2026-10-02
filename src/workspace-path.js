/**
 * One canonical boundary for workspace-relative paths.
 *
 * Dotfiles and dot-directories are legitimate project files (for example
 * .gitignore and .github); traversal, absolute paths, control characters and
 * ambiguous separators are not.
 */
const SEGMENT = /^(?![ -])[\p{L}\p{N}._ +@-]+$/u;
const MAX_PATH_LENGTH = 240;
const SENSITIVE_NAME = /^(?:\.env(?:\.(?!example$|sample$|template$)[^/]*)?|\.npmrc|\.netrc|\.pypirc|credentials?(?:\.[^/]*)?|id_rsa(?:\.[^/]*)?|service-account(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx|jks))$/i;

export function workspacePath(value) {
  const raw = String(value ?? '');
  if (!raw || raw !== raw.trim() || raw.length > MAX_PATH_LENGTH) return null;
  if (raw.includes('\0') || raw.includes('\r') || raw.includes('\n')) return null;
  if (raw.startsWith('/') || raw.startsWith('\\')) return null;
  if (raw.includes('//') || raw.includes('\\\\')) return null;
  const parts = raw.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || !SEGMENT.test(part))) return null;
  return raw;
}

export function isSensitiveWorkspacePath(value) {
  const safe = workspacePath(value);
  return Boolean(safe && safe.split('/').some(segment => SENSITIVE_NAME.test(segment)));
}

export const isWorkspacePath = value => workspacePath(value) !== null;
