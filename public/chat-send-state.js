/**
 * Track in-flight message submissions by authenticated workspace and
 * conversation. Moving between chats never leaves an unrelated composer
 * locked, and a late response cannot unlock a different conversation.
 *
 * This is browser UI state only. Server idempotency and run locks still
 * own replay, ordering, policy and persistence decisions.
 */
export function chatSendKey(workspaceId,conversationId) {
  if(!workspaceId || !conversationId)return null;
  return JSON.stringify([String(workspaceId),String(conversationId)]);
}
export function chatIsSending(state,chat=state?.chat,workspaceId=state?.workspaceId) {
  const key=chatSendKey(workspaceId,chat?.id);
  return Boolean(key && state?.sendingChats?.has(key));
}
export function syncVisibleChatSending(state){
  state.sendWaiting=chatIsSending(state);
  return state.sendWaiting;
}
export function markChatSending(state,chat,workspaceId,sending){
  const key=chatSendKey(workspaceId,chat?.id);
  if(!key)return syncVisibleChatSending(state);
  state.sendingChats??=new Set();
  if(sending)state.sendingChats.add(key);
  else state.sendingChats.delete(key);
  return syncVisibleChatSending(state);
}
