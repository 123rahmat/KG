/**
 * A conversation remains bound to its recorded project. The sidebar's
 * project filter is navigation only; changing it never relinks existing
 * conversation history or source files.
 */
export function submissionProjectId({
  currentProjectId=null,chatProjectId=null,hasSavedRuns=false
}={}){
  return hasSavedRuns
    ? (typeof chatProjectId==='string'&&chatProjectId?chatProjectId:null)
    : (typeof currentProjectId==='string'&&currentProjectId
      ?currentProjectId
      :typeof chatProjectId==='string'&&chatProjectId?chatProjectId:null);
}
export function submissionWorkspaceSurface({
  chatSurface=null,chosenSurface='normal-chat',hasSavedRuns=false
}={}){
  if(hasSavedRuns && ['code','research','normal-chat'].includes(chatSurface)){
    return chatSurface;
  }
  return ['code','research'].includes(chosenSurface)?chosenSurface:'normal-chat';
}

/**
 * A retry/regeneration is another run in the *original* conversation.
 * Sidebar project, current UI surface and unrelated foreground chat are
 * intentionally not consulted. Null project IDs stay null.
 */
export function retrySubmissionScope(run={},chat={}){
  const conversationId=run.conversationId??chat.id??null;
  const projectId=Object.hasOwn(run,'projectId')?run.projectId:chat.projectId??null;
  const activeSurface=['code','research'].includes(run.surface)
    ? run.surface:['code','research'].includes(run.adaptation?.primarySurface)
      ? run.adaptation.primarySurface:'normal-chat';
  const workspaceSourceId=run.adaptation?.workspaceSourceId??chat.workspaceSourceId??null;
  return Object.freeze({conversationId,projectId,activeSurface,workspaceSourceId});
}
