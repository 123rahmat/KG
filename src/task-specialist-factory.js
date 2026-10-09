/**
 * Generate temporary main-agent specialties only for explicit, uncovered
 * user/task requirements. A static catalog can never enumerate every future
 * discipline. This is metadata for the existing advisory agent scheduler, not
 * a new service, privilege or independent model planner.
 */
import { createHash } from 'node:crypto';
import { specialistFamilyMatches } from './adaptive-specialist-focus.js';

const SUPPORTED = new Set(['normal-chat','code','research']);
const normalize = v=>typeof v==='string'
  ? v.replace(/\p{Cc}/gu,' ').replace(/\s+/g,' ').trim() : '';
const textOf = item=>normalize(typeof item==='string'?item
  : item?.description??item?.text??item?.title??'');
const generic = /^(?:accurac[yies]|completeness|quality|speed|low cost|efficiency|correctness|safety|reliability|tone|clarity|performance|security|verification|source|comparison|research|testing|compliance|format|audience)$/i;
const distinctWords = s=>new Set(s.toLowerCase().match(/[a-z][a-z'-]{2,}/g)??[]);
const roleId = (surface,s)=>'situational-'+createHash('sha256')
  .update(JSON.stringify([surface,s.toLowerCase()])).digest('hex').slice(0,16);
const immutable = v=>Object.freeze(v);

/**
 * Exhaustive capability catalogs would be expensive and impossible to keep
 * complete. We generate only genuine explicit workstream gaps, scoped to
 * the configured task budget. The user's text is an untrusted assignment.
 */
export function taskSpecialistCandidates({
  surface='normal-chat',goal='',task={},situation={},maxCandidates=6
}={}){
  const workspace=SUPPORTED.has(surface)?surface:'normal-chat';
  const budget=Math.max(0,Math.floor(Number(maxCandidates)||0));
  if(!budget)return immutable([]);
  const metadata=task?.metadata??{};
  const lists=[
    ['acceptance',metadata.acceptanceCriteria],
    ['requirement',metadata.requirements??task?.requirements],
    ['criterion',situation?.successCriteria],
    ['output',situation?.outputs],
    ['unknown',situation?.unknowns]
  ];
  const result=[],seen=new Set();
  for(const [origin,values] of lists){
    if(!Array.isArray(values))continue;
    for(const item of values){
      if(result.length>=budget)break;
      const need=textOf(item).slice(0,220);
      const words=distinctWords(need);
      if(need.length<20||words.size<4||generic.test(need))continue;
      const key=need.toLowerCase();
      if(seen.has(key))continue;
      seen.add(key);
      // Existing relevant specialists should own existing domains. Do not
      // pay for a generated duplicate just to inflate the team count.
      const known=specialistFamilyMatches({surface:workspace,goal:need})
        .some(match=>match.score>=3);
      if(known)continue;
      result.push(immutable({
        role:roleId(workspace,need),surface:workspace,source:origin,
        requirement:need,confidence:'user-specified-not-verified',
        purpose:'Focus on this unmet '+origin+' of the user task: '+need+
          '. Provide precise deliverables, evidence gaps, integration handoffs and falsifiable checks. Do not invent expertise, execute tools or alter the approved scope.',
        authority:'read-only-advisory',
        executable:false,maySpawnAgents:false,mayAccessTools:false
      }));
    }
  }
  return immutable(result);
}
export function taskSpecialistForRole(role,args={}){
  return taskSpecialistCandidates({...args,maxCandidates:Math.max(1,Number(args.maxCandidates)||64)})
    .find(item=>item.role===role)??null;
}
