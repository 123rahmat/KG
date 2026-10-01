/**
 * One canonical boundary for workspace-relative paths.
 *
 * Dotfiles and dot-directories are legitimate project files (for example
 * .gitignore and .github); traversal, absolute paths, control characters and
 * ambiguous duplicate separators are not.
 */
const PATH = /^(?=.{1,240}$)(?![\\/])(?!.*[\\/]{2})(?!.*[\u0000\r\n])(?!.*(?:^|\\/)\\.{1,2}(?:\\/|$))[\p{L}\p{N}._/ +@-]+$/u;

export function workspacePath(value) {
  const raw = String(value ?? '');
  return raw === raw.trim() && PATH.test(raw) ? raw : null;
}

export const isWorkspacePath = value => workspacePath(value) !== null;
