/**
 * MCP/A2A boundary adapters. Neither protocol bypasses the existing gateway.
 */
const text = value => String(value ?? '').trim();

export function normalizeMcpTool(tool = {}) {
  return { name: text(tool.name), description: text(tool.description).slice(0, 2000),
    inputSchema: tool.inputSchema ?? tool.input_schema ?? {},
    annotations: tool.annotations ?? {}, source: text(tool.source) || 'mcp' };
}

export function normalizeMcpServer(server = {}) {
  return { id: text(server.id) || null, name: text(server.name),
    version: text(server.version) || '1',
    tools: Array.isArray(server.tools) ? server.tools.map(normalizeMcpTool).filter(item => item.name) : [],
    resources: Array.isArray(server.resources) ? server.resources.slice(0, 100) : [],
    prompts: Array.isArray(server.prompts) ? server.prompts.slice(0, 100) : [],
    transport: text(server.transport) || 'managed',
    trust: 'untrusted-until-authorized' };
}

export function normalizeA2AAgent(agent = {}) {
  return { id: text(agent.id), name: text(agent.name), url: text(agent.url),
    version: text(agent.version) || '1',
    capabilities: Array.isArray(agent.capabilities) ? agent.capabilities.slice(0, 100) : [],
    skills: Array.isArray(agent.skills) ? agent.skills.slice(0, 100) : [],
    authentication: agent.authentication ?? null,
    trust: 'untrusted-until-authorized', authorization: 'server-gateway-required' };
}

export function delegationEnvelope({ runId, taskId, agentId, goal, successCriteria = [], budget = {}, dataPolicy = {}, expiresAt = null } = {}) {
  return {
    protocol: 'a2a', version: '1.0.0', runId: text(runId), taskId: text(taskId), agentId: text(agentId),
    goal: text(goal).slice(0, 4000), successCriteria: Array.isArray(successCriteria) ? successCriteria.slice(0, 30) : [],
    budget, dataPolicy, expiresAt,
    authority: { mayPropose: true, mayExecute: false, mayApprove: false, mayChangePolicy: false }
  };
}

export function guardedProtocolCall({ protocol, peer, action, authorize = async () => false,
  invoke = async () => { throw new Error('No protocol transport configured'); }, context = {} } = {}) {
  return {
    protocol, peer, action,
    execute: async () => {
      const decision = await authorize({ protocol, peer, action, context });
      if (!decision) {
        const error = new Error('Protocol action denied by Tool Gateway policy');
        error.code = 'protocol-policy-denied';
        throw error;
      }
      return invoke({ protocol, peer, action, context });
    }
  };
}
