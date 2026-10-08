/** Presentation intent only. Never grants execution privileges or changes server state. */
const LENSES = Object.freeze({
  conversation: { label: 'Conversation', hint: 'A direct answer may be enough', suggestions: [] },
  brainstorming: { label: 'Brainstorming', hint: 'Explore distinct ideas; evaluate when helpful', suggestions: ['Compare the strongest ideas against my constraints.', 'Challenge the leading idea and offer an alternative.'] },
  planning: { label: 'Planning', hint: 'Track priorities, milestones and dependencies', suggestions: ['Turn this into prioritized milestones.', 'Identify the main dependencies and risks.'] },
  deciding: { label: 'Decision', hint: 'Compare choices and trade-offs', suggestions: ['Compare options using my most important criteria.', 'What evidence could change this decision?'] },
  learning: { label: 'Learning', hint: 'Adjust examples and explanation to the learner', suggestions: ['Show me a worked example.', 'Quiz me on the key concepts.'] },
  writing: { label: 'Writing', hint: 'Refine the draft for its audience', suggestions: ['Make this clearer and more concise.', 'Check this against its intended purpose.'] },
  designing: { label: 'Design', hint: 'Consider usability, visuals and accessibility', suggestions: ['Compare two distinct design directions.', 'Review usability and accessibility.'] },
  coding: { label: 'Coding', hint: 'Work against project files and verification evidence', suggestions: [] },
  researching: { label: 'Research', hint: 'Track sources, evidence and uncertainty', suggestions: [] },
  general: { label: 'Your task', hint: 'The next actions adapt to the outcome you need', suggestions: [] }
});
export function taskLensFor(run) {
  if (!run) return { kind: 'conversation', ...LENSES.conversation };
  const surface = ['code', 'research'].includes(run?.surface) ? run.surface : run?.adaptation?.primarySurface;
  if (surface === 'code') return { kind: 'coding', ...LENSES.coding };
  if (surface === 'research') return { kind: 'researching', ...LENSES.researching };
  // Prefer an explicit, validated server intent when available.
  const declared = String(run?.adaptation?.presentation?.kind || '').toLowerCase();
  if (Object.hasOwn(LENSES, declared)) return { kind: declared, ...LENSES[declared] };
  const goal = String(run.goal || '').toLowerCase();
  const match = re => re.test(goal);
  const kind = match(/\b(?:brainstorm(?:ing)?|ideat(?:e|ion)|generate ideas|explore ideas|creative alternatives|think of ideas)\b/) ? 'brainstorming'
    : match(/\b(?:plan(?:ning)?|roadmap|milestones?|timeline|strategy|organize|prioriti[sz]e)\b/) ? 'planning'
      : match(/\b(?:compare|versus|trade[- ]?offs?|choose|decide|decision|alternatives?|evaluate options)\b/) ? 'deciding'
        : match(/\b(?:learn|teach|tutorial|explain|quiz|practice|study)\b/) ? 'learning'
          : match(/\b(?:write|rewrite|draft|edit|translate|summari[sz]e|email|letter|essay|article)\b/) ? 'writing'
            : match(/\b(?:design|mockup|wireframe|layout|visual|logo|canvas|illustration|presentation)\b/) ? 'designing'
              : match(/\b(?:code|implement|debug|refactor|frontend|backend|repository|github|program)\b/) ? 'coding'
                : match(/\b(?:research|investigate|evidence|sources|literature review|fact[- ]?check)\b/) ? 'researching' : 'conversation';
  return { kind, ...LENSES[kind] };
}
export function contextualSuggestions(run) {
  return ['complete', 'iterate'].includes(run?.state) ? taskLensFor(run).suggestions : [];
}
