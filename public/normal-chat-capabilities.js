/**
 * Workspace recommendations and lightweight file affordances. Pure presentation:
 * never grants sandbox access, changes run surface, or starts execution.
 */
const text = value => String(value ?? '').trim();
const codeFile = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|c|cc|cpp|cs|rb|php|swift|sh|sql|html|css)$/i;
const codeProject = /\b(?:repository|repo|codebase|github|full[- ]?stack|entire application|whole app|project architecture|deployment|frontend and backend|build an app)\b/i;
const researchProject = /\b(?:thesis|dissertation|systematic review|literature review|academic paper|research paper|meta-analysis|research project|comprehensive research|multi[- ]source study)\b/i;
const softwareBuild = /\b(?:build|develop|create|implement)\b.{0,100}\b(?:website|web app|application|app|API|backend|frontend|(?:web|API|backend|micro|HTTP|REST)[- ]?service)\b/i;
const researchRequest = /^(?:(?:please|can you|could you|help me)\s+)*(?:research|investigate|find sources|compare sources)\b/i;
const lightweightRequest = /^(?:(?:please|can you|could you|help me)\s+)*(?:translate|rewrite|summarize|explain|calculate|brainstorm|draft|hello|hi|thanks)\b/i;
const ongoingWork = /\b(?:findings?|previous results?|next steps?|our work|work so far|current (?:project|task|investigation)|(?:the|this|these|those) (?:results?|evidence|sources?|implementation|changes?))\b/i;
const executionIntent = /\b(?:run|execute|debug|fix|repair|test|refactor|implement|compile|build)\b/i;
const researchIntent = /\b(?:research|investigate|find sources|literature|citations|evidence)\b/i;

export function workspaceCapabilities({
  goal = '', attachments = [], executionTargets = [], currentSurface = 'normal-chat'
} = {}) {
  const files = (Array.isArray(attachments) ? attachments : []).filter(Boolean).slice(0, 10);
  const names = files.map(file => text(typeof file === 'string' ? file : file.name || file.path)).filter(Boolean);
  const codeCount = names.filter(name => codeFile.test(name)).length;
  const archive = files.some(file => ['code-project', 'research-bundle'].includes(file?.archiveKind));
  const requested = text(goal).slice(0, 3000);
  const code = (codeProject.test(requested) && executionIntent.test(requested))
    || softwareBuild.test(requested)
    || (executionIntent.test(requested) && codeCount > 1)
    || files.some(file => file?.archiveKind === 'code-project');
  const research = researchProject.test(requested)
    || researchRequest.test(requested)
    || files.some(file => file?.archiveKind === 'research-bundle')
    || (researchIntent.test(requested) && names.length > 3 && /\b(?:compare sources|verify citations)\b/i.test(requested));
  const destination = researchRequest.test(requested) ? 'research'
    : code ? 'code' : research ? 'research'
      : lightweightRequest.test(requested) && !ongoingWork.test(requested) && !archive ? 'normal-chat' : null;
  const suggestedWorkspace = destination && destination !== currentSurface ? destination : null;
  const targets = Array.isArray(executionTargets) ? executionTargets : [];
  // A generic code target does not prove an isolated sandbox is connected.
  const sandboxReady = targets.some(target => target?.configured === true
    && (target?.taskTypes ?? []).includes('code')
    && /sandbox/i.test([target?.id, target?.name, target?.kind, target?.type].map(text).join(' ')));
  const showSandbox = currentSurface === 'normal-chat'
    && (executionIntent.test(requested) || codeCount > 0);
  return Object.freeze({
    fileCount: names.length,
    multiFile: names.length > 1,
    sandboxReady, showSandbox,
    suggestedWorkspace,
    suggestion: suggestedWorkspace === 'code'
      ? 'Code is better suited to this coding task, with project context, revision-safe edits and dedicated specialists. You can also stay here.'
      : suggestedWorkspace === 'research'
        ? 'Research is better suited to this investigation, with source tracking, evidence and focused research tools. You can also stay here.'
        : suggestedWorkspace === 'normal-chat'
          ? 'Normal Chat is a simpler fit for this request. Your draft and selected files stay with you.'
          : null,
    archive
  });
}

// Retain the existing presentation helper for callers using its original name.
export const normalChatCapabilities = workspaceCapabilities;
