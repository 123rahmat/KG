/**
 * The coding loop: write → syntax check → run the tests → on failure, a
 * targeted fix with the real error output → run again.
 *
 * A failing test does not restart the whole workflow. Within one attempt the
 * code goes back to `build-code` with what failed, up to MAX_CODE_REPAIRS
 * times; only then does the run fall back to a new attempt. Code that ships
 * without tests cannot be certified by the automated check alone.
 */

import { clip } from './reasoning-context.js';
import { LANGUAGES, languageName } from './sandbox.js';
import { workspacePath } from './workspace-path.js';
import { applySurgicalChanges } from './workspace-patch.js';
import { workspaceContentHash } from './code-workspace.js';

export const MAX_CODE_REPAIRS = 3;
// Enough for the largest repair ceiling (complex work) plus earlier attempts.
const MAX_REPAIR_RECORDS = 12;
const MAX_CODE_CHARS = 20_000;
// A project's files, all together, as a fix or a later step sees them.
const MAX_PROJECT_CHARS = 60_000;
const MAX_PROJECT_FILES = 60;
const tail = (value, max) => {
  const raw = typeof value === 'string' ? value : '';
  return raw.length > max ? `…${raw.slice(-max)}` : raw;
};
const text = value => (typeof value === 'string' ? value.trim() : '');

/** The runner's own report inside a receipt (the sandbox nests it in `output`). */
export function codeRunOutput(result) {
  if (!result || typeof result !== 'object') return {};
  return result.output && typeof result.output === 'object' ? result.output : result;
}

/** What failed, as the fix needs it: status, exit, test counts and output tails. */
export function codeFailure(execution) {
  const receipt = execution?.result ?? {};
  const output = codeRunOutput(receipt);
  return {
    status: text(output.status) || text(receipt.outcome) || text(execution?.status) || 'failed',
    ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
    ...(output.timedOut ? { timedOut: true } : {}),
    ...(output.testSummary ? { testSummary: output.testSummary } : {}),
    ...(text(output.message) ? { message: clip(text(output.message), 300) } : {}),
    stderr: tail(output.stderr, 4000),
    stdout: tail(output.stdout, 2000)
  };
}

const languageOf = languageName;

/**
 * A package's files, when it is a project of several files:
 * [{ path, content }] with safe relative paths, or [] for a single file.
 */
export function codeFiles(structured) {
  const raw = structured?.files;
  const list = Array.isArray(raw) ? raw
    : raw && typeof raw === 'object' ? Object.entries(raw).map(([path, content]) => ({ path, content })) : [];
  const seen = new Set();
  return list
    .map(item => ({ path: workspacePath(item?.path ?? item?.name), content: typeof item?.content === 'string' ? item.content : String(item?.text ?? '') }))
    .filter(item => item.path && !seen.has(item.path) && seen.add(item.path))
    .slice(0, MAX_PROJECT_FILES);
}

/** Paths a change deletes from the project (not ones it also writes). */
export function deletedPaths(structured) {
  const written = new Set(codeFiles(structured).map(file => file.path));
  const raw = Array.isArray(structured?.delete) ? structured.delete : [];
  return [...new Set(raw.map(workspacePath).filter(Boolean))].filter(path => !written.has(path)).slice(0, MAX_PROJECT_FILES);
}

/** Whether a package is a project (files it writes or deletes) rather than one source file. */
export const isProject = structured => codeFiles(structured).length > 0 || deletedPaths(structured).length > 0;

/** The test files in a project, by the sandbox's own naming rules. */
export function projectTests(structured) {
  const spec = LANGUAGES[languageOf(structured?.language)];
  if (!spec) return [];
  // Tests written inside the code (Rust's #[test]) count too.
  return codeFiles(structured).filter(file => file.content.trim() && (spec.test.test(file.path) || spec.inline?.test(file.content)));
}

// Merely naming a file test_foo.py, or importing a test framework, is not
// evidence that a test will run. Keep this intentionally conservative and
// language-aware: the sandbox remains the authority for the final count, but
// this prevents spending a build/test cycle on an obviously empty test suite.
const TEST_CASE = {
  python: /(?:^|\n)\s*(?:async\s+)?def\s+test_[\w]+\s*\(|\bclass\s+\w+\s*\(\s*unittest\.TestCase\s*\)|\bassert\s+/m,
  javascript: /\b(?:test|it|describe)\s*\(/,
  typescript: /\b(?:test|it|describe)\s*\(/,
  go: /(?:^|\n)\s*func\s+Test\w+\s*\(/m,
  rust: /#\s*\[\s*test\s*\]/,
  java: /@(?:Test|ParameterizedTest)\b|\bvoid\s+test\w*\s*\(/,
  csharp: /\[(?:Fact|Theory|Test|TestMethod)\b/,
  ruby: /\b(?:def\s+test_|it\s+['"]|specify\s+['"])/,
  php: /\b(?:function\s+test\w*\s*\(|#\[Test\])/,
  kotlin: /@Test\b|\bfun\s+test\w*\s*\(/,
  swift: /\bfunc\s+test\w*\s*\(/
};

export function hasMeaningfulTests(structured, { previous = null, baseFiles = [] } = {}) {
  if (!structured) return false;
  const language = languageOf(structured.language);
  const pattern = TEST_CASE[language];
  if (!pattern) return false;
  const files = isProject(structured)
    ? [...codeFiles(structured), ...(isProject(previous) ? codeFiles(previous) : []), ...baseFiles]
    : [{ path: '', content: structured.tests }];
  return files.some(file => pattern.test(String(file?.content ?? '')));
}

/** Files clipped to a shared budget; a cut file says so. */
function clipFiles(files, budget = MAX_PROJECT_CHARS) {
  let left = budget;
  return files.map(file => {
    const content = file.content.length <= left ? file.content : `${file.content.slice(0, Math.max(0, left))}\n…[cut: ${file.content.length} characters in all]`;
    left = Math.max(0, left - file.content.length);
    return { path: file.path, content };
  });
}

/**
 * The code package a build step produced. A project's files are clipped to
 * the shared budget, or kept whole ({ whole: true }) where they will run.
 */
export function builtCode(tasks = [], { whole = false } = {}) {
  const built = tasks.find(task => task.id === 'build-code')?.evidence?.structured;
  if (!built || typeof built !== 'object') return null;
  const files = codeFiles(built);
  return {
    language: text(built.language),
    source: clip(String(built.source ?? ''), MAX_CODE_CHARS),
    tests: clip(String(built.tests ?? ''), MAX_CODE_CHARS),
    ...(isProject(built) ? {
      files: whole ? files : clipFiles(files),
      ...(deletedPaths(built).length ? { delete: deletedPaths(built) } : {}),
      ...(text(built.entry) ? { entry: text(built.entry) } : {})
    } : {}),
    packages: Array.isArray(built.packages) ? built.packages.slice(0, 20).map(String) : []
  };
}

/**
 * A fix laid over the project it fixes: the files the fix returns replace
 * or add to the previous ones; the rest stay.
 */
export function mergeFix(previous, fix) {
  if (!isProject(previous) || !isProject(fix)) return fix;
  const files = new Map(codeFiles(previous).map(file => [file.path, file.content]));
  // A deletion stands until a later change writes the file again: the
  // fix's own files win over any earlier deletion of them.
  const written = new Set(codeFiles(fix).map(file => file.path));
  const deleted = new Set([...deletedPaths(previous), ...deletedPaths(fix)].filter(path => !written.has(path)));
  for (const path of deleted) files.delete(path);
  for (const file of codeFiles(fix)) files.set(file.path, file.content);
  return {
    ...fix,
    files: [...files].map(([path, content]) => ({ path, content })),
    ...(deleted.size ? { delete: [...deleted] } : { delete: undefined }),
    ...(!text(fix.entry) && text(previous.entry) ? { entry: previous.entry } : {}),
    ...(!Array.isArray(fix.packages) && Array.isArray(previous.packages) ? { packages: previous.packages } : {})
  };
}


/**
 * Turn an optional surgical patch into the complete project that the sandbox
 * and verification layers already understand. The patch can only apply to
 * the exact base workspace supplied by the caller.
 */
export function materializeCodePackage(structured, { baseFiles = [], baseContentHash = null } = {}) {
  if (!structured || typeof structured !== 'object' || !Array.isArray(structured.patches) || !structured.patches.length) return structured;
  const baseHash = text(baseContentHash) || workspaceContentHash(baseFiles);
  const result = applySurgicalChanges(baseFiles, structured.patches, {
    expectedContentHash: text(structured.baseContentHash) || baseHash
  });
  const current = new Set(result.files.map(file => file.path));
  const deleted = baseFiles.map(file => file.path).filter(path => !current.has(path));
  return {
    ...structured,
    files: result.files,
    ...(deleted.length ? { delete: deleted } : {}),
    patches: undefined,
    baseContentHash: baseHash
  };
}

/** A project package as later steps see it: its files within the shared budget. */
export function compactProject(structured) {
  if (!isProject(structured)) return structured;
  return { ...structured, files: clipFiles(codeFiles(structured)) };
}

/**
 * The sandbox job for a package. A project runs as its files, on top of the
 * project the person attached: files it did not change stay as they were.
 */
export function sandboxPayload(built, { baseFiles = [] } = {}) {
  if (!built || typeof built !== 'object') return {};
  const packages = Array.isArray(built.packages) ? { packages: built.packages } : {};
  if (!isProject(built)) {
    return { language: built.language, source: built.source, ...(text(built.tests) ? { tests: built.tests } : {}), ...packages };
  }
  const files = {};
  const deleted = new Set(deletedPaths(built));
  for (const file of baseFiles) {
    const path = workspacePath(file?.path);
    if (path && !deleted.has(path)) files[path] = String(file.content ?? '');
  }
  const written = codeFiles(built);
  for (const file of written) files[file.path] = file.content;
  const spec = LANGUAGES[languageOf(built.language)];
  if (text(built.source) && spec) files[spec.file] ??= built.source;
  if (text(built.tests) && spec?.testFile) files[spec.testFile] ??= built.tests;
  else if (text(built.tests) && spec?.appendTests && files[spec.file] !== undefined) files[spec.file] += spec.appendTests(built.tests);
  return {
    language: built.language, project: true, files,
    // Only what this change wrote is syntax-checked; the tests run the rest.
    check: written.map(file => file.path),
    ...(text(built.entry) ? { entry: text(built.entry) } : {}), ...packages
  };
}

/** Repairs already made in the run's current attempt. */
export const repairsThisAttempt = run => (run.adaptation?.codeRepairs ?? [])
  .filter(item => Number(item.attempt) === Number(run.attempt));

/** Whether a failed code run may go back for a fix in this attempt. */
export function canRepair(run, max = MAX_CODE_REPAIRS) {
  return repairsThisAttempt(run).length < max;
}

// A safety ceiling on fixes, by the size of the work; the fixes themselves
// stop earlier as soon as they stop making progress.
const REPAIR_CEILING = { small: 4, standard: 6, complex: 8 };
export const repairCeiling = run => REPAIR_CEILING[run?.adaptation?.scale] ?? MAX_CODE_REPAIRS;

/** How far a failed run is from working: lower is closer. */
export function failureDistance(failure) {
  if (!failure) return Number.POSITIVE_INFINITY;
  if (failure.status === 'syntax-error') return 1_000_000;
  if (failure.timedOut || failure.status === 'timed-out') return 500_000;
  const summary = failure.testSummary;
  if (summary && Number(summary.total) > 0) return Number(summary.failed) || 0;
  return 100_000;
}

const sameFailure = (a, b) => Boolean(a && b)
  && a.status === b.status
  && failureDistance(a) === failureDistance(b)
  && tail(a.stderr, 400) === tail(b.stderr, 400);

/**
 * Whether one more fix is worth it. The first failure always gets a fix;
 * after that, fixes go on while each one gets closer to working (fewer
 * failing tests, or a syntax error that became a failing test). A fix that
 * gets no closer (or leaves the same failure) gets one more try; two in a
 * row stop them, as does the ceiling for the size of the work.
 */
export function repairDecision(run, failure, { ceiling = repairCeiling(run) } = {}) {
  const earlier = repairsThisAttempt(run).map(round => round.failure);
  if (earlier.length >= ceiling) return { repair: false, reason: 'ceiling', ceiling };
  if (!earlier.length) return { repair: true, reason: 'first-failure', ceiling };
  const previous = earlier.at(-1);
  if (failureDistance(failure) < failureDistance(previous) && !sameFailure(failure, previous)) return { repair: true, reason: 'progress', ceiling };
  // No closer (the same failure again counts as no closer): one more try,
  // but not after a fix that already made no progress.
  const before = earlier.at(-2);
  const stalledBefore = before && !(failureDistance(previous) < failureDistance(before));
  return stalledBefore ? { repair: false, reason: 'no-progress', ceiling } : { repair: true, reason: 'one-more-try', ceiling };
}

/** The record kept for one repair round, and the updated repair history. */
export function repairRecord(run, tasks, taskId, failure) {
  const round = repairsThisAttempt(run).length + 1;
  // A project is kept whole: the fix returns only the files it changes, and
  // is laid over these.
  const record = { attempt: Number(run.attempt), round, taskId, at: new Date().toISOString(), code: builtCode(tasks, { whole: true }), failure };
  // Only the newest record needs the whole project (the next fix is laid
  // over it); older ones keep what a reader needs.
  const earlier = (run.adaptation?.codeRepairs ?? []).map(item => ({ ...item, code: compactProject(item.code) }));
  return { record, history: [...earlier, record].slice(-MAX_REPAIR_RECORDS) };
}

/**
 * build-code and every step after it that depends on it, up to the failed
 * run: the steps a fix makes stale.
 */
export function staleAfterRepair(tasks, failedTaskId) {
  const build = tasks.find(task => task.id === 'build-code');
  const failed = tasks.find(task => task.id === failedTaskId);
  if (!build || !failed) return [];
  const stale = new Set(['build-code', failedTaskId]);
  for (const task of tasks) {
    if (task.position > build.position && task.position < failed.position) stale.add(task.id);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const task of tasks) {
      if (!stale.has(task.id) && task.status !== 'pending' && (task.dependsOn ?? []).some(id => stale.has(id))) {
        stale.add(task.id);
        grew = true;
      }
    }
  }
  return [...stale];
}

/** What the next build step is told: the code that failed and how, round by round. */
export function repairContext(run, max = MAX_CODE_REPAIRS) {
  const rounds = repairsThisAttempt(run);
  if (!rounds.length) return null;
  const last = rounds.at(-1);
  return {
    round: last.round,
    maxRounds: max,
    previousCode: compactProject(last.code),
    failure: last.failure,
    // Earlier rounds, briefly, so a fix does not reintroduce an old failure.
    earlier: rounds.slice(0, -1).map(item => ({ round: item.round, status: item.failure?.status, stderr: tail(item.failure?.stderr, 600) }))
  };
}

/**
 * Code that ran without tests of its own, on a completed run step. A test
 * file in which no test actually ran counts as none.
 */
/**
 * Code the sandbox could not run in this attempt ({ language, reason }), or
 * null. A later attempt whose code did run is judged on its own run.
 */
export function codeNotRunNow(run) {
  const record = run?.adaptation?.codeNotRun;
  return record && Number(record.attempt ?? run.attempt) === Number(run.attempt ?? 1) ? record : null;
}

export function untestedCode(run) {
  // Code this sandbox could not run at all is untested too.
  if (codeNotRunNow(run)) return true;
  return (run.tasks ?? []).some(task => {
    if (task.id !== 'test-code' || task.status !== 'complete') return false;
    const output = codeRunOutput(task.evidence?.result);
    return output.tested === false || output.testSummary?.total === 0;
  });
}

/**
 * A build package that lacks tests (only languages the sandbox tests). A
 * project counts the tests it already had: the previous version it fixes
 * and the attached project it changes, since a change returns only the
 * files it writes.
 */
export function missingTests(structured, { previous = null, baseFiles = [] } = {}) {
  if (!structured) return false;
  if (isProject(structured)) return !hasMeaningfulTests(structured, { previous, baseFiles });
  const inline = LANGUAGES[languageOf(structured.language)]?.inline;
  return Boolean(text(structured.source) && !hasMeaningfulTests(structured) && !inline?.test(structured.source));
}

/** A package in one shape, whatever shape the model used: files as [{ path, content }]. */
export function normalizePackage(structured) {
  if (!isProject(structured)) return structured;
  const { delete: _delete, ...rest } = structured;
  const deleted = deletedPaths(structured);
  return { ...rest, files: codeFiles(structured), ...(deleted.length ? { delete: deleted } : {}) };
}

/** A build package with code in it: one source file, or a project's files. */
export const hasCode = structured => Boolean(structured && (text(structured.source) || isProject(structured)));

/** A code run's evidence as later reasoning needs it: results, not megabytes of output. */
export function compactCodeEvidence(evidence) {
  const result = evidence?.result;
  if (!result || typeof result !== 'object' || !('output' in result) || typeof result.output !== 'object') return evidence;
  const { stdout, stderr, files, program, ...rest } = result.output;
  return {
    ...evidence,
    result: {
      ...result,
      output: {
        ...rest,
        stdout: tail(stdout, 3000),
        stderr: tail(stderr, 3000),
        // What the program printed when run on its own, after its tests passed.
        ...(program ? { program: { exitCode: program.exitCode, timedOut: program.timedOut, stdout: tail(program.stdout, 3000), stderr: tail(program.stderr, 1500) } } : {}),
        files: (files ?? []).map(file => ({ name: file.name, bytes: file.bytes }))
      }
    }
  };
}

export const TESTS_REQUIRED_PROMPT = 'Your code package has no tests. Return the same JSON object again with tests added: for one source file, fill "tests" (Python unittest importing main, or node:test importing ./main.mjs); for a project in "files", add test files (test_*.py with unittest, or *.test.mjs with node:test). Cover normal use, edge cases and failure cases, so the tests fail if the code is wrong. Change the code only if a test shows it is wrong.';
