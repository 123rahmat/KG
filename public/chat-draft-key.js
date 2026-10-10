/** Stable in-tab draft boundary. Does not provide cross-chat memory. */
export function chatDraftKey({principalId,workspaceId,conversationId,projectId,surface}={}){
  const owner=String(principalId??'unsigned');
  const workspace=String(workspaceId??'none');
  const context=conversationId
    ?'chat:'+String(conversationId)
    :'new:'+String(projectId??'none')+':'+String(surface??'normal-chat');
  return [owner,workspace,context].join('|');
}
