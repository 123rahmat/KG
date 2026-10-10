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
