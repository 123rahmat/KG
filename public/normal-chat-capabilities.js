/**
 * Lightweight Normal Chat affordances. Pure, presentation-only signals:
 * never grants sandbox access, changes run surface, or starts execution.
 */
const text = value => String(value ?? '').trim();
const codeFile = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|c|cc|cpp|cs|rb|php|swift|sh|sql|html|css)$/i;
const codeProject = /\b(?:repository|repo|codebase|github|full[- ]stack|entire application|whole app|project architecture|deployment|frontend and backend|build an app)\b/i;
const researchProject = /\b(?:thesis|dissertation|systematic review|literature review|academic paper|research paper|meta-analysis|research project|comprehensive research|multi[- ]source study)\b/i;
const executionIntent = /\b(?:run|execute|debug|fix|repair|test|refactor|implement|compile|build)\b/i;
const researchIntent = /\b(?:research|investigate|find sources|literature|citations|evidence)\b/i;

export function normalChatCapabilities({
  goal = '', attachments = [], executionTargets = [], currentSurface = 'normal-chat'
} = {}) {
  const files = (Array.isArray(attachments) ? attachments : []).filter(Boolean).slice(0, 10);
  const names = files.map(file => text(typeof file === 'string' ? file : file.name || file.path)).filter(Boolean);
  const codeCount = names.filter(name => codeFile.test(name)).length;
  const archive = files.some(file => ['code-project', 'research-bundle'].includes(file?.archiveKind));
  const requested = text(goal).slice(0, 3000);
  const code = codeProject.test(requested)
    || (executionIntent.test(requested) && codeCount > 1)
    || files.some(file => file?.archiveKind === 'code-project');
  const research = researchProject.test(requested)
    || files.some(file => file?.archiveKind === 'research-bundle')
    || (researchIntent.test(requested) && names.length > 3 && /\b(?:compare sources|verify citations)\b/i.test(requested));
  const suggestedWorkspace = currentSurface === 'normal-chat'
    ? code ? 'code' : research ? 'research' : null
    : null;
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
      ? 'For a larger code project, Code adds revision-safe edits and dedicated specialists. You can also stay here.'
      : suggestedWorkspace === 'research'
        ? 'For a long research project, Research tracks sources, evidence and thesis progress. You can also stay here.'
        : null,
    archive
  });
}
