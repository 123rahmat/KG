import test from 'node:test';
import assert from 'node:assert/strict';
import {readStepAnswer,normalizeVentureDecision} from '../src/step-plan.js';
import {liveWorkSnapshot} from '../public/live-work-model.js';
import {systemPromptFor} from '../src/reasoning-context.js';
import {answersInJson} from '../src/routes/execution.js';

const result={
  result:'Three user-focused ideas assessed; recommend the smallest validated experiment before an MVP.',
  enough:false,
  ideas:[
    {name:'Clinic Queue',customer:'small clinics',problem:'long patient queues',value:'predictable appointment slots',assumption:'clinics will adopt scheduling',cheapTest:'run five opt-in demos'},
    {name:'Local Pickup',customer:'small stores',problem:'lost walk-in sales',value:'reserve goods on the phone',assumption:'customers prefer pickup',cheapTest:'landing page sign-up'},
    {name:'Waste Tracker',customer:'local restaurants',problem:'unsold fresh food',value:'reduce unsold goods',assumption:'restaurants can log stock daily',cheapTest:'paper diary for a week'}
  ],
  selectedIdea:'Clinic Queue',
  decisionReason:'A small single-location pilot requires less operational setup.',
  successMeasure:'At least two clinics volunteer for a pilot.'
};

test('venture step saves a bounded structured idea comparison for the next build plan',()=>{
  const parsed=readStepAnswer(JSON.stringify(result),{ventureDiscovery:true});
  assert.equal(parsed.text,result.result);
  assert.equal(parsed.enough,false);
  assert.equal(parsed.ventureDecision.ideas.length,3);
  assert.equal(parsed.ventureDecision.selectedIdea,'Clinic Queue');
  assert.equal(parsed.ventureDecision.successMeasure,result.successMeasure);
  assert.equal(parsed.ventureDecision.provenance,'model-proposal-unverified');
  assert.ok(!Object.hasOwn(parsed.ventureDecision,'approved'));
  assert.ok(!Object.hasOwn(parsed.ventureDecision,'verified'));
  const general=readStepAnswer(JSON.stringify(result));
  assert.equal(general.ventureDecision,undefined,
    'ordinary steps must not claim idea comparison artifacts');
});
test('malformed options are filtered, duplicates and lengths bounded and unknown recommendations not endorsed',()=>{
  const candidates=Array.from({length:18},(_,index)=>({
    name:index===1?' IDEA 0 ':'Idea '+index,
    customer:'c'.repeat(500),problem:'p'.repeat(500),
    value:'v'.repeat(500),assumption:'a'.repeat(500),cheapTest:'t'.repeat(500)
  }));
  candidates.push({name:'Missing justification'});
  const record=normalizeVentureDecision({ideas:candidates,selectedIdea:'Imaginary idea',
    decisionReason:'x'.repeat(3000)});
  assert.ok(record);
  assert.equal(record.ideas.length,6);
  assert.equal(record.selectedIdea,'');
  assert.equal(record.ideas[0].customer.length,180);
  assert.equal(record.ideas[0].problem.length,200);
  assert.equal(record.decisionReason.length,400);
  assert.equal(normalizeVentureDecision({ideas:[{name:'Guess'}]}),null);
  assert.equal(normalizeVentureDecision(null),null);
});
test('main work area shows only SAVED COMPLETED proposed options, never invented validation or approvals',()=>{
  const pending={id:'step',type:'step',status:'pending',metadata:{ventureDiscovery:true,
    title:'Explore and test the idea'},evidence:{structured:{ventureDecision:
    readStepAnswer(JSON.stringify(result),{ventureDiscovery:true}).ventureDecision}}};
  const base={surface:'code',state:'running',next:'step',tasks:[pending]};
  const before=liveWorkSnapshot(base);
  assert.equal(before.entries.some(item=>item.type==='ideas'),false);
  const complete=liveWorkSnapshot({...base,state:'complete',next:null,
    tasks:[{...pending,status:'complete'}]});
  const ideas=complete.entries.find(item=>item.type==='ideas');
  assert.ok(ideas);
  assert.equal(ideas.table.rows.length,3);
  assert.deepEqual(ideas.table.header,
    ['Idea','User problem','Value','Main assumption','Cheap experiment']);
  assert.equal(ideas.selectedIdea,'Clinic Queue');
  assert.match(ideas.table.name,/not verified/);
  assert.equal(complete.entries.filter(item=>item.taskId==='step'&&item.type==='text').length,0);
});
test('research offers the same bounded proposed comparison without pretending it conducted experiments',()=>{
  const decision=readStepAnswer(JSON.stringify(result),{ventureDiscovery:true}).ventureDecision;
  const snapshot=liveWorkSnapshot({surface:'research',state:'complete',tasks:[
    {id:'step',type:'step',status:'complete',metadata:{ventureDiscovery:true},
      evidence:{structured:{ventureDecision:decision},text:result.result}}
  ]});
  assert.equal(snapshot.entries[0].type,'ideas');
  assert.equal(snapshot.entries[0].successMeasure,result.successMeasure);
  assert.equal(snapshot.entries.filter(item=>item.type==='text').length,0);
});
test('ideation instructions request structured options but do not grant build authority',()=>{
  const rules=systemPromptFor({
    task:{type:'step',metadata:{ventureDiscovery:true}},
    run:{surface:'code',goal:'Brainstorm startup app ideas and build an MVP',
      situation:{}},payload:{}
  });
  assert.ok(rules.includes('"ideas":[{"name":""'));
  assert.match(rules,/"selectedIdea"/);
  assert.match(rules,/never user approval/);
  assert.match(rules,/"enough":false/);
});

test('venture-only step requests structured JSON without forcing every generic step',()=>{
  assert.equal(answersInJson({type:'step',metadata:{ventureDiscovery:true}}),true);
  assert.equal(answersInJson({type:'step',metadata:{}}),false);
  assert.equal(answersInJson({type:'plan'}),true);
});
