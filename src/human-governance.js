export const HUMAN_GOVERNANCE_VERSION = '1';
export const HUMAN_GOVERNANCE_PRINCIPLES = Object.freeze(['human-dignity','safety-first','consent-and-privacy','human-agency','server-enforced-boundaries']);
export function buildHumanGovernanceContract({ safety = null, risk = 'ordinary', externalAction = false, physical = false, peopleDecision = false, humanData = false, imageWork = false } = {}) {
  const decision = String(safety?.decision ?? 'allow');
  return Object.freeze({ version: HUMAN_GOVERNANCE_VERSION, priority: 'first', status: decision === 'refuse' ? 'blocked' : decision === 'care' ? 'care' : 'protected', decision, principles: HUMAN_GOVERNANCE_PRINCIPLES, controls: { consentAndPrivacy: humanData || imageWork, humanDecisionRequired: peopleDecision || decision === 'care', authorizationRequired: externalAction || physical || peopleDecision, recheckAfterMaterialChange: true, recheckBeforeExternalEffect: true, recheckBeforeDelivery: true }, enforcement: { serverOwned: true, modelCannotOverride: true, agentCannotOverride: true, skillCannotGrantAuthority: true, toolCannotBypassPolicy: true }, scope: { normalChat: true, coding: true, research: true, design: true, files: true, multiAgent: true, humanRelatedImageWork: imageWork }, risk: String(risk ?? 'ordinary') });
}
export function humanGovernanceAllows(contract) { return contract?.decision !== 'refuse'; }
