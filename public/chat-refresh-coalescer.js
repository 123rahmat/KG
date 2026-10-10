/**
 * Debounce background status-list refreshes across concurrent chat runs.
 * Foreground requests and explicit Refresh remain immediate; this only
 * coalesces repeated polling updates and does not affect actual work.
 */
export function createChatRefreshCoalescer(refresh,{
  delayMs=2500,schedule=setTimeout,cancel=clearTimeout
}={}){
  let pending=null;
  const run=()=>{
    pending=null;
    refresh();
  };
  return Object.freeze({
    request(){
      if(pending!==null)return false;
      pending=schedule(run,delayMs);
      return true;
    },
    flush(){
      if(pending===null)return false;
      cancel(pending);
      run();
      return true;
    },
    cancel(){
      if(pending===null)return false;
      cancel(pending);
      pending=null;
      return true;
    }
  });
}
