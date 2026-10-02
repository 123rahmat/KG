/**
 * Deterministic project intelligence.
 *
 * This index is deliberately dependency-light: it extracts the structural
 * facts a coding agent repeatedly rediscovers (files, symbols, imports,
 * exports, tests and local dependencies) without spending model tokens.
 * Parsing is conservative and never treated as a proof of correctness.
 */

import crypto from 'node:crypto';
import { classifyWorkspaceFile, normalizeWorkspaceFiles, safeWorkspacePath } from './code-workspace.js';

const text = value => String(value ?? '');
const trim = value => text(value).trim();

const MAX_SYMBOLS = 20_000;
const MAX_IMPORTS = 30_000;
const MAX_TESTS = 5_000;

const INDEX_CACHE_LIMIT = 48;
const indexCache = new Map();

const EXTENSIONS = Object.freeze({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', cs: 'csharp',
  rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  sql: 'sql', c: 'c', cc: 'cpp', cxx: 'cpp', cpp: 'cpp', h: 'c',
  hpp: 'cpp', sh: 'shell'
});

const CONFIG_NAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'vite.config.js',
  'vite.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.ts',
  'pyproject.toml', 'requirements.txt', 'go.mod', 'cargo.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile'
]);

const IDENT = '[A-Za-z_$][A-Za-z0-9_$-]*';
const PROJECT_SCALE_LIMITS = Object.freeze({
  small: { files: 50, bytes: 1_000_000 },
  medium: { files: 500, bytes: 10_000_000 },
  large: { files: 5_000, bytes: 100_000_000 }
});

const directoryOf = path => {
  const parts = safeWorkspacePath(path)?.split('/') ?? [];
  parts.pop();
  return parts.join('/');
};

function directoryAncestors(path) {
  const parts = text(path).split('/').filter(Boolean);
  const result = [''];
  let current = '';
  for (const part of parts) {
    current = current ? current + '/' + part : part;
    result.push(current);
  }
  return result;
}

function projectSizeClass(fileCount, bytes) {
  const count = Number(fileCount) || 0;
  const size = Number(bytes) || 0;
  if (count <= PROJECT_SCALE_LIMITS.small.files && size <= PROJECT_SCALE_LIMITS.small.bytes) return 'small';
  if (count <= PROJECT_SCALE_LIMITS.medium.files && size <= PROJECT_SCALE_LIMITS.medium.bytes) return 'medium';
  if (count <= PROJECT_SCALE_LIMITS.large.files && size <= PROJECT_SCALE_LIMITS.large.bytes) return 'large';
  return 'very-large';
}

/**
 * Deterministic hierarchical repository intelligence. Directory digests are
 * derived from direct file digests and child-directory digests, so a caller
 * can scope a huge repository without loading all source text into a model.
 */
export function buildProjectHierarchy(fileRecords = []) {
  const nodes = new Map();
  const ensure = path => {
    const key = text(path);
    if (!nodes.has(key)) nodes.set(key, {
      path: key, depth: key ? key.split('/').length : 0,
      fileCount: 0, bytes: 0, files: [], children: new Set()
    });
    return nodes.get(key);
  };
  ensure('');

  for (const file of Array.isArray(fileRecords) ? fileRecords : []) {
    const path = safeWorkspacePath(file?.path);
    if (!path) continue;
    const ancestors = directoryAncestors(path);
    for (let i = 0; i < ancestors.length; i += 1) {
      const node = ensure(ancestors[i]);
      node.fileCount += 1;
      node.bytes += Math.max(0, Number(file?.bytes) || 0);
      if (i < ancestors.length - 1) node.children.add(ancestors[i + 1]);
    }
    ensure(directoryOf(path)).files.push({
      path, digest: text(file?.digest), bytes: Math.max(0, Number(file?.bytes) || 0)
    });
  }

  const digestCache = new Map();
  const subtreeDigest = path => {
    if (digestCache.has(path)) return digestCache.get(path);
    const node = nodes.get(path);
    if (!node) return crypto.createHash('sha256').update('', 'utf8').digest('hex');
    const hash = crypto.createHash('sha256');
    for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      hash.update('f\\0').update(file.path).update('\\0').update(file.digest).update('\\0');
    }
    for (const child of [...node.children].sort()) {
      hash.update('d\\0').update(child).update('\\0').update(subtreeDigest(child)).update('\\0');
    }
    const digest = hash.digest('hex');
    digestCache.set(path, digest);
    return digest;
  };

  const directories = [...nodes.values()]
    .map(node => Object.freeze({
      path: node.path, depth: node.depth, fileCount: node.fileCount,
      bytes: node.bytes, digest: subtreeDigest(node.path)
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const root = directories.find(item => item.path === '') ?? {
    path: '', depth: 0, fileCount: 0, bytes: 0, digest: subtreeDigest('')
  };
  return Object.freeze({
    version: 1,
    scale: projectSizeClass(root.fileCount, root.bytes),
    root,
    directories
  });
}

export function projectScale(index) {
  return text(index?.hierarchy?.scale) || projectSizeClass(index?.fileCount, index?.totals?.bytes);
}

/** Return directory-level scope for a coding task; file contents remain external. */
export function hierarchicalProjectScope(index, changedPaths = [], { query = '', maxSubtrees = 12 } = {}) {
  const directories = Array.isArray(index?.hierarchy?.directories) ? index.hierarchy.directories : [];
  if (!directories.length) return { scale: projectScale(index), subtrees: [], changedSubtrees: [] };

  const impacted = impactClosure(index, changedPaths, { maxFiles: 500 });
  const targets = [...new Set([
    ...(Array.isArray(changedPaths) ? changedPaths : []), ...impacted
  ].map(safeWorkspacePath).filter(Boolean))];
  const terms = [...new Set(trim(query).toLowerCase().match(/[a-zA-Z0-9_$-]{2,}/g) ?? [])];
  const scores = new Map(directories.map(node => [node.path, 0]));

  for (const path of targets) {
    const ancestors = directoryAncestors(path);
    for (const ancestor of ancestors.slice(0, -1)) {
      if (scores.has(ancestor)) {
        scores.set(ancestor, scores.get(ancestor) + (ancestor === directoryOf(path) ? 8 : 3));
      }
    }
  }
  for (const node of directories) {
    const lower = node.path.toLowerCase();
    scores.set(node.path, (scores.get(node.path) ?? 0)
      + terms.reduce((sum, term) => sum + (lower.includes(term) ? 4 : 0), 0));
  }

  const ranked = directories
    .map(node => ({ ...node, score: scores.get(node.path) ?? 0 }))
    .filter(node => node.score > 0)
    .sort((a, b) => b.score - a.score || b.fileCount - a.fileCount || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, Math.min(50, Number(maxSubtrees) || 12)));
  return {
    scale: projectScale(index),
    root: index.hierarchy.root,
    subtrees: ranked.map(({ score: _score, ...node }) => node),
    changedSubtrees: [...new Set(targets.map(directoryOf).filter(Boolean))].sort()
  };
}


function languageOf(path) {
  const match = /\.([^./]+)$/.exec(path.toLowerCase());
  return match ? EXTENSIONS[match[1]] ?? null : null;
}

function lineNumber(textValue, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (textValue.charCodeAt(i) === 10) line += 1;
  return line;
}

function symbolKindFromName(name, fallback) {
  if (/^(?:get|set|is|has|can|should)[A-Z_$]/.test(name)) return 'accessor';
  return fallback;
}

function extractSymbols(content, language) {
  const patterns = {
    javascript: [
      { re: new RegExp('\\b(?:export\\s+)?(?:async\\s+)?function\\s+(' + IDENT + ')\\s*\\(', 'g'), kind: 'function' },
      { re: new RegExp('\\bclass\\s+(' + IDENT + ')\\b', 'g'), kind: 'class' },
      { re: new RegExp('\\b(?:export\\s+)?(?:const|let|var)\\s+(' + IDENT + ')\\s*=\\s*(?:async\\s*)?(?:function|\\([^)]*\\)\\s*=>|[^;\\n]+)', 'g'), kind: 'variable' },
      { re: new RegExp('\\b(?:export\\s+)?(?:interface|type|enum)\\s+(' + IDENT + ')\\b', 'g'), kind: 'type' },
      { re: new RegExp('\\b(?:public|private|protected|static|async|get|set)?\\s*(' + IDENT + ')\\s*\\([^\\n)]*\\)\\s*\\{', 'g'), kind: 'method' }
    ],
    typescript: [],
    python: [
      { re: new RegExp('^\\s*(?:async\\s+)?def\\s+(' + IDENT + ')\\s*\\(', 'gm'), kind: 'function' },
      { re: new RegExp('^\\s*class\\s+(' + IDENT + ')\\b', 'gm'), kind: 'class' }
    ],
    go: [
      { re: new RegExp('\\bfunc\\s+(?:\\([^)]*\\)\\s*)?(' + IDENT + ')\\s*\\(', 'g'), kind: 'function' },
      { re: new RegExp('\\btype\\s+(' + IDENT + ')\\s+(?:struct|interface)\\b', 'g'), kind: 'type' }
    ],
    rust: [
      { re: new RegExp('\\b(?:pub\\s+)?(?:async\\s+)?fn\\s+(' + IDENT + ')\\s*\\(', 'g'), kind: 'function' },
      { re: new RegExp('\\b(?:pub\\s+)?struct\\s+(' + IDENT + ')\\b', 'g'), kind: 'class' },
      { re: new RegExp('\\b(?:pub\\s+)?enum\\s+(' + IDENT + ')\\b', 'g'), kind: 'type' },
      { re: new RegExp('\\b(?:pub\\s+)?trait\\s+(' + IDENT + ')\\b', 'g'), kind: 'interface' }
    ],
    java: [
      { re: new RegExp('\\bclass\\s+(' + IDENT + ')\\b', 'g'), kind: 'class' },
      { re: new RegExp('\\b(?:public|private|protected|static|final|abstract|synchronized|native|default|\\s)*\\s+(' + IDENT + ')\\s*\\([^\\n)]*\\)\\s*\\{', 'g'), kind: 'method' }
    ],
    csharp: [
      { re: new RegExp('\\b(?:class|record|struct|interface|enum)\\s+(' + IDENT + ')\\b', 'g'), kind: 'type' },
      { re: new RegExp('\\b(?:public|private|protected|internal|static|async|virtual|override|sealed|partial)\\s+[A-Za-z0-9_<>?,\\[\\]]+\\s+(' + IDENT + ')\\s*\\([^\\n)]*\\)', 'g'), kind: 'method' }
    ],
    ruby: [
      { re: new RegExp('^\\s*def\\s+(' + IDENT + ')', 'gm'), kind: 'function' },
      { re: new RegExp('^\\s*class\\s+(' + IDENT + ')', 'gm'), kind: 'class' }
    ],
    php: [
      { re: new RegExp('\\bfunction\\s+&?\\s*(' + IDENT + ')\\s*\\(', 'g'), kind: 'function' },
      { re: new RegExp('\\bclass\\s+(' + IDENT + ')\\b', 'g'), kind: 'class' }
    ],
    swift: [
      { re: new RegExp('\\bfunc\\s+(' + IDENT + ')\\s*\\(', 'g'), kind: 'function' },
      { re: new RegExp('\\b(?:class|struct|enum|protocol)\\s+(' + IDENT + ')\\b', 'g'), kind: 'type' }
    ],
    kotlin: [
      { re: new RegExp('\\bfun\\s+(' + IDENT + ')\\s*\\(', 'g'), kind: 'function' },
      { re: new RegExp('\\b(?:class|data\\s+class|object|interface|enum\\s+class)\\s+(' + IDENT + ')\\b', 'g'), kind: 'type' }
    ],
    c: [
      { re: new RegExp('^\\s*[A-Za-z_][A-Za-z0-9_ *&]*\\s+(' + IDENT + ')\\s*\\([^;{}]*\\)\\s*\\{', 'gm'), kind: 'function' }
    ],
    cpp: [
      { re: new RegExp('\\b(?:class|struct|enum)\\s+(' + IDENT + ')\\b', 'g'), kind: 'type' },
      { re: new RegExp('^\\s*[A-Za-z_][A-Za-z0-9_ :*&<>]*\\s+(' + IDENT + ')\\s*\\([^;{}]*\\)\\s*\\{', 'gm'), kind: 'function' }
    ]
  };
  patterns.typescript = patterns.javascript.slice(0, -1).concat(patterns.javascript[3]);
  const list = patterns[language] ?? [];
  const symbols = [];
  const seen = new Set();
  for (const { re, kind } of list) {
    let match;
    while ((match = re.exec(content)) && symbols.length < MAX_SYMBOLS) {
      const name = trim(match[1]);
      if (!name) continue;
      const key = name + ':' + lineNumber(content, match.index);
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({
        name,
        kind: symbolKindFromName(name, kind),
        line: lineNumber(content, match.index)
      });
    }
  }
  return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function extractImports(content, language) {
  const patterns = {
    javascript: [
      /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bexport\s+[^;]*?\s+from\s+['"]([^'"]+)['"]/g
    ],
    typescript: [],
    python: [
      /^\s*import\s+([A-Za-z0-9_./-]+)/gm,
      /^\s*from\s+([A-Za-z0-9_./-]+)\s+import\s+/gm
    ],
    go: [/\bimport\s+(?:\(\s*)?['"]([^'"]+)['"]/g],
    rust: [/\buse\s+(?:crate::|self::|super::)?([A-Za-z0-9_:/.-]+)/g],
    java: [/^\s*import\s+([A-Za-z0-9_.-]+)\s*;/gm],
    csharp: [/^\s*using\s+([A-Za-z0-9_.-]+)\s*;/gm],
    ruby: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm],
    php: [/\brequire(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g],
    swift: [/^\s*import\s+([A-Za-z0-9_.-]+)/gm],
    kotlin: [/^\s*import\s+([A-Za-z0-9_.-]+)/gm],
    c: [/^\s*#include\s*[<"]([^>"]+)[>"]/gm],
    cpp: [/^\s*#include\s*[<"]([^>"]+)[>"]/gm]
  };
  patterns.typescript = patterns.javascript;
  const list = patterns[language] ?? [];
  const imports = [];
  const seen = new Set();
  for (const re of list) {
    let match;
    while ((match = re.exec(content)) && imports.length < MAX_IMPORTS) {
      const target = trim(match[1]);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      imports.push(target);
    }
  }
  return imports;
}

function isLikelyTest(path, content) {
  const type = classifyWorkspaceFile(path);
  if (type === 'test') return true;
  const lower = text(content).toLowerCase();
  return /\b(?:describe|it|test|pytest|unittest|#\[test\]|@test)\b/.test(lower);
}

function isConfig(path) {
  return CONFIG_NAMES.has(path.toLowerCase().split('/').pop());
}

function resolveLocalImport(filePath, target, files) {
  const raw = trim(target).replace(/\\/g, '/');
  const relative = raw.startsWith('./') || raw.startsWith('../');
  if (!raw || (!relative && !raw.startsWith('/'))) return null;
  const clean = raw.startsWith('./') ? raw.slice(2) : raw;
  const base = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/') + 1) : '';
  const candidate = safeWorkspacePath((relative ? base : '') + clean) || null;
  if (!candidate) return null;
  const options = [
    candidate,
    ...(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java'].map(ext => candidate.endsWith(ext) ? candidate : candidate + ext)),
    candidate.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '/index.$1')
  ];
  const available = new Set(files.map(file => file.path));
  return options.find(path => available.has(path)) ?? null;
}

function fileDigest(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function parseJsonFile(files, path) {
  const file = files.find(item => item.path === path);
  if (!file) return null;
  try { return JSON.parse(file.content); } catch { return null; }
}

function projectProfile(files) {
  const paths = new Set(files.map(file => file.path));
  const packageJson = parseJsonFile(files, 'package.json');
  const deps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) };
  const known = ['express','fastify','next','react','vue','svelte','koa','hapi','django','flask','fastapi'];
  const frameworks = known.filter(name => Boolean(deps[name]));
  const lock = paths.has('package-lock.json') ? 'npm'
    : paths.has('pnpm-lock.yaml') ? 'pnpm'
      : paths.has('yarn.lock') ? 'yarn'
        : paths.has('bun.lockb') ? 'bun'
          : paths.has('poetry.lock') ? 'poetry'
            : paths.has('uv.lock') ? 'uv' : null;
  const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object'
    ? Object.fromEntries(Object.entries(packageJson.scripts).slice(0, 40).map(([key, value]) => [key, text(value).slice(0, 300)]))
    : {};
  const testCommands = [...new Set([scripts.test, scripts['test:ci'], scripts.check, scripts.verify, scripts.lint].filter(Boolean))].slice(0, 8);
  return {
    packageManager: lock,
    runtime: packageJson?.engines?.node ? 'node' : paths.has('go.mod') ? 'go' : paths.has('Cargo.toml') ? 'rust' : (paths.has('pyproject.toml') || paths.has('requirements.txt') ? 'python' : null),
    frameworks: frameworks.sort(),
    scripts,
    testCommands,
    manifests: ['package.json','pyproject.toml','requirements.txt','go.mod','Cargo.toml','pom.xml','composer.json'].filter(path => paths.has(path))
  };
}

export function buildProjectIndex(files = [], { revisionId = null, maxSymbols = MAX_SYMBOLS } = {}) {
  const normalized = normalizeWorkspaceFiles(files);
  const cacheBasis = normalized.map(file => [file.path, fileDigest(file.content)]);
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({ revisionId: trim(revisionId) || null, maxSymbols, files: cacheBasis })).digest('hex');
  const cached = indexCache.get(cacheKey);
  if (cached) { indexCache.delete(cacheKey); indexCache.set(cacheKey, cached); return cached; }
  const symbols = [];
  const edges = [];
  const imports = [];
  const tests = [];
  const config = [];
  const entries = [];
  const fileRecords = normalized.map(file => {
    const language = languageOf(file.path);
    const digest = fileDigest(file.content);
    const fileSymbols = extractSymbols(file.content, language).slice(0, Math.max(0, maxSymbols - symbols.length));
    const fileImports = extractImports(file.content, language);
    const isTest = isLikelyTest(file.path, file.content);
    const isCfg = isConfig(file.path);
    symbols.push(...fileSymbols.map(item => ({ ...item, path: file.path, language })));
    imports.push(...fileImports.map(target => ({ from: file.path, target })));
    if (isTest) tests.push(file.path);
    if (isCfg) config.push(file.path);
    if (new RegExp('^(?:src|app|lib|server|main|index)/', 'i').test(file.path) || /^(?:index|main|server)\\./i.test(file.path)) entries.push(file.path);
    return Object.freeze({
      path: file.path,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      digest,
      language,
      kind: classifyWorkspaceFile(file.path),
      symbolCount: fileSymbols.length,
      importCount: fileImports.length,
      test: isTest,
      config: isCfg
    });
  });

  for (const edge of imports) {
    const target = resolveLocalImport(edge.from, edge.target, normalized);
    if (target) edges.push({ from: edge.from, to: target, via: edge.target });
  }

  const contentHash = crypto.createHash('sha256');
  for (const file of fileRecords) contentHash.update(file.path).update('\\0').update(file.digest).update('\\0');

  const hierarchy = buildProjectHierarchy(fileRecords);
  const result = Object.freeze({
    version: 1,
    revisionId: trim(revisionId) || null,
    contentHash: contentHash.digest('hex'),
    fileCount: fileRecords.length,
    scale: hierarchy.scale,
    totals: {
      bytes: fileRecords.reduce((sum, item) => sum + item.bytes, 0),
      symbols: symbols.length,
      imports: imports.length,
      dependencies: edges.length,
      tests: tests.length
    },
    files: fileRecords,
    symbols: symbols.slice(0, MAX_SYMBOLS),
    imports: imports.slice(0, MAX_IMPORTS),
    dependencies: edges.slice(0, MAX_IMPORTS),
    tests: [...new Set(tests)].slice(0, MAX_TESTS),
    config: [...new Set(config)].sort().slice(0, 500),
    entryPoints: [...new Set(entries)].sort().slice(0, 200),
    hierarchy,
    profile: projectProfile(normalized)
  });
  indexCache.set(cacheKey, result);
  while (indexCache.size > INDEX_CACHE_LIMIT) indexCache.delete(indexCache.keys().next().value);
  return result;
}

export function impactClosure(index, changedPaths = [], { maxFiles = 80 } = {}) {
  const graph = new Map();
  for (const edge of index?.dependencies ?? []) {
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    if (!graph.has(edge.to)) graph.set(edge.to, new Set());
    graph.get(edge.from).add(edge.to);
    graph.get(edge.to).add(edge.from);
  }
  const selected = new Set((Array.isArray(changedPaths) ? changedPaths : []).map(safeWorkspacePath).filter(Boolean));
  let grew = true;
  while (grew && selected.size < maxFiles) {
    grew = false;
    for (const [path, neighbors] of graph) {
      if (!selected.has(path) && [...neighbors].some(item => selected.has(item))) {
        selected.add(path);
        grew = true;
        if (selected.size >= maxFiles) break;
      }
    }
  }
  return [...selected].sort();
}

export function relatedSymbols(index, query = '', changedPaths = [], { max = 60 } = {}) {
  const queryTerms = [...new Set(trim(query).toLowerCase().match(/[a-zA-Z_$][a-zA-Z0-9_$-]{2,}/g) ?? [])];
  const changed = new Set(changedPaths ?? []);
  return (index?.symbols ?? [])
    .map(symbol => {
      const lower = symbol.name.toLowerCase();
      const exact = queryTerms.includes(lower) ? 1000 : 0;
      const partial = queryTerms.reduce((score, term) => score + (lower.includes(term) ? 140 : 0), 0);
      const changedScore = changed.has(symbol.path) ? 500 : 0;
      const fileScore = changed.has(symbol.path) ? 100 : 0;
      return { ...symbol, score: exact + partial + changedScore + fileScore };
    })
    .filter(item => item.score > 0 || !queryTerms.length)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, max)
    .map(({ score, ...symbol }) => symbol);
}
export function relatedTests(index, changedPaths = [], { max = 40 } = {}) {
  const impacted = new Set(impactClosure(index, changedPaths, { maxFiles: 300 }));
  return (index?.tests ?? []).filter(path => impacted.has(path) || changedPaths.some(changed => {
    const stem = changed.replace(/\.[^.]+$/, '');
    return path.startsWith(stem) || path.includes(stem.split('/').pop());
  })).slice(0, max);
}


/**
 * Explain the breadth of a change before deciding how much verification is
 * justified. This is advisory telemetry, not a permission or pass/fail rule.
 */
export function changeRiskSignals(index, changedPaths = []) {
  const changed = new Set((Array.isArray(changedPaths) ? changedPaths : []).map(safeWorkspacePath).filter(Boolean));
  const dependencies = Array.isArray(index?.dependencies) ? index.dependencies : [];
  const dependents = new Map();

  for (const edge of dependencies) {
    if (!dependents.has(edge.to)) dependents.set(edge.to, new Set());
    dependents.get(edge.to).add(edge.from);
  }

  const impacted = impactClosure(index, [...changed], { maxFiles: 500 });
  const related = relatedTests(index, [...changed], { max: 200 });
  const highFanIn = [...changed].filter(path => (dependents.get(path)?.size ?? 0) >= 4);
  const configChanged = [...changed].some(path => classifyWorkspaceFile(path) === 'config');
  const deleted = [...changed].filter(path => !(index?.files ?? []).some(file => file.path === path));

  let scope = 'targeted';
  if (configChanged || deleted.length || impacted.length > 40) scope = 'full';
  else if (highFanIn.length || impacted.length > 15 || related.length > 12) scope = 'broad';

  return {
    version: 1,
    changedFiles: changed.size,
    impactedFiles: impacted.length,
    relatedTests: related.length,
    highFanInChangedFiles: highFanIn.slice(0, 30),
    configChanged,
    deletedFiles: deleted.length,
    verificationScope: scope,
    confidence: changed.size === 0 ? 0.5 : Math.max(0.2, Math.min(1, 1 - (impacted.length / 250)))
  };
}
