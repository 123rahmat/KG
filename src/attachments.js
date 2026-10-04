/**
 * Attached files as the AI sees them: text for documents and tables, the
 * image itself for pictures. Access is checked on every read (objects.read);
 * only the parsing is cached, keyed by the file's content digest, so a
 * changed file is read again and one workspace never sees another's cache.
 */

import { readDocumentIsolated } from './document-runner.js';
import { projectView } from './project-view.js';
import { isSensitiveWorkspacePath } from './workspace-path.js';

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

function attachmentPriority(file, focus = '') {
  const name = String(file?.name ?? '').toLowerCase();
  const value = String(focus ?? '').toLowerCase();
  const words = new Set(value.split(/[^a-z0-9]+/).filter(word => word.length >= 3));
  let score = 0;
  for (const word of words) if (name.includes(word)) score += 5;

  const codeFocus = /\b(?:code|coding|debug|program|software|repository|repo|function|class|test|script|implementation|bug|refactor)\b/.test(value);
  const researchFocus = /\b(?:research|paper|study|literature|citation|source|evidence|reference|review|investigate|current|latest)\b/.test(value);
  const visualFocus = /\b(?:image|diagram|visual|design|canvas|figure|photo|screenshot|presentation|slide)\b/.test(value);
  const dataFocus = /\b(?:data|dataset|spreadsheet|table|csv|xlsx|budget|metrics|statistics|calculate|analysis)\b/.test(value);

  const format = String(file?.format ?? '').toLowerCase();
  const archiveKind = String(file?.archiveKind ?? '').toLowerCase();
  if (codeFocus && (format === 'project' || archiveKind === 'code-project' || /\.(?:py|js|ts|tsx|jsx|go|rs|java|c|cpp|cs|rb|php|swift|sql|sh|html|css|json)$/i.test(name))) score += 4;
  if (researchFocus && (archiveKind === 'research-bundle' || /\.(?:pdf|docx|pptx)$/i.test(name))) score += 4;
  if (visualFocus && /\.(?:png|jpe?g|webp|gif)$/i.test(name)) score += 4;
  if (dataFocus && /\.(?:csv|xlsx|tsv)$/i.test(name)) score += 4;
  if (archiveKind === 'mixed-bundle') score += 1;
  return score;
}

export async function attachmentContext(objects, scope, attachments, { maxChars = 60_000, maxImages = 4, focus = '', overlay = null } = {}) {
  let overlaid = false;
  const singles = [];
  const files = [];
  const images = [];
  let budget = maxChars;
  const orderedAttachments = [...(Array.isArray(attachments) ? attachments : [])]
    .sort((a, b) => attachmentPriority(b, focus) - attachmentPriority(a, focus));
  for (const file of orderedAttachments) {
    if (!file.readable) {
      files.push({ name: file.name, readable: false, note: 'This file type cannot be read; ask the person what it contains, or use a tool that can.' });
      continue;
    }
    const read = await readAttachment(objects, scope, file);
    if (read.error) { files.push({ name: file.name, readable: false, note: read.error }); continue; }
    if (isSensitiveWorkspacePath(file.name)) {
      files.push({ name: file.name, readable: false, note: 'Sensitive credential-bearing files are never sent to the AI model.' });
      continue;
    }
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
    if (read.format === 'bundle' && Array.isArray(read.items)) {
      const view = archiveView(read.items, focus, budget);
      const bundleImages = view.shown
        .filter(item => item?.kind === 'image' && item?.image && images.length < maxImages)
        .map(item => item.image);
      images.push(...bundleImages.slice(0, Math.max(0, maxImages - images.length)));
      const imagePaths = new Set(view.shown.filter(item => item?.kind === 'image').map(item => item?.path));
      const imageText = view.shown
        .filter(item => item?.kind !== 'image' || !imagePaths.has(item?.path))
        .map(item => `=== ${item.path} [${item.format}] ===${item.text ? '\\n' + item.text : ''}`)
        .join('\\n');
      files.push({
        name: file.name,
        readable: true,
        kind: 'bundle',
        format: 'bundle',
        archiveKind: read.archiveKind,
        truncated: view.notShown.length > 0,
        text: imageText || `Archive contains ${read.items.length} readable items.`,
        ...(view.notShown.length ? { notShown: view.notShown.length } : {}),
        ...(read.skipped?.length ? { skipped: read.skipped.slice(0, 50) } : {})
      });
      budget -= Math.min(imageText.length, budget);
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
function archiveView(items, focus = '', budget = 60_000) {
  const list = Array.isArray(items) ? items : [];
  const focusWords = new Set(String(focus ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3));
  const score = item => {
    const name = String(item?.path ?? item?.name ?? '').toLowerCase();
    let value = 0;
    for (const word of focusWords) if (name.includes(word)) value += 5;
    if (item?.format === 'pdf' || item?.format === 'docx' || item?.format === 'pptx' || item?.format === 'xlsx') value += 2;
    return value;
  };
  const ranked = [...list].sort((a, b) => score(b) - score(a) || String(a?.path ?? '').localeCompare(String(b?.path ?? '')));
  const shown = [];
  let left = Math.max(0, Number(budget) || 0);
  for (const item of ranked) {
    const body = String(item?.text ?? '');
    const line = `=== ${item?.path ?? item?.name ?? 'item'} [${item?.format ?? 'unknown'}] ===${body ? '\\n' + body : ''}`;
    if (line.length + 1 > left) continue;
    shown.push(item);
    left -= line.length + 1;
  }
  return {
    text: shown.length ? shown.map(item => `=== ${item?.path ?? item?.name ?? 'item'} [${item?.format ?? 'unknown'}] ===${item?.text ? '\\n' + item.text : ''}`).join('\\n')
      : 'No archive item content fits the current context budget; inspect a specific item as needed.',
    shown,
    notShown: ranked.filter(item => !shown.includes(item))
  };
}

const CODE_FILE = /\.(py|pyi|js|mjs|cjs|jsx|ts|tsx|json|toml|cfg|ini|ya?ml|txt|md|csv|tsv|sql|xml|html|css|go|mod|sum|rs|lock|java|kts?|gradle|c|cc|cxx|cpp|h|hh|hpp)$/i;

/**
 * The project the person attached, as whole files for the sandbox:
 * a zipped project's source files, plus any code files attached on their
 * own. Nothing is cut to a prompt budget here: this is what runs.
 */
export async function projectFiles(objects, scope, attachments, { overlay = null } = {}) {
  const files = new Map();
  const origins = new Map();
  const addFile = (path, content, origin) => {
    if (!path || isSensitiveWorkspacePath(path)) return;
    const value = String(content ?? '');
    const prior = files.get(path);
    if (prior !== undefined && prior !== value) {
      const error = new Error(`Combined Code Workspace inputs contain conflicting versions of ${path}. Keep one version or make the file contents match.`);
      error.code = 'workspace-file-conflict';
      error.path = path;
      error.origins = [origins.get(path), origin].filter(Boolean);
      throw error;
    }
    if (prior === undefined) {
      files.set(path, value);
      origins.set(path, origin);
    }
  };
  for (const file of Array.isArray(attachments) ? attachments : []) {
    if (!file.readable) continue;
    const read = await readAttachment(objects, scope, file);
    if (read.error) continue;
    const origin = String(file.name ?? file.id ?? 'attached input');
    if (read.format === 'project') {
      for (const item of read.files ?? []) addFile(item.path, item.content, origin);
    } else if (['text', 'csv'].includes(read.format) && CODE_FILE.test(String(file.name)) && !read.truncated) {
      const name = String(file.name).split('/').pop();
      addFile(name, read.text ?? '', origin);
    }
  }
  return withOverlay([...files].map(([path, content]) => ({ path, content })), overlay);
}
