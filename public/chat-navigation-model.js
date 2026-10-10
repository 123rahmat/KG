/** Lightweight, workspace-safe navigation over server-authorized chat summaries.
 * Only filters the loaded page. It never merges conversation context or tasks.
 */
const array=x=>Array.isArray(x)?x:[];
const validSurfaces=new Set(['all','code','research','normal-chat']);
const validStatus=new Set(['all','action','working','complete','issues']);
const clean=x=>String(x??'').trim().toLowerCase();
export function chatSurface(chat){
  const value=clean(chat?.surface);
  return ['code','research'].includes(value)?value:'normal-chat';
}
export function chatWorkStatus(chat){
  const state=clean(chat?.state);
  if(['approval','clarify','waiting','iterate','verify'].includes(state))return 'action';
  if(['failed','blocked','exhausted'].includes(state))return 'issues';
  if(state==='complete')return 'complete';
  return 'working';
}
export function chatNavigationModel(chats,{
  projectId=null,surface='all',status='all',query=''
}={}){
  const normalizedSurface=validSurfaces.has(surface)?surface:'all';
  const normalizedStatus=validStatus.has(status)?status:'all';
  const text=clean(query);
  const project=projectId?String(projectId):null;
  const visible=array(chats).filter(chat=>{
    if(!chat?.id)return false;
    if(project && chat.projectId!==project)return false;
    if(normalizedSurface!=='all'&&chatSurface(chat)!==normalizedSurface)return false;
    if(normalizedStatus!=='all'&&chatWorkStatus(chat)!==normalizedStatus)return false;
    // The server uses the same literal chat-title search over the full
    // authorized conversation history. A project-name match here alone
    // would flash and disappear once the server response arrived.
    return !text || clean(chat.title).includes(text);
  });
  // Server list is most recently updated first. Preserve the source ordering
  // to avoid optimistic reorders and false date/status assumptions.
  const all=array(chats);
  return Object.freeze({
    chats:Object.freeze(visible),
    shown:visible.length,
    loaded:all.length,
    coding:all.filter(chat=>chatSurface(chat)==='code').length,
    research:all.filter(chat=>chatSurface(chat)==='research').length,
    needsAction:all.filter(chat=>['action','issues'].includes(chatWorkStatus(chat))).length,
    active:all.filter(chat=>chatWorkStatus(chat)==='working').length,
    isFiltered:Boolean(project||text||normalizedSurface!=='all'||normalizedStatus!=='all'),
    status:normalizedStatus,surface:normalizedSurface
  });
}
