/**
 * Bounded task-local advisory context. It is a presentation envelope, not a
 * permission, retrieval or verification decision. Preserve full Code
 * implementation inputs; shorten repeating chat/memory for Research/ideas.
 */
const arr=x=>Array.isArray(x)?x:[];
const short=(x,n)=>String(x??'').slice(0,n);
const critical=new Set(['high','critical','high-impact','physical','regulated']);
export function advisorContextEnvelope({
  surface='normal-chat',task={},situation={},conversation=[],remembered=[],
  skills=[],codeIntelligence=null
}={}){
  const compact=surface==='research'||task?.ventureDiscovery===true
    ||task?.metadata?.ventureDiscovery===true;
  const deep=critical.has(String(situation?.risk??'').toLowerCase())
    ||Number(situation?.complexity??0)>=.8||Number(situation?.uncertainty??0)>=.8
    ||['thorough','detailed','long'].includes(String(situation?.need?.depth??'').toLowerCase());
  const turns=compact?(deep?5:3):6;
  const history=arr(conversation).slice(-turns).map(turn=>({
    user:short(turn?.user,compact?(deep?1300:850):1600),
    assistant:short(turn?.assistant,compact?(deep?1300:850):1600)
  }));
  const memories=arr(remembered).slice(-(compact?(deep?9:5):15))
    .map(x=>short(x,compact?(deep?500:350):600));
  const skillCap=compact?(deep?5:3):6;
  const instructions=compact?(deep?1700:900):5000;
  const selectedSkills=arr(skills).slice(0,skillCap).map(skill=>({
    name:skill?.name,version:skill?.version,description:skill?.description,
    instructions:short(skill?.instructions,instructions),
    fingerprint:skill?.fingerprint??null
  }));
  const previewOnly=compact && surface==='code'&&codeIntelligence;
  const code=previewOnly
    ? {
      project:codeIntelligence.project??null,
      focus:codeIntelligence.focus??null,
      // Context is for selecting an idea, not editing source. Real Code
      // builders get unabridged scoped file contents via their own step.
      files:arr(codeIntelligence.files).slice(0,30).map(item=>({
        path:short(item?.path,240)
      }))
    }
    :codeIntelligence;
  return Object.freeze({
    mode:compact?'bounded-advisory':'code-implementation-context',
    conversation:history,remembered:memories,skills:selectedSkills,
    codeIntelligence:code
  });
}
