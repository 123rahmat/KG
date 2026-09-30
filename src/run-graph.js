/**
 * Edits to a run's server-owned task graph, always inside the caller's
 * transaction: insert tasks and load them.
 */

export async function insertTask(client, runId, { id, position, type, dependsOn = [], requires = [], purpose, metadata = {} }) {
  await client.query(
    `INSERT INTO run_tasks (run_id, id, position, type, status, depends_on, requires, purpose, metadata)
     VALUES ($1, $2, $3, $4, 'pending', $5::jsonb, $6::jsonb, $7, $8::jsonb)`,
    [runId, id, position, type, JSON.stringify(dependsOn), JSON.stringify(requires), purpose, JSON.stringify(metadata)]
  );
}

export async function insertTasks(client, runId, tasks) {
  // One multi-row INSERT rather than a statement per task.
  const columns = 9;
  const values = tasks.flatMap((task, index) => [
    runId, task.id, index, task.type, task.status,
    JSON.stringify(task.dependsOn), JSON.stringify(task.requires), task.purpose,
    JSON.stringify(task.metadata ?? {})
  ]);
  const placeholders = tasks
    .map((_, row) => `(${Array.from({ length: columns }, (_, col) => `$${row * columns + col + 1}`).join(',')})`)
    .join(',');
  await client.query(
    `INSERT INTO run_tasks (run_id, id, position, type, status, depends_on, requires, purpose, metadata)
     VALUES ${placeholders}`,
    values
  );
}

export async function loadTasks(client, runId) {
  const { rows } = await client.query(
    'SELECT * FROM run_tasks WHERE run_id = $1 ORDER BY position',
    [runId]
  );
  return rows.map(row => ({
    id: row.id,
    type: row.type,
    position: row.position,
    status: row.status,
    dependsOn: row.depends_on,
    requires: row.requires,
    purpose: row.purpose,
    metadata: row.metadata ?? {},
    summary: row.summary,
    evidence: row.evidence,
    completedAt: row.completed_at
  }));
}
