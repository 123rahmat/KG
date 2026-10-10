/**
 * Low-cost Coding suggestions derived from saved task milestones.
 *
 * Each suggestion is optional, one at a time, and is not a server instruction,
 * an executed action, or evidence that an audit/test/market study happened.
 * Zero provider calls and zero speculative workflow task creation.
 */
const array=x=>Array.isArray(x)?x:[];
const value=x=>typeof x==='string'?x.trim():'';
const terminal=new Set(['complete','failed','blocked','exhausted','iterate']);
const cleanTask=x=>x&&typeof x==='object'?x:{};
const name=x=>value(x?.metadata?.title||x?.purpose||x?.id).slice(0,100);

export function codingMilestoneSuggestion(run) {
  if(!run || !['code'].includes(run.surface||run.adaptation?.primarySurface))return null;
  const tasks=array(run.tasks);
  if(!tasks.length)return null;
  const isComplete=terminal.has(run.state);
  const current=isComplete?null:tasks.find(t=>t?.id===run.next);
  const saved=tasks.filter(t=>t?.status==='complete');
  const latestTest=[...tasks].reverse().find(t=>t?.id==='test-code' || t?.id?.startsWith('test-code-'));
  const testOutcome=cleanTask(latestTest?.evidence?.result);
  const output=cleanTask(testOutcome.output);
  const tests=cleanTask(output.testSummary||testOutcome.testSummary);
  const failedCount=Number(tests.failed);
  const failedTest=latestTest
    && ['complete','failed'].includes(latestTest.status)
    && ((Number.isFinite(failedCount)&&failedCount>0)
      || ['failed','error'].includes(value(output.status||testOutcome.status).toLowerCase()));
  const latestVerify=[...tasks].reverse().find(t=>t?.type==='verify');
  const passed=latestVerify?.status==='complete'
    && latestVerify.evidence?.verdict?.verdict==='pass';
  const idea=saved.find(t=>t.metadata?.ventureDiscovery===true);
  const suggestion=(kind,anchor,title,why,request)=>Object.freeze({
    id:String(run.id??'local')+'|'+String(run.attempt??1)+'|'+kind+'|'+anchor,
    kind,title,why,request,
    provenance:'Suggestion based on recorded workflow state. Nothing runs until you submit it.'
  });
  // Genuine observed failures outrank optional enhancements and are shown
  // once per failed checkpoint, even when the controller is preparing repair.
  if(failedTest && !passed) {
    return suggestion('repair',latestTest.id,'Address the recorded test failure',
      Number.isFinite(failedCount)&&failedCount>0
        ? failedCount+' failing test'+(failedCount===1?'':'s')+' recorded'
        : 'A test execution recorded a failure',
      'Review the actual failing test output, identify the smallest root-cause fix, preserve passing tests, and rerun the affected checks.');
  }
  if(current?.type==='approval' && current.metadata?.planAgreement) {
    return suggestion('scope-review',current.id,'Review the build scope before approving',
      'The server is waiting for approval of the recorded coding plan',
      'Review the proposed MVP scope, affected project files, acceptance tests, privacy and security risks. Identify only changes needed before approving the plan.');
  }
  if(current?.metadata?.ventureDiscovery===true) {
    return suggestion('ideation',current.id,'Make the idea testable',
      'The current recorded step is exploring product directions',
      'Compare the candidate ideas by customer problem, feasibility, differentiation and the cheapest experiment that could invalidate the leading idea. Keep assumptions separate from researched facts.');
  }
  if(current?.metadata?.buildPlan===true && idea) {
    return suggestion('mvp-plan',current.id,'Keep the first build focused',
      'Idea exploration was recorded; the current task is preparing its implementation plan',
      'Scope the chosen idea into the smallest useful MVP, list features to defer, define user-visible acceptance tests and ensure the plan preserves the selected direction.');
  }
  if(current?.id==='test-code' && saved.some(t=>t.id==='build-code')) {
    return suggestion('test-focus',current.id,'Check the changed behavior',
      'Code generation is recorded and its test stage is next',
      'Check the affected modules, error paths and relevant integration tests from the recorded code. Report real test output, not assumed passing results.');
  }
  if(isComplete && passed) {
    return suggestion('release-readiness',latestVerify.id,'Consider release readiness',
      'The saved verification task recorded a passing verdict',
      'Review deployment readiness, rollback, operational monitoring and any unmet security or accessibility checks before considering a release. Do not claim a deployment or audit occurred.');
  }
  if(current?.type==='reassess' && saved.some(t=>t.type==='investigate'||t.type==='code')) {
    const observed=[...saved].reverse().find(t=>['investigate','code'].includes(t.type));
    return suggestion('reassess',current.id,'Use new evidence to refine the approach',
      'A recorded work step is being reassessed: '+name(observed),
      'Compare the latest recorded evidence with the acceptance criteria and suggest a change only if a material gap remains. Otherwise continue the agreed plan.');
  }
  return null;
}
