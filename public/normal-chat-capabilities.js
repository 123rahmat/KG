/**
 * Workspace recommendations and lightweight file affordances. Pure presentation:
 * never grants sandbox access, changes run surface, or starts execution.
 */
import { workspaceIntent } from './workspace-intent.js';
const text = value => String(value ?? '').trim();
const codeFile = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|c|cc|cpp|cs|rb|php|swift|sh|sql|html|css)$/i;

export function workspaceCapabilities({
  goal = '', attachments = [], executionTargets = [], currentSurface = 'normal-chat'
} = {}) {
  const files = (Array.isArray(attachments) ? attachments : []).filter(Boolean).slice(0, 10);
  const names = files.map(file => text(typeof file === 'string' ? file : file.name || file.path)).filter(Boolean);
  const codeCount = names.filter(name => codeFile.test(name)).length;
  const archive = files.some(file => ['code-project', 'research-bundle'].includes(file?.archiveKind));
  const requested = text(goal).slice(0, 3000);
  const intent = workspaceIntent(requested);
  const code = (intent.codeTopic && intent.codeProject && intent.execution)
    || intent.softwareBuild || intent.projectLifecycle
    || (intent.execution && codeCount > 1)
    || files.some(file => file?.archiveKind === 'code-project');
  const research = intent.researchProject || intent.researchRequest
    || files.some(file => file?.archiveKind === 'research-bundle')
    || (intent.researchIntent && names.length > 3 && /\b(?:compare sources|verify citations)\b/i.test(requested));
  const destination = intent.explicitWorkspace ?? (intent.researchRequest ? 'research'
    : code ? 'code' : research ? 'research'
      : intent.lightweight && !intent.ongoing && !archive ? 'normal-chat' : null);
  const suggestedWorkspace = destination && destination !== currentSurface ? destination : null;
  const targets = Array.isArray(executionTargets) ? executionTargets : [];
  // A generic code target does not prove an isolated sandbox is connected.
  const sandboxReady = targets.some(target => target?.configured === true
    && (target?.taskTypes ?? []).includes('code')
    && /sandbox/i.test([target?.id, target?.name, target?.kind, target?.type].map(text).join(' ')));
  const showSandbox = currentSurface === 'normal-chat'
    && ((intent.codeTopic && intent.execution) || codeCount > 0);
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
