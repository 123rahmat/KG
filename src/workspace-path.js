/**
 * One path boundary for every user/model supplied project path.
 *
 * Paths are logical workspace-relative names, never host filesystem paths.
 * Keeping this rule shared by the workflow, project context and sandbox
 * prevents a permissive metadata path from later becoming an executable one.
 */

const PATH = /^(?![./ -])(?!.*\.\.)(?!.*\/[./ -])(?!.*[ /]$)[\p{L}\p{N}._/ +@-]{1,160}$/u;

export function workspacePath(value) {
  const raw = String(value ?? '');
  // Do not silently turn a distinct name into another file by trimming it.
  // This also keeps every persisted/displayed path byte-for-byte identical to
  // the path the sandbox receives.
  return raw === raw.trim() && PATH.test(raw) ? raw : null;
}

export const isWorkspacePath = value => workspacePath(value) !== null;
