/**
 * Links stored conversation input and output objects without expanding the
 * whole workspace file list. Only DB-authorized objects are shown by the
 * route; filenames and AI-supplied IDs are never authorization.
 */
const key = value => typeof value === 'string' ? value.trim() : '';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const idOf = object => key(typeof object === 'string' ? object : object?.objectId ?? object?.object_id ?? object?.id);
const add = (set, value) => {
  const id = idOf(value);
  if (ID.test(id) && set.size < 2000) set.add(id);
};
const addList = (set, entries) => {
  if (Array.isArray(entries)) for (const value of entries.slice(0, 300)) add(set, value);
};

/** Controlled, recognized output fields only; arbitrary task text isn't a file. */
export function conversationFileLinks(runs = []) {
  const attached = new Set();
  const produced = new Set();
  const runIds = new Set();
  for (const run of (Array.isArray(runs) ? runs : []).slice(0, 100)) {
    if (ID.test(key(run?.id))) runIds.add(run.id);
    addList(attached, run?.adaptation?.attachments);
    addList(produced, run?.adaptation?.generatedArtifacts);
    addList(produced, run?.adaptation?.outputArtifacts);
    for (const task of (Array.isArray(run?.tasks) ? run.tasks : []).slice(0, 200)) {
      const evidence = task?.evidence;
      addList(produced, evidence?.artifacts);
      addList(produced, evidence?.outputArtifacts);
      addList(produced, evidence?.files);
      add(produced, evidence?.artifact);
      add(produced, evidence?.outputObject);
    }
  }
  for (const id of attached) produced.delete(id);
  return {
    attachmentIds: [...attached],
    artifactIds: [...produced],
    runIds: [...runIds]
  };
}

/** Client gets bounded, non-sensitive, display-only metadata. */
export function presentConversationFile(row, attachmentIds) {
  return {
    id: row.id,
    name: row.name || row.id,
    contentType: row.content_type || 'application/octet-stream',
    size: Number(row.size) || 0,
    createdAt: row.created_at,
    category: attachmentIds.has(row.id) || row.type === 'attachment' ? 'attachment' : 'artifact'
  };
}
