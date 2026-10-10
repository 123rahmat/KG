/**
 * Output economy for final Research answers. Never limit internal verification,
 * citations required by a user, code bundles, or explicitly long deliverables.
 * The provider receives a ceiling, not a target number of words.
 */
const longForm= /\b(?:comprehensive|exhaustive|in[- ]depth|in detail|detailed|full (?:report|paper|study|review|analysis|chapter)|systematic review|literature review|thesis|dissertation|manuscript|journal article|long[- ]form|step[- ]by[- ]step|all sources|complete bibliography)\b/i;
const outputTypes=/\b(?:essay|paper|report|proposal|literature review|chapter|dissertation|thesis|manuscript)\b/i;
const positive=v=>Number.isFinite(Number(v))?Math.max(0,Math.min(1,Number(v))):0;
const strings=values=>(Array.isArray(values)?values:[]).map(item=>
  typeof item==='string'?item:item?.description??item?.text??'').filter(Boolean);
export function researchResponseTokenCap({run={},task={}}={}){
  const surface=run?.surface??run?.adaptation?.primarySurface;
  if(surface!=='research'||!['respond','deliver'].includes(task?.type))return null;
  const need=run.situation?.need??{};
  const userPrefs=run.situation?.user?.preferences??{};
  const depth=String(need.depth??userPrefs.answerLength??'').toLowerCase();
  const goal=String(run.goal??'');
  const deliverable=String(need.deliverable??'');
  const form=String(need.form??'');
  const criteria=strings(run.situation?.successCriteria);
  if(depth==='thorough'||depth==='detailed'||depth==='long'
    ||longForm.test(goal)||longForm.test(deliverable)
    ||(outputTypes.test(form)&&!/brief|summary|short|bullet|point/i.test(form))
    ||criteria.length>9)return null;
  const pressure=Math.max(
    positive(run.situation?.complexity),
    positive(run.situation?.uncertainty),
    ['high','critical','regulated','high-impact'].includes(String(run.situation?.risk??'').toLowerCase()) ? 0.9 : 0
  );
  // These are generous safety ceilings for ordinary concise findings, not
  // instructions to spend the allowance. High stakes get more room for evidence.
  return pressure>=.75?5400:pressure>=.4?3600:2600;
}
