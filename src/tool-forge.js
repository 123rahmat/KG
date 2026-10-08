/**
 * The tool forge: Kindgleam writes the tools a situation needs, tests them
 * in its sandbox, and keeps the ones a person approves.
 *
 *   code.run     run code (with libraries from the registries) on the
 *                attached files, in the sandbox; results and files come back.
 *   tool.create  propose a new workspace tool. Its tests run in the sandbox
 *                first; only passing tools are proposed, and an admin approves.
 *   ws.<name>    each approved workspace tool, reused by later chats. It
 *                reads JSON on stdin, prints JSON.
 */

import crypto from 'node:crypto';
import { callRunner, SANDBOX_TIMEOUT_MS } from './runtime.js';
import { registerTools } from './toolbox.js';
import { validateJob, SandboxError } from './sandbox.js';
import { isSensitiveWorkspacePath } from './workspace-path.js';

const text = value => String(value ?? '').trim();
const TOOL_NAME = /^[a-z][a-z0-9-]{1,39}$/;
const MAX_TEXT_OUT = 20_000;

const sandboxReady = ctx => (ctx.config?.runners?.sandbox
  ? { ready: true }
  : { ready: false, needs: 'sandbox', reason: 'Running code needs the Kindgleam sandbox, which is not set up on this site (SANDBOX_RUNNER_URL).' });

/** Run a job in the sandbox runner; returns the sandbox's result or { error }. */
export async function runInSandbox(ctx, job, { label = 'code.run' } = {}) {
  try {
    validateJob(job);
  } catch (error) {
    if (error instanceof SandboxError) return { error: error.message };
    throw error;
  }
  const outcome = await callRunner(ctx.config.runners.sandbox, {
    executionId: `sbx_${crypto.randomUUID()}`,
    executionTarget: 'general-ai-sandbox',
    task: { id: `tool:${label}`, type: 'code' },
    payload: { job }
  }, { config: ctx.config, fetchImpl: ctx.fetchImpl, timeoutMs: SANDBOX_TIMEOUT_MS, signal: ctx.signal,
    beforeCall: () => ctx.beforeRunner?.({ tool: label.split(':')[0] }) });
  if (!outcome.executed) return { error: outcome.message || `The sandbox did not run the code (${outcome.status}).` };
  return outcome.result?.output ?? { error: 'The sandbox returned no result.' };
}

/** Attached files, by name, as sandbox input files under in/. */
async function attachedFiles(ctx, names) {
  const files = {};
  for (const wanted of Array.isArray(names) ? names.slice(0, 10) : []) {
    const file = (ctx.attachments ?? []).find(item => text(item.name).toLowerCase() === text(wanted).toLowerCase());
    if (!file) return { error: `No attached file is called "${text(wanted)}".` };
    if (isSensitiveWorkspacePath(file.name)) return { error: 'Credential-bearing files cannot be copied into the code sandbox.', code: 'sensitive-file-blocked' };
    const object = await ctx.objects?.read(ctx.scope, file.id).catch(() => null);
    if (!object) return { error: `"${file.name}" is no longer available.` };
    files[`in/${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`] = { base64: Buffer.from(object.content).toString('base64') };
  }
  return { files };
}

const TEXT_TYPES = /\.(txt|csv|json|md|svg|html|xml|log|tsv)$/i;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** A sandbox result as the AI reads it; the first image is shown to it. */
function summarise(result) {
  if (result.error) return result;
  const files = (result.files ?? []).map(file => {
    const ext = file.name.split('.').pop().toLowerCase();
    return {
      name: file.name, bytes: file.bytes,
      ...(file.base64 && TEXT_TYPES.test(file.name) ? { text: Buffer.from(file.base64, 'base64').toString('utf8').slice(0, 4000) } : {}),
      ...(IMAGE_TYPES[ext] ? { image: true } : {})
    };
  });
  const firstImage = (result.files ?? []).find(file => file.base64 && IMAGE_TYPES[file.name.split('.').pop().toLowerCase()]);
  return {
    status: result.status, exitCode: result.exitCode, timedOut: result.timedOut,
    stdout: String(result.stdout ?? '').slice(0, MAX_TEXT_OUT), stderr: String(result.stderr ?? '').slice(-MAX_TEXT_OUT),
    installed: result.installed ?? [], files, durationMs: result.durationMs,
    ...(firstImage ? { showImage: { mediaType: IMAGE_TYPES[firstImage.name.split('.').pop().toLowerCase()], data: firstImage.base64 } } : {})
  };
}

/** Keep result files in the workspace's Files, so the person can open them. */
async function saveOutputs(ctx, result) {
  if (!ctx.objects?.create || !ctx.scope?.workspaceId) return [];
  const saved = [];
  for (const file of (result.files ?? []).filter(item => item.base64).slice(0, 10)) {
    // The same file from the same chat is kept once, even when the code runs again.
    if (ctx.pool && ctx.run?.id && file.sha256) {
      const { rows: [kept] } = await ctx.pool.query(
        "SELECT id, name FROM objects WHERE workspace_id = $1 AND provenance->>'runId' = $2 AND provenance->>'sha256' = $3 AND lifecycle = 'active' LIMIT 1",
        [ctx.scope.workspaceId, ctx.run.id, file.sha256]
      ).catch(() => ({ rows: [] }));
      if (kept) { saved.push({ name: kept.name, id: kept.id }); continue; }
    }
    const ext = file.name.split('.').pop().toLowerCase();
    const contentType = IMAGE_TYPES[ext] ?? (ext === 'csv' ? 'text/csv' : ext === 'json' ? 'application/json' : ext === 'svg' ? 'image/svg+xml' : TEXT_TYPES.test(file.name) ? 'text/plain' : 'application/octet-stream');
    const object = await ctx.objects.create(ctx.scope, { id: ctx.scope.principalId }, {
      name: file.name.split('/').pop(), type: 'artifact', contentType, content: file.base64, encoding: 'base64',
      provenance: { source: 'general-ai-sandbox', runId: ctx.run?.id ?? null, sha256: file.sha256 }
    }).catch(() => null);
    if (object) saved.push({ name: object.name ?? file.name, id: object.id });
  }
  return saved;
}

registerTools([
  {
    name: 'code.run',
    title: 'Run code',
    description: 'Run Python or JavaScript in a sealed sandbox, with libraries from PyPI (pre-built) or npm, on the attached files (copied to in/). Use it for data analysis, charts (write them to out/), conversions, numerical methods and anything no other tool does. No network while it runs.',
    input: { language: 'python | javascript', source: 'the program', packages: '["pandas", "matplotlib"] (optional)', files: '["attached file name"] (optional, appear in in/)', save: 'true to keep out/ files in the person\'s Files' },
    ready: sandboxReady,
    async run(input, ctx) {
      const inputs = await attachedFiles(ctx, input.files);
      if (inputs.error) return inputs;
      const result = await runInSandbox(ctx, { language: input.language, source: input.source, packages: input.packages, files: inputs.files, timeoutMs: input.timeoutMs });
      const shown = summarise(result);
      if (!result.error && input.save === true) shown.savedToFiles = await saveOutputs(ctx, result);
      return shown;
    }
  },
  {
    name: 'tool.create',
    title: 'Build a new workspace tool',
    description: 'When no tool can do something this situation needs, and it will be needed again, write one: a program that reads one JSON object on stdin and prints one JSON object on stdout, with tests. Put the logic in functions the tests call, and read stdin only when run directly (Python: under if __name__ == "__main__"; JavaScript: when process.argv[1] ends with main.mjs). Its tests run in the sandbox first; if they pass, an admin is asked to approve it, and it becomes ws.<name> for every later chat and design.',
    input: { name: 'lowercase-with-dashes', title: 'short title', description: 'what it does and when to use it', input: '{ field: description } of the JSON it reads', language: 'python | javascript', source: 'the program (reads stdin JSON, prints JSON)', tests: 'Python unittest importing main, or node:test importing ./main.mjs', packages: 'libraries it needs (optional)' },
    sideEffect: true,
    approveRole: 'admin',
    ready: ctx => ctx.capabilityInvestment === 'build-candidate'
      ? sandboxReady(ctx)
      : { ready: false, needs: 'capability-investment', reason: 'The person must explicitly choose candidate capability investment before a new workspace tool can be built.' },
    async validate(input, ctx) {
      const name = text(input.name).toLowerCase();
      if (!TOOL_NAME.test(name)) return { error: 'The tool name must be 2-40 lowercase letters, digits or dashes, starting with a letter.' };
      if (!text(input.tests)) return { error: 'A tool needs tests, so it can be trusted before it is kept.' };
      if (!text(input.description) || !text(input.title)) return { error: 'Give the tool a title and a description.' };
      const result = await runInSandbox(ctx, { language: input.language, source: input.source, tests: input.tests, packages: input.packages }, { label: `tool.create:${name}` });
      if (result.error) return { error: result.error };
      if (result.status !== 'completed') {
        return { error: `The tool's tests did not pass (${result.status}). Fix it and try again.\n${String(result.stdout ?? '').slice(-3000)}\n${String(result.stderr ?? '').slice(-3000)}` };
      }
      input.testResult = { status: result.status, installed: result.installed ?? [], output: String(result.stderr || result.stdout).slice(-1500), durationMs: result.durationMs };
      return null;
    },
    summarize: input => `Add the tool "${text(input.title) || text(input.name)}" to this workspace: ${text(input.description).slice(0, 160)} (tests passed in the sandbox)`,
    async run(input, ctx) {
      const name = text(input.name).toLowerCase();
      const { rows: [row] } = await ctx.pool.query(
        `INSERT INTO workspace_tools (workspace_id, name, title, description, input_schema, language, source, tests, packages, test_result, created_by, approved_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $11)
         ON CONFLICT (workspace_id, name) DO UPDATE SET
           title = EXCLUDED.title, description = EXCLUDED.description, input_schema = EXCLUDED.input_schema,
           language = EXCLUDED.language, source = EXCLUDED.source, tests = EXCLUDED.tests, packages = EXCLUDED.packages,
           test_result = EXCLUDED.test_result, approved_by = EXCLUDED.approved_by, status = 'active',
           version = workspace_tools.version + 1, updated_at = now()
         RETURNING name, version`,
        [ctx.scope.workspaceId, name, text(input.title).slice(0, 80), text(input.description).slice(0, 600),
          JSON.stringify(input.input && typeof input.input === 'object' && !Array.isArray(input.input) ? input.input : {}),
          validateJob({ language: input.language, source: input.source }).language, String(input.source), String(input.tests),
          JSON.stringify(Array.isArray(input.packages) ? input.packages : []), JSON.stringify(input.testResult ?? null), ctx.scope.principalId]
      );
      return { tool: `ws.${row.name}`, version: row.version, note: 'It is available in this workspace from now on.' };
    }
  }
]);

/** The workspace's approved tools, as toolbox tools for this context. */
export async function workspaceTools(pool, scope) {
  if (!scope?.workspaceId) return [];
  const { rows } = await pool.query(
    "SELECT * FROM workspace_tools WHERE workspace_id = $1 AND status = 'active' ORDER BY name LIMIT 100",
    [scope.workspaceId]
  ).catch(() => ({ rows: [] }));
  return rows.map(row => ({
    name: `ws.${row.name}`,
    title: row.title,
    description: `${row.description} (a tool this workspace built, v${row.version})`,
    input: row.input_schema,
    ready: sandboxReady,
    async run(input, ctx) {
      const result = await runInSandbox(ctx, { language: row.language, source: row.source, packages: row.packages, stdin: JSON.stringify(input ?? {}) }, { label: `ws.${row.name}` });
      if (result.error) return result;
      if (result.status !== 'completed') return { error: `The tool failed (${result.status}): ${String(result.stderr ?? '').slice(-2000)}` };
      try {
        return JSON.parse(String(result.stdout).trim().split('\n').at(-1));
      } catch {
        return { output: String(result.stdout).slice(0, MAX_TEXT_OUT) };
      }
    }
  }));
}

/** For Settings: the workspace's tools, without their code. */
export async function listWorkspaceTools(pool, scope) {
  const { rows } = await pool.query(
    'SELECT name, title, description, language, packages, version, status, test_result, created_by, approved_by, updated_at FROM workspace_tools WHERE workspace_id = $1 ORDER BY status, name',
    [scope.workspaceId]
  );
  return rows.map(row => ({ name: row.name, tool: `ws.${row.name}`, title: row.title, description: row.description, language: row.language, packages: row.packages, version: row.version, status: row.status, tested: row.test_result?.status === 'completed', updatedAt: row.updated_at }));
}
