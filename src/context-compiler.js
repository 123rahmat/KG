/**
 * Token-efficient coding context compiler.
 *
 * The compiler converts the deterministic project index into the minimum
 * sufficient evidence for one model call. It prefers changed files, affected
 * dependencies, relevant symbols and related tests, then uses bounded source
 * windows. The full project remains available to tools; the model only gets
 * what the current task needs.
 */

import { impactClosure, relatedSymbols, relatedTests, changeRiskSignals, hierarchicalProjectScope, projectScale } from './project-index.js';
import { normalizeWorkspaceFiles, safeWorkspacePath, workspaceContentHash } from './code-workspace.js';
import crypto from 'node:crypto';

const text = value => String(value ?? '');
const clean = value => text(value).trim();

export const CONTEXT_BUDGETS = Object.freeze({
  small: { maxChars: 12_000, maxFiles: 8, snippetLines: 18 },
  standard: { maxChars: 22_000, maxFiles: 14, snippetLines: 26 },
  complex: { maxChars: 34_000, maxFiles: 20, snippetLines: 34 },
  advanced: { maxChars: 44_000, maxFiles: 24, snippetLines: 42 }
});

const CODE_TASKS = new Set(['build-code','test-code','code','prototype','verify-code','review-code','refactor-code','debug-code']);

const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|.*(?:secret|credential|password|passwd|private[-_ ]?key|token).*)$/i;
const INLINE_SECRET = /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\b\s*[:=]\s*["'][^"']{8,}["'])|(authorization\s*[:=]\s*["']bearer\s+[A-Za-z0-9._~+/-]{12,}["'])/gi;
const SECRET_VALUE = /([:=]\s*["'])([^"']+)(["'])/;
function contextSafeContent(path, content) {
  if (SENSITIVE_PATH.test(path)) return '[sensitive file withheld from model context; use approved workspace tools only when exact contents are required]';
  return text(content).replace(INLINE_SECRET, match => match.replace(SECRET_VALUE, '$1[REDACTED]$3'));
}

const cache = new Map();
const CACHE_LIMIT = 96;

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function digest(value) {
  return crypto.createHash('sha256').update(text(value), 'utf8').digest('hex').slice(0, 24);
}

function taskTerms(goal, task, failure = null) {
  return [
    clean(goal), clean(task?.purpose), clean(task?.metadata?.title),
    clean(failure?.message), clean(failure?.stderr), clean(failure?.stdout)
  ].join(' ').toLowerCase().match(/[a-zA-Z_$][a-zA-Z0-9_$-]{2,}/g) ?? [];
}

function scoreFile(file, { changed, impacted, queryTerms, tests, config, symbolPaths = new Set(), subtreePaths = [] }) {
  const lower = file.path.toLowerCase();
  const pathParts = new Set(lower.split(/[\\/._-]+/).filter(Boolean));
  let score = 0;
  if (changed.has(file.path)) score += 5000;
  if (impacted.has(file.path)) score += 1600;
  if (tests.has(file.path)) score += 900;
  if (config.has(file.path)) score += 600;
  if (symbolPaths.has(file.path)) score += 1200;
  if (subtreePaths.some(path => path && (file.path === path || file.path.startsWith(path + '/')))) score += 260;
  for (const term of queryTerms) {
    if (lower.includes(term)) score += 45;
    const parts = term.split(/[_-]+/).filter(part => part.length >= 3);
    score += parts.reduce((sum, part) => sum + (pathParts.has(part) ? 90 : 0), 0);
  }
  score += file.kind === 'code' ? 30 : file.kind === 'test' ? 20 : 0;
  if (file.path.split('/').length <= 2) score += 10;
  return score;
}

function lines(content) {
  return text(content).split(/\r?\n/);
}

function boundedWindows(content, targetLines, radius, maxChars) {
  const source = lines(content);
  if (!source.length) return '';
  const targets = [...new Set(targetLines.filter(line => Number.isInteger(line) && line > 0))].sort((a,b)=>a-b);
  const ranges = [];
  if (!targets.length) {
    const end = Math.min(source.length, Math.max(1, Math.ceil(maxChars / 90)));
    ranges.push([1,end]);
  } else {
    for (const line of targets) {
      const start = Math.max(1, line-radius);
      const end = Math.min(source.length, line+radius);
      const previous = ranges.at(-1);
      if (previous && start <= previous[1] + 2) previous[1] = Math.max(previous[1], end);
      else ranges.push([start,end]);
    }
  }
  let output = '';
  for (const [start,end] of ranges) {
    const section = source.slice(start-1,end).map((value,offset) => String(start+offset).padStart(5,' ') + ' | ' + value).join('\n');
    const candidate = output ? output + '\n...\n' + section : section;
    if (candidate.length > maxChars) break;
    output = candidate;
  }
  return output;
}

function fileSymbols(index, path) {
  return (index?.symbols ?? []).filter(symbol => symbol.path === path).slice(0,40);
}

function fileImports(index, path) {
  return (index?.imports ?? []).filter(item => item.from === path).slice(0,40);
}

function dependenciesFor(index, selected) {
  const set = new Set(selected);
  return (index?.dependencies ?? []).filter(edge => set.has(edge.from) || set.has(edge.to)).slice(0,120);
}

export function isCodeTask(task) {
  return Boolean(task && (CODE_TASKS.has(clean(task.id).toLowerCase()) ||
    CODE_TASKS.has(clean(task.type).toLowerCase()) || task.metadata?.buildPlan === true));
}

export function compileCodeContext({
  files = [], index, goal = '', task = null, changedPaths = [], failure = null,
  previousAttempts = [], scale = 'standard', maxChars = null, maxFiles = null
} = {}) {
  const normalized = normalizeWorkspaceFiles(files);
  if (!normalized.length) return null;
  const defaults = CONTEXT_BUDGETS[scale] ?? CONTEXT_BUDGETS.standard;
  // Overrides cannot turn a single model call into an unbounded project dump.
  // Larger projects are still available through targeted workspace tools.
  const bounded = (value, fallback, minimum, maximum) => {
    const requested = Number(value);
    return Math.min(maximum, Math.max(minimum,
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : fallback));
  };
  const charBudget = bounded(maxChars, defaults.maxChars, 4_000, CONTEXT_BUDGETS.advanced.maxChars);
  const requestedFileBudget = bounded(maxFiles, defaults.maxFiles, 2, CONTEXT_BUDGETS.advanced.maxFiles);
  const totalContentChars = normalized.reduce((sum, file) => sum + String(file.content ?? '').length, 0);
  // Small projects stay whole; large projects stay bounded to the useful budget.
  const fileBudget = totalContentChars <= charBudget
    ? Math.max(requestedFileBudget, normalized.length)
    : requestedFileBudget;
  const changed = new Set(changedPaths.map(safeWorkspacePath).filter(Boolean));
  const impacted = new Set(impactClosure(index, [...changed], { maxFiles: 180 }));
  const terms = taskTerms(goal, task, failure);
  const hierarchyScope = hierarchicalProjectScope(index, [...changed], {
    query: terms.slice(0, 16).join(' '), maxSubtrees: totalContentChars > charBudget ? 16 : 8
  });
  const subtreePaths = (hierarchyScope.subtrees ?? []).map(item => item.path).filter(Boolean);
  const testPaths = new Set(relatedTests(index, [...changed], { max: 80 }));
  const configPaths = new Set(index?.config ?? []);
  const symbolPaths = new Set((index?.symbols ?? [])
    .filter(symbol => terms.some(term => String(symbol.name ?? '').toLowerCase().includes(term.toLowerCase())))
    .map(symbol => symbol.path));
  const ranked = normalized.map(file => ({
    file,
    score: scoreFile(file, { changed, impacted, queryTerms: terms, tests: testPaths, config: configPaths, symbolPaths, subtreePaths })
  })).sort((a,b) => Number(changed.has(b.file.path)) - Number(changed.has(a.file.path))
    || Number(symbolPaths.has(b.file.path)) - Number(symbolPaths.has(a.file.path))
    || b.score - a.score || a.file.path.localeCompare(b.file.path));

  const selected = [];
  const selectedPathSet = new Set();
  const criticalPaths = new Set([...changed, ...symbolPaths]);
  let chars = 0;
  for (const candidate of ranked) {
    if (selected.length >= fileBudget) break;
    const perFile = changed.has(candidate.file.path)
      ? Math.min(9_000, Math.floor(charBudget * 0.36))
      : testPaths.has(candidate.file.path)
        ? Math.min(4_000, Math.floor(charBudget * 0.18))
        : 3_500;
    const symbolLines = fileSymbols(index, candidate.file.path).map(item => item.line);
    const content = boundedWindows(contextSafeContent(candidate.file.path, candidate.file.content), symbolLines, defaults.snippetLines, perFile);
    if (!content) continue;
    const cost = content.length + candidate.file.path.length + 80;
    if (chars + cost > charBudget && selected.length) continue;
    selected.push({
      path: candidate.file.path, kind: candidate.file.kind, language: candidate.file.language,
      digest: candidate.file.digest, score: candidate.score,
      symbols: fileSymbols(index,candidate.file.path), imports: fileImports(index,candidate.file.path), content
    });
    selectedPathSet.add(candidate.file.path);
    chars += cost;
    if (chars >= charBudget && !criticalPaths.has(candidate.file.path)) break;
  }

  // Semantic-critical files (changed files and files containing requested
  // symbols) are never silently lost just because an earlier candidate filled
  // the budget. Keep them with a bounded slice of their source when needed.
  for (const criticalPath of criticalPaths) {
    if (selectedPathSet.has(criticalPath)) continue;
    const candidate = ranked.find(item => item.file.path === criticalPath);
    if (!candidate) continue;
    const available = Math.max(0, charBudget - chars);
    if (available < 200) continue;
    const perFile = Math.min(9_000, available);
    const content = boundedWindows(contextSafeContent(candidate.file.path, candidate.file.content),
      fileSymbols(index, candidate.file.path).map(item => item.line),
      defaults.snippetLines, perFile);
    if (!content) continue;
    const cost = content.length + candidate.file.path.length + 80;
    if (cost > available) continue;
    selected.push({
      path: candidate.file.path, kind: candidate.file.kind, language: candidate.file.language,
      digest: candidate.file.digest, score: candidate.score,
      symbols: fileSymbols(index,candidate.file.path), imports: fileImports(index,candidate.file.path), content
    });
    selectedPathSet.add(candidate.file.path);
    chars += cost;
  }

  const selectedPaths = selected.map(file => file.path);
  const dependencies = dependenciesFor(index, selectedPaths);
  const symbols = relatedSymbols(index, terms.slice(0,8).join(' '), [...changed], { max: 80 });
  const riskSignals = changeRiskSignals(index, [...changed]);
  const cacheKey = digest(JSON.stringify({
    contentHash:index?.contentHash, hierarchyVersion:index?.hierarchy?.version ?? 0, goal, task:task?.id, changed:[...changed].sort(),
    failure:failure ? { status:failure.status, stderr:clean(failure.stderr).slice(-1000) } : null,
    scale, charBudget, fileBudget
  }));
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const pack = Object.freeze({
    version:1,
    strategy:'semantic-minimum-sufficient-context',
    sourceOfTruth:'workspace',
    project:{
      revisionId:index?.revisionId ?? null,
      contentHash:index?.contentHash ?? null,
      workspaceContentHash: workspaceContentHash(normalized),
      fileCount:index?.fileCount ?? normalized.length,
      languages:[...new Set((index?.files ?? []).map(file => file.language).filter(Boolean))].sort(),
      entryPoints:(index?.entryPoints ?? []).slice(0,30),
      profile:index?.profile ?? null,
      scale: projectScale(index),
      hierarchy: {
        root: hierarchyScope.root ?? index?.hierarchy?.root ?? null,
        changedSubtrees: (hierarchyScope.changedSubtrees ?? []).slice(0, 40),
        subtrees: (hierarchyScope.subtrees ?? []).slice(0, 16)
      },
      mutation: {
        mode: projectScale(index) === 'very-large' ? 'surgical-patch-preferred' : 'patch-or-file-replacement',
        baseRevisionId: index?.revisionId ?? null,
        baseContentHash: workspaceContentHash(normalized),
        exactBaseRequired: true,
        rule: 'Every code mutation is bound to the exact workspace snapshot used for reasoning; stale patches must be rejected.'
      }
    },
    task:{ id:clean(task?.id), type:clean(task?.type), goal:clean(goal).slice(0,2000) },
    focus:{
      changedFiles:[...changed].slice(0,80), impactedFiles:[...impacted].slice(0,100),
      relatedTests:[...testPaths].slice(0,50), relevantSymbols:symbols,
      changeRisk:riskSignals
    },
    dependencies,
    previousAttempts:(Array.isArray(previousAttempts) ? previousAttempts : []).slice(-3).map(item => ({
      status:clean(item?.status), summary:clean(item?.summary).slice(0,700)
    })),
    failure:failure ? {
      status:clean(failure.status), message:clean(failure.message).slice(0,500),
      stderr:clean(failure.stderr).slice(-1800), stdout:clean(failure.stdout).slice(-900)
    } : null,
    files:selected.map(({score,...file}) => file),
    budget:{ maxChars:charBudget, usedChars:chars, files:selected.length,
      truncated: totalContentChars > charBudget || selected.length < normalized.length }
  });
  remember(cacheKey,pack);
  return pack;
}

export function compactContextPack(pack,{maxChars=18_000,maxFiles=10}={}) {
  if (!pack || typeof pack !== 'object') return null;
  const files = Array.isArray(pack.files) ? pack.files : [];
  const criticalPaths = new Set([
    ...(pack.focus?.changedFiles ?? []),
    ...(pack.focus?.relevantSymbols ?? []).map(symbol => symbol?.path).filter(Boolean)
  ]);
  const requestedFiles = Number(maxFiles);
  const boundedFiles = Number.isFinite(requestedFiles) && requestedFiles > 0
    ? Math.min(CONTEXT_BUDGETS.advanced.maxFiles, Math.max(1, Math.floor(requestedFiles))) : 10;
  const fileLimit = Math.max(boundedFiles, criticalPaths.size);
  const requestedChars = Number(maxChars);
  const charLimit = Number.isFinite(requestedChars) && requestedChars > 0
    ? Math.min(CONTEXT_BUDGETS.advanced.maxChars, Math.max(2_000, Math.floor(requestedChars))) : 18_000;
  let remaining = charLimit;
  const compactFiles = [];
  const ordered = [...files].sort((a, b) =>
    Number(criticalPaths.has(b?.path)) - Number(criticalPaths.has(a?.path))
    || String(a?.path ?? '').localeCompare(String(b?.path ?? ''))
  );

  for (const file of ordered) {
    const critical = criticalPaths.has(file?.path);
    if (compactFiles.length >= fileLimit) break;
    const header = (String(file?.path ?? '') + '\n').length;
    const available = Math.max(0,remaining-header);
    if (available < 200) {
      if (!critical) break;
      continue;
    }
    const content = text(file.content).slice(0,available);
    compactFiles.push({
      path:file.path, kind:file.kind, language:file.language, digest:file.digest,
      symbols:(file.symbols ?? []).slice(0,12), imports:(file.imports ?? []).slice(0,15), content
    });
    remaining -= header + content.length;
  }

  const included = new Set(compactFiles.map(file => file.path));
  const criticalOmitted = [...criticalPaths].filter(path => !included.has(path)).slice(0,80);
  return {
    version:pack.version, strategy:pack.strategy, project:pack.project, task:pack.task,
    focus:{
      changedFiles:pack.focus?.changedFiles ?? [],
      impactedFiles:(pack.focus?.impactedFiles ?? []).slice(0,60),
      relatedTests:(pack.focus?.relatedTests ?? []).slice(0,30),
      relevantSymbols:(pack.focus?.relevantSymbols ?? []).slice(0,40),
      changeRisk:pack.focus?.changeRisk ?? null
    },
    dependencies:(pack.dependencies ?? []).slice(0,60),
    previousAttempts:pack.previousAttempts ?? [], failure:pack.failure ?? null,
    files:compactFiles,
    budget:{
      maxChars:charLimit,
      files:compactFiles.length,
      criticalFiles:criticalPaths.size,
      criticalFilesIncluded:criticalPaths.size-criticalOmitted.length,
      criticalFilesOmitted:criticalOmitted
    }
  };
}
