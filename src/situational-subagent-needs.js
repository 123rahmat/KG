/**
 * Convert the actual acceptance criteria, constraints and observed gaps into
 * extra read-only advisory lenses for a selected parent specialist.
 *
 * A seeded family catalog is a vocabulary, not a fixed roster. These records
 * only affect model context; they grant no authority and never spawn workers.
 */
const normalize = value => typeof value === 'string'
  ? value.replace(/[\p{Cc}]/gu,' ').replace(/\s+/g,' ').trim() : '';
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70);
const operationFor = value =>
  /\b(test|check|verify|audit|validate|assert|quality|acceptance|security)\b/i.test(value) ? 'verify'
    : /\b(source|citation|evidence|research|investigate|unknown|unresolved)\b/i.test(value) ? 'investigate'
      : /\b(fail|bug|error|crash|debug|diagnos|reproduc)\b/i.test(value) ? 'diagnose'
        : /\b(design|plan|layout|schema|architecture|contract)\b/i.test(value) ? 'design' : 'analyze';

/** Only human/task-authored criteria and previously observed gaps qualify. */
export function taskSpecificSubagentNeeds({task={},situation={},observedFindings=[]}={}) {
  const collections = [
    ['success-criterion',situation?.successCriteria],
    ['required-output',situation?.outputs],
    ['explicit-requirement',task?.metadata?.requirements ?? task?.requirements],
    ['acceptance-criterion',task?.metadata?.acceptanceCriteria],
    ['open-question',situation?.unknowns],
    ['failure-evidence',situation?.failures],
    ['observed-unknown',(Array.isArray(observedFindings)?observedFindings:[])
      .filter(f=>f && f.status!=='failed').flatMap(f=>f.unknowns??[])],
    ['observed-risk',(Array.isArray(observedFindings)?observedFindings:[])
      .filter(f=>f && f.status!=='failed').flatMap(f=>f.risks??[])]
  ];
  const unique = new Set();
  const results = [];
  for(const [kind,items] of collections){
    if(!Array.isArray(items))continue;
    for(const value of items){
      const label = normalize(typeof value==='string' ? value
        : (value?.description ?? value?.text ?? value?.title ?? ''));
      if(label.length<8)continue;
      const bounded=label.slice(0,180);
      const key=slug(bounded);
      if(!key || unique.has(key))continue;
      unique.add(key);
      results.push(Object.freeze({
        id:'task-'+key, source:kind,
        deliverable:'Assess the specific '+kind.replaceAll('-',' ')+': '+bounded+
          '. Report gaps and objective checks, not invented evidence.',
        operation:operationFor(bounded),
        authority:'read-only-advisory',
        requirement:bounded
      }));
    }
  }
  return Object.freeze(results);
}
