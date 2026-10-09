/**
 * Each specialist family can be selected as a task-scoped main agent.
 * These are advisory roles, not autonomous services or execution grants.
 */
import { SPECIALIST_FAMILIES, specialistFamilyMatches } from './adaptive-specialist-focus.js';

export const FAMILY_MAIN_AGENTS = Object.freeze(Object.fromEntries(
  Object.entries(SPECIALIST_FAMILIES).flatMap(([surface, families]) =>
    Object.entries(families).map(([family, subagents]) => {
      const role = (surface === 'normal-chat' ? 'chat' : surface) + '-' + family + '-lead';
      return [role, Object.freeze({
        role, family, surface, workspaces: Object.freeze([surface]),
        subagents, bestFor: Object.freeze(surface === 'code'
          ? ['code','build-code','plan','implement','debug-code','test-code','verify-code','refactor-code']
          : surface === 'research'
            ? ['research','investigate','analyze','plan','respond','verify','deliver']
            : ['respond','plan','analyze','write','edit','deliver','transform','design']),
        purpose: 'Coordinate bounded '+family.replaceAll('-',' ')+' reasoning within supplied evidence and the current task. Never claim tool use without a real execution receipt.'
      })];
    })
  )
));

export function familyMainAgentMatch(role, { surface = 'normal-chat', goal = '', task = {} } = {}) {
  const agent = FAMILY_MAIN_AGENTS[role];
  if (!agent || agent.surface !== surface || !String(goal).trim()) return 0;
  // Multiple relevant leads may serve distinct requirements of one task.
  // No static "single winning family" or catalogue-size recruitment rule.
  const match = specialistFamilyMatches({ surface, goal })
    .find(item => item.family === agent.family);
  if (!match || match.score < 3) return 0;
  const kind = String(task?.type ?? '').toLowerCase();
  const taskId = String(task?.id ?? '').toLowerCase();
  const fit = Math.min(0.98, 0.74 + match.score * 0.055);
  return agent.bestFor.includes(kind) || agent.bestFor.includes(taskId)
    ? fit : Math.max(0,fit - 0.07);
}

export function familyMainAgentStats() {
  return Object.freeze(Object.fromEntries(['normal-chat','code','research'].map(surface => {
    const agents = Object.values(FAMILY_MAIN_AGENTS).filter(agent => agent.surface === surface);
    return [surface, Object.freeze({
      mainAgents: agents.length,
      subagents: agents.reduce((sum, agent) => sum + agent.subagents.length, 0)
    })];
  })));
}
