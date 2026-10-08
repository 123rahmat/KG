/**
 * Read-only, bounded view of the server-owned run_tasks table. The projection
 * is not a queue or a source of execution authority: only RunStore may change
 * real tasks under its transaction, permissions and approval gates.
 */
import { validateOpenWorldGraph } from './open-world-task-graph.js';

const MAX_NODES = 48;
const FINISHED = new Set(['complete', 'skipped']);
const VALID = new Set(['pending', 'running', 'complete', 'skipped', 'blocked', 'failed', 'stale']);
const str = value => String(value ?? '').trim();
const ids = items => [...new Set((Array.isArray(items) ? items : []).map(str).filter(Boolean))];

export function projectPersistedTaskGraph(tasks = [], prior = {}) {
  const previous = validateOpenWorldGraph(prior);
  const ordered = (Array.isArray(tasks) ? tasks : []).filter(item => str(item?.id));
  const allIds = new Set(ordered.map(item => str(item.id)));
  if (allIds.size !== ordered.length) throw new Error('persisted-task-duplicate-id');

  // Keep currently actionable work in the small projection. On extremely
  // long runs, also show the most recent completed context; the DB still owns
  // the complete task graph and the actual scheduling decision.
  const active = ordered.filter(item => !FINISHED.has(item.status));
  const visible = active.slice(0, MAX_NODES);
  if (visible.length < MAX_NODES) {
    const remaining = ordered.filter(item => FINISHED.has(item.status));
    visible.unshift(...remaining.slice(-Math.max(0, MAX_NODES - visible.length)));
  }
  const kept = new Set(visible.map(item => str(item.id)));
  const byId = new Map(ordered.map(item => [str(item.id), item]));
  const nodes = visible.map(task => {
    const missing = ids(task.dependsOn ?? task.depends_on).filter(id => !kept.has(id));
    const unresolved = missing.filter(id => !FINISHED.has(byId.get(id)?.status));
    const rawStatus = str(task.status) || 'pending';
    const status = unresolved.length ? 'blocked' : VALID.has(rawStatus) ? rawStatus : 'blocked';
    const metadata = task.metadata ?? {};
    return {
      id: str(task.id), type: str(task.type) || 'work', status,
      purpose: str(task.purpose).slice(0, 400),
      dependsOn: ids(task.dependsOn ?? task.depends_on).filter(id => kept.has(id)),
      // Capabilities are requirements, not authorizations.
      requires: ids(task.requires),
      metadata: {
        persisted: true,
        // Only verified explicit independence can be shown as parallel.
        parallel: metadata.parallel === true && metadata.parallelEligible === true,
        ...(missing.length ? { archivedPrerequisites: missing.length } : {}),
        ...(unresolved.length ? { unresolvedOutsideWindow: true } : {})
      }
    };
  });
  const archived = Math.max(0, ordered.length - visible.length);
  const material = graph => JSON.stringify({ nodes: graph.nodes, archived: graph.archived ?? 0 });
  const projection = { revision: previous.revision, nodes, archived, total: ordered.length,
    authoritative: 'server-run-tasks', truncated: archived > 0 };
  if (material(projection) !== material(previous)) projection.revision += 1;
  const checked = validateOpenWorldGraph(projection);
  return { ...checked, archived, total: ordered.length, authoritative: projection.authoritative,
    truncated: projection.truncated };
}
