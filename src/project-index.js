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

function languageOf(path) {
  const match = /\.([^.\/]+)$/.exec(path.toLowerCase());
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
  const clean = trim(target).replace(/^\.[\/]/, '').replace(/\\/g, '/');
  if (!clean || (!clean.startsWith('.') && !clean.startsWith('/'))) return null;
  const base = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/') + 1) : '';
  const candidate = safeWorkspacePath((target.startsWith('.') ? base : '') + clean) || null;
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
    if (/^(?:src|app|lib|server|main|index)\\//i.test(file.path) || /^(?:index|main|server)\\./i.test(file.path)) entries.push(file.path);
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

  const result = Object.freeze({
    version: 1,
    revisionId: trim(revisionId) || null,
    contentHash: contentHash.digest('hex'),
    fileCount: fileRecords.length,
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
    entryPoints: [...new Set(entries)].sort().slice(0, 200)
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
    const stem = changed.replace(/\\.[^.]+$/, '');
    return path.startsWith(stem) || path.includes(stem.split('/').pop());
  })).slice(0, max);
}
