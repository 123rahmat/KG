/**
 * Attached files as the AI sees them: text for documents and tables, the
 * image itself for pictures. Access is checked on every read (objects.read);
 * only the parsing is cached, keyed by the file's content digest, so a
 * changed file is read again and one workspace never sees another's cache.
 */

import { readDocumentIsolated } from './document-runner.js';
import { projectView } from './project-view.js';

const CACHE_LIMIT = 64;
const cache = new Map();

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/**
 * One attached file, read for the AI. Returns
 * { name, format, text?, tables?, image?, pages?, truncated?, error? }.
 */
export async function readAttachment(objects, scope, file) {
  const object = scope ? await objects.read(scope, file.id).catch(() => null) : null;
  if (!object) return { name: file.name, format: file.format, error: 'The file is no longer available.' };
  const { metadata, content } = object;
  const key = `${scope.workspaceId}:${metadata.digest}:${metadata.name}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    remember(key, hit);
    return hit;
  }
  let result;
  try {
    const read = await readDocumentIsolated(Buffer.from(content), { name: metadata.name, contentType: metadata.contentType });
    result = { name: metadata.name, ...read };
  } catch (error) {
    result = { name: metadata.name, format: file.format, error: error.message };
  }
  remember(key, result);
  return result;
}

/**
 * All of a run's attachments for one model call: texts within a shared
 * character budget, and up to `maxImages` images to show the model. A code
 * project is shown through `focus` (what this step is about), so a large
 * one gives the step the files that matter to it.
 */
/**
 * A project's files with the later changes laid over them: a changed file
 * replaces its path, a new one is added, and null content deletes it.
 */
export function withOverlay(files, overlay) {
  if (!Array.isArray(overlay) || !overlay.length) return files;
  const merged = new Map((files ?? []).map(file => [file.path, file]));
  for (const change of overlay) {
    if (!change || typeof change.path !== 'string') continue;
    if (change.content === null) merged.delete(change.path);
    else merged.set(change.path, { ...(merged.get(change.path) ?? {}), path: change.path, content: String(change.content) });
  }
  return [...merged.values()];
}

export async function attachmentContext(objects, scope, attachments, { maxChars = 60_000, maxImages = 4, focus = '', overlay = null } = {}) {
  let overlaid = false;
  const singles = [];
  const files = [];
  const images = [];
  let budget = maxChars;
  for (const file of Array.isArray(attachments) ? attachments : []) {
    if (!file.readable) {
      files.push({ name: file.name, readable: false, note: 'This file type cannot be read; ask the person what it contains, or use a tool that can.' });
      continue;
    }
    const read = await readAttachment(objects, scope, file);
    if (read.error) { files.push({ name: file.name, readable: false, note: read.error }); continue; }
    if (read.kind === 'image') {
      if (images.length < maxImages) {
        images.push(read.image);
        files.push({ name: file.name, readable: true, kind: 'image', note: 'Shown to you as an image.' });
      } else files.push({ name: file.name, readable: false, note: `Only ${maxImages} images are shown per step.` });
      continue;
    }
    // A code project larger than the budget shows the files this step needs.
    if (read.format === 'project' && Array.isArray(read.files)) {
      // The latest version of the project (a follow-up's) is what is shown.
      const current = overlaid ? read.files : withOverlay(read.files, overlay);
      overlaid = true;
      const view = projectView(current, { focus, budget, skipped: read.skipped ?? [] });
      files.push({
        name: file.name, readable: true, kind: 'project', format: 'project',
        truncated: view.notShown.length > 0, text: view.text,
        ...(view.notShown.length ? { notShown: view.notShown.length } : {}),
        ...(read.ingestion?.partial ? {
          note: 'This project snapshot is incomplete: ' + (read.ingestion.skippedCount || read.skipped?.length || 0) + ' source files were omitted by the source importer. Do not claim the repository was fully inspected.',
          ingestion: read.ingestion
        } : {})
      });
      budget -= Math.min(view.text.length, budget);
      continue;
    }
    // A single code file a follow-up changed is shown as it is now, the
    // version the sandbox runs.
    const single = ['text', 'csv'].includes(read.format) && CODE_FILE.test(String(file.name)) && !read.truncated;
    if (single && Array.isArray(overlay) && overlay.length) {
      singles.push({ path: String(file.name).split('/').pop(), content: read.text ?? '' });
      continue;
    }
    const textValue = read.text ?? '';
    const note = read.scanned ? 'This PDF looks scanned: it has little or no text layer.' : undefined;
    files.push({
      name: file.name, readable: true, kind: read.kind, format: read.format,
      pages: read.pages, truncated: read.truncated || textValue.length > budget,
      text: textValue.slice(0, Math.max(0, budget)),
      ...(textValue.length > budget ? { more: 'Use the file.read tool with an offset to read the rest.' } : {}),
      ...(note ? { note } : {})
    });
    budget -= Math.min(textValue.length, budget);
  }
  if (singles.length) {
    // Files the follow-up added come with them, unless a project already showed them.
    const current = overlaid
      ? withOverlay(singles, overlay.filter(change => singles.some(file => file.path === change?.path)))
      : withOverlay(singles, overlay);
    const view = projectView(current, { focus, budget, skipped: [] });
    files.push({
      name: 'Your code (latest version)', readable: true, kind: 'project', format: 'project',
      truncated: view.notShown.length > 0, text: view.text,
      ...(view.notShown.length ? { notShown: view.notShown.length } : {})
    });
  }
  return { files, images };
}

// Attached single files that are code a project can run with.
const CODE_FILE = /\.(py|pyi|js|mjs|cjs|jsx|ts|tsx|json|toml|cfg|ini|ya?ml|txt|md|csv|tsv|sql|xml|html|css|go|mod|sum|rs|lock|java|kts?|gradle|c|cc|cxx|cpp|h|hh|hpp)$/i;

/**
 * The project the person attached, as whole files for the sandbox:
 * a zipped project's source files, plus any code files attached on their
 * own. Nothing is cut to a prompt budget here: this is what runs.
 */
export async function projectFiles(objects, scope, attachments, { overlay = null } = {}) {
  const files = new Map();
  for (const file of Array.isArray(attachments) ? attachments : []) {
    if (!file.readable) continue;
    const read = await readAttachment(objects, scope, file);
    if (read.error) continue;
    if (read.format === 'project') for (const item of read.files ?? []) files.set(item.path, item.content);
    else if (['text', 'csv'].includes(read.format) && CODE_FILE.test(String(file.name)) && !read.truncated) files.set(String(file.name).split('/').pop(), read.text ?? '');
  }
  return withOverlay([...files].map(([path, content]) => ({ path, content })), overlay);
}
