/**
 * The plan, told to the person before the work: what is brought in and why,
 * what is left out and why, and how big the work is.
 *
 * It is written by the server from the run itself (no model call), so it
 * always matches what will actually run, including a plan that grew when
 * understanding found more.
 */

import { taskTools } from './work-scale.js';

const TOOLS = {
  'code-generation': ['Code writer', 'writes the code with its own tests'],
  'code-execution': ['Sealed sandbox', 'runs the tests for real, with no network, before you see the code'],
  'evidence-retrieval': ['Web research', 'finds current facts and real sources to cite'],
  'external-data-routing': ['Outside data', 'fetches the data the work depends on'],
  'file-analysis': ['Files', 'looks through the files this work involves'],
  design: ['Drafting', 'drafts the document or design you asked for'],
  invention: ['Invention method', 'compares several concepts and picks the cheapest decisive test'],
  'capability-discovery': ['Tool discovery', 'the tools each stage needs are worked out before any work starts'],
  'adaptive-execution': ['Specialised tools', 'runs tools chosen for this situation, only after you approve']
};
// Parts of the invention method, shown once as "Invention method".
const INVENTION_PARTS = new Set(['hypothesis-generation', 'concept-evaluation', 'experiment-design']);
const RESEARCH = new Set(['evidence-retrieval', 'external-data-routing']);

const HEADLINE = {
  small: 'Small, familiar task',
  standard: 'Standard task',
  complex: 'Complex task: done in stages, each checked before the next'
};

const text = value => String(value ?? '').trim();

/** The brief for a run, or null for a direct answer (nothing to plan). */
export function planBrief(run) {
  if (!run || run.workflow === 'direct') return null;
  const tasks = run.tasks ?? [];
  const adaptation = run.adaptation ?? {};
  const scale = adaptation.scale ?? 'standard';
  const requirements = run.capabilities?.requirements ?? [];
  const granted = taskTools(run.capabilities?.granted ?? []);
  const has = type => tasks.some(task => task.type === type && task.status !== 'skipped');
  // Tools that joined the plan later (understanding added research or discovery).
  const inPlan = new Set(granted);
  if (has('discover-capabilities')) inPlan.add('capability-discovery');
  if (tasks.some(task => task.type === 'investigate' && task.status !== 'skipped')) inPlan.add('evidence-retrieval');

  const bring = [];
  for (const id of inPlan) {
    if (INVENTION_PARTS.has(id)) continue;
    if (id === 'external-data-routing' && inPlan.has('evidence-retrieval')) continue;
    const [label, why] = id === 'capability-discovery' && scale !== 'complex'
      ? ['Tool check', 'confirms the built-in tools cover everything this needs']
      : TOOLS[id] ?? [id, text(requirements.find(item => item?.id === id)?.purpose) || 'needed for this situation'];
    bring.push({ id, label, why });
  }
  const selected = adaptation.resourcePlan?.selected ?? {};
  // The public web is what web research already reads.
  for (const source of selected.dataSources ?? []) {
    if (source === 'public-web' && inPlan.has('evidence-retrieval')) continue;
    bring.push({ id: `data:${source}`, label: source === 'public-web' ? 'The public web' : String(source), why: 'the work reads from it' });
  }
  for (const file of selected.artifacts ?? []) bring.push({ id: `file:${file}`, label: String(file), why: 'you attached it' });

  const leaveOut = [];
  const notHere = adaptation.notAvailableHere ?? [];
  if (notHere.includes('code-execution')) leaveOut.push({ label: 'Running the code', why: 'not set up here, so you get the code and how to run it' });
  if (![...inPlan].some(id => RESEARCH.has(id))) {
    leaveOut.push({ label: 'Web research', why: 'what you asked does not depend on outside facts; a step adds it if it finds a gap' });
  }
  if (!inPlan.has('capability-discovery')) {
    leaveOut.push({ label: 'Tool discovery', why: 'a familiar task: the built-in tools cover it' });
  }
  if (scale === 'small' && inPlan.has('code-execution')) {
    leaveOut.push({ label: 'Extra review checkpoints', why: 'the test run is the check here' });
  }
  const omitted = adaptation.resourcePlan?.omitted ?? {};
  for (const id of taskTools(omitted.capabilities)) leaveOut.push({ label: TOOLS[id]?.[0] ?? id, why: 'outside the scope you set; ask to add it' });
  for (const source of omitted.dataSources ?? []) leaveOut.push({ label: String(source), why: 'outside the scope you set; ask to add it' });
  for (const file of omitted.artifacts ?? []) leaveOut.push({ label: String(file), why: 'outside the scope you set; ask to add it' });

  return {
    scale,
    headline: HEADLINE[scale] ?? HEADLINE.standard,
    bring,
    leaveOut
  };
}
