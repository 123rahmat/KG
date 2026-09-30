/**
 * A code project as one step sees it: the whole file list, and the files
 * that matter to this step in full. A small project is shown whole; a larger
 * one only as much as the step needs, within a budget.
 *
 * A project bigger than the budget is not read from the top until it runs
 * out. Each file is scored against what the step is about (the request, the
 * design steps' results, a failure being fixed): files it names, files whose
 * names, definitions and text match its words, the modules those import or
 * are imported by, and their tests. The best go in whole, and the rest are
 * listed so the step knows they exist. No model call is spent on choosing.
 */

const STOP = new Set(('the and for with this that from into then than when what which your you our are was were has have had not but all any can '
  + 'add adds added make makes use uses using file files code tests test module modules project change changes fix run runs please need needs '
  + 'should would could will new old one two its also only just more most other some each every where there here how why who them they '
  + 'def class function return import export const let var self true false none null').split(' '));
const CONFIG = /(^|\/)(README(\.md)?|package\.json|pyproject\.toml|setup\.cfg|requirements\.txt|go\.mod|Cargo\.toml)$/i;
const TEST = /(^|\/)(test[^/]*|[^/]*_test)\.[a-z]+$|\.test\.[a-z]+$|(^|\/)tests?\//i;

// Up to this size a project is shown whole; above it, only relevant files.
const WHOLE_PROJECT_CHARS = 15_000;
// A file this relevant (named, matching words, an import of one) is shown.
const RELEVANT_SCORE = 10;

// A definition and its name, in the languages projects are written in.
const DEFINITION = /\b(?:def|class|function|const|let|var|type|interface|struct|enum|trait|fn|func)\s+([A-Za-z_]\w*)/g;

const stem = path => path.split('/').pop().replace(/\.[^.]+$/, '');

/** Words of a text, as identifiers: camelCase and snake_case split, lower case, no stop words. */
export function words(value) {
  return new Set(String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word)));
}

/** Modules a file imports, as candidate paths (Python and JavaScript). */
function importsOf(file, paths) {
  const found = new Set();
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
  for (const match of file.content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
    const module = (match[1] ?? match[2]).replace(/^\.+/, '').replaceAll('.', '/');
    for (const candidate of [`${module}.py`, `${module}/__init__.py`, `${dir}${module}.py`]) if (paths.has(candidate)) found.add(candidate);
  }
  for (const match of file.content.matchAll(/(?:from\s+|require\(\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const joined = (dir + match[1]).split('/').reduce((parts, part) => (part === '..' ? parts.slice(0, -1) : part === '.' ? parts : [...parts, part]), []).join('/');
    for (const candidate of [joined, `${joined}.js`, `${joined}.mjs`, `${joined}.ts`, `${joined}/index.js`]) if (paths.has(candidate)) found.add(candidate);
  }
  return found;
}

/** Each file's relevance to the focus text, highest first. */
export function rankFiles(files, focus = '') {
  const focusText = String(focus ?? '');
  const lower = focusText.toLowerCase();
  const focusWords = words(focusText);
  const paths = new Set(files.map(file => file.path));
  const scores = new Map();
  for (const file of files) {
    let score = 0;
    const base = file.path.split('/').pop().toLowerCase();
    if (lower.includes(file.path.toLowerCase()) || lower.includes(base)) score += 50;
    else if (stem(file.path).length >= 4 && focusWords.has(stem(file.path).toLowerCase())) score += 25;
    const pathWords = words(file.path);
    for (const word of pathWords) if (focusWords.has(word)) score += 8;
    // Each file is read once: the words it uses, and the names it defines.
    const used = words(file.content);
    const defined = words([...file.content.matchAll(DEFINITION)].map(match => match[1]).join(' '));
    let hits = 0;
    for (const word of focusWords) {
      if (used.has(word)) hits += 1;
      if (defined.has(word)) score += 10;
    }
    score += Math.min(20, hits * 2);
    if (CONFIG.test(file.path) && file.content.length < 4000) score += 3;
    scores.set(file.path, score);
  }
  // What the most relevant files import, and what imports them, matters too.
  const top = [...scores].filter(([, score]) => score >= 20).map(([path]) => path);
  const leaders = new Set(top.length ? top : [...scores].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path]) => path));
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const file of files) {
    const imported = importsOf(file, paths);
    if (leaders.has(file.path)) for (const path of imported) scores.set(path, scores.get(path) + 15);
    if ([...imported].some(path => leaders.has(path))) scores.set(file.path, scores.get(file.path) + 12);
  }
  // A module's own tests go with it.
  for (const leader of leaders) {
    const name = stem(leader).toLowerCase();
    for (const file of files) if (TEST.test(file.path) && file.path !== leader && file.path.toLowerCase().includes(name)) scores.set(file.path, scores.get(file.path) + 10);
  }
  return [...scores]
    .map(([path, score]) => ({ path, score, size: byPath.get(path).content.length }))
    .sort((a, b) => b.score - a.score || a.size - b.size);
}

/**
 * The project as text for one step: every path, then the chosen files in
 * full (most relevant first) within `budget` characters, then what was left
 * out. A project that fits is shown whole, in path order.
 */
export function projectView(files, { focus = '', budget = 60_000, skipped = [] } = {}) {
  const list = files.map(file => ({ path: file.path, content: String(file.content ?? '') }));
  const total = list.reduce((sum, file) => sum + file.content.length, 0);
  const head = `Code project: ${list.length} source files${skipped.length ? `; ${skipped.length} other files left out (binary, generated or too large)` : ''}.`;
  const tree = list.map(file => `${file.path} (${file.content.length} chars)`).join('\n');
  const room = Math.max(0, budget - head.length - tree.length - 200);
  // A small project is cheaper to show whole than to choose from; a larger
  // one sends only the files this step needs, however much room is left.
  if (total <= Math.min(room, WHOLE_PROJECT_CHARS) || (total <= room && !String(focus ?? '').trim())) {
    return { text: [head, 'Files:', tree, '', ...list.map(file => `=== ${file.path} ===\n${file.content}`)].join('\n'), shown: list.map(file => file.path), notShown: [] };
  }
  const byPath = new Map(list.map(file => [file.path, file]));
  const shown = [];
  let left = room;
  const ranked = rankFiles(list, focus);
  // Relevant files only; if nothing stands out, the best-ranked few.
  const relevant = ranked.filter(item => item.score >= RELEVANT_SCORE);
  for (const { path, size } of relevant.length ? relevant : ranked.slice(0, 5)) {
    if (size + path.length + 10 > left) continue;
    shown.push(path);
    left -= size + path.length + 10;
  }
  const notShown = list.map(file => file.path).filter(path => !shown.includes(path));
  return {
    text: [
      head,
      `Only the ${shown.length} files relevant to this step are shown in full; the other ${notShown.length} are listed only and stay as they are unless you change them.`,
      'Files:', tree, '',
      ...shown.map(path => `=== ${path} ===\n${byPath.get(path).content}`)
    ].join('\n'),
    shown,
    notShown
  };
}
