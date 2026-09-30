/**
 * The tools the built-in runner implements. A discovered capability runs
 * only if it names one of these, and only after an administrator approved it.
 */

import { webFetch, httpCheck } from './web.js';
import { mathEvaluate } from './math.js';

export const TOOLS = Object.freeze({
  'web.fetch': {
    description: 'Retrieve the readable text of a public web page, with provenance (final URL, SHA-256 of the bytes).',
    input: { url: 'https URL of a public page' },
    network: true,
    run: webFetch
  },
  'http.check': {
    description: 'Check whether a public URL responds, with status and response time.',
    input: { url: 'http(s) URL of a public resource' },
    network: true,
    run: httpCheck
  },
  'math.evaluate': {
    description: 'Evaluate an arithmetic expression exactly as written, without executing code.',
    input: { expression: 'e.g. "sqrt(2) * (3 + 4) ^ 2"' },
    network: false,
    run: mathEvaluate
  }
});

export function toolCatalog() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name, description: tool.description, input: tool.input, network: tool.network
  }));
}

/**
 * Which tool a task may run. When the task carries approved capability
 * specs that name tools, the request must pick one of those; otherwise it
 * may pick any implemented tool.
 */
export function selectTool(task = {}, requested) {
  const name = String(requested ?? '').trim();
  if (!Object.hasOwn(TOOLS, name)) {
    return { error: 'tool-not-implemented', message: `No implemented tool "${name || '(none)'}"`, available: Object.keys(TOOLS) };
  }
  const specs = Array.isArray(task.metadata?.capabilitySpecs) ? task.metadata.capabilitySpecs : [];
  const named = [...new Set(specs.flatMap(spec => Array.isArray(spec?.tools) ? spec.tools.map(String).filter(Boolean) : []))];
  if (specs.length && !named.length) {
    return {
      error: 'tool-not-approved',
      message: 'The discovered capability does not name an approved executable tool.',
      available: []
    };
  }
  if (named.length && !named.includes(name)) {
    return { error: 'tool-not-approved', message: `The approved capability allows only: ${named.join(', ')}`, available: named };
  }
  return { name, tool: TOOLS[name] };
}
