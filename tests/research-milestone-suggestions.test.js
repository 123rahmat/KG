import test from 'node:test';
import assert from 'node:assert/strict';
import { researchMilestoneSuggestion } from '../public/research-milestone-suggestions.js';
const item=(id,type,status='complete',metadata={})=>({id,type,status,metadata});
const run=(next,tasks=[],workspace={},extra={})=>({
  id:'research-project',surface:'research',state:'running',next,tasks,
  adaptation:{researchWorkspace:workspace},...extra
});
test('Research recommendations require saved project state and never appear in normal or Coding chat',()=>{
  const investigation=run('investigate',[item('investigate','investigate','running')]);
  const suggestion=researchMilestoneSuggestion(investigation);
  assert.equal(suggestion.kind,'source-discovery');
  assert.match(suggestion.why,/no source has been recorded/);
  assert.match(suggestion.request,/actual claims/);
  assert.match(suggestion.provenance,/Nothing runs until you submit/);
  assert.equal(researchMilestoneSuggestion({...investigation,surface:'code'}),null);
  assert.equal(researchMilestoneSuggestion({...investigation,surface:'normal-chat'}),null);
  assert.equal(researchMilestoneSuggestion(run('understand',[
    item('understand','understand','running')
  ])),null);
});
test('saved research conflicts take precedence over generic sourcing suggestions',()=>{
  const w={conflicts:['Contradictory sample results','Unmatched control groups'],
    sourceSet:[{url:'https://example.org/study'}],
    unresolvedQuestions:['Check funding']};
  const suggestion=researchMilestoneSuggestion(run('verify',[
    item('investigate','investigate'),item('verify','verify','pending')
  ],w));
  assert.equal(suggestion.kind,'conflicting-sources');
  assert.match(suggestion.why,/2 unresolved conflicts/);
  assert.match(suggestion.request,/methods/);
  assert.ok(!suggestion.request.includes('conflicts have been resolved'));
});
test('research evidence gaps and citation coverage suggestions report only saved counts',()=>{
  const w={sourceSet:[{key:'url:https://a.com'}],unresolvedQuestions:['Missing date'],
    evidenceLedger:[{summary:'One claim',sourceKeys:['url:https://a.com']},
      {summary:'Another claim',sourceKeys:[]}]};
  const tasks=[item('investigate','investigate'),item('verify','verify','pending')];
  const gap=researchMilestoneSuggestion(run('verify',tasks,w));
  assert.equal(gap.kind,'evidence-gap');
  assert.match(gap.why,/1 unresolved evidence question/);
  const citation=researchMilestoneSuggestion(run('verify',tasks,
    {...w,unresolvedQuestions:[]}));
  assert.equal(citation.kind,'citation-audit');
  assert.match(citation.why,/1 of 2 recorded findings/);
  assert.notEqual(citation.id,gap.id);
});
test('completed evidence-rich research gets an optional single next experiment',()=>{
  const hint=researchMilestoneSuggestion(run(null,[
    item('investigate','investigate'),item('verify','verify'),item('deliver','deliver')
  ],{sourceSet:[{url:'https://example.org/one'}],
    evidenceLedger:[{summary:'Recorded observation'}]}, {state:'complete'}));
  assert.equal(hint.kind,'research-next');
  assert.match(hint.request,/one testable follow-up/);
  assert.equal(researchMilestoneSuggestion(run(null,[
    item('deliver','deliver')
  ],{}, {state:'complete'})),null);
});
