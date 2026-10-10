import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from '../src/runs.js';

const makeDb=()=> {
  const saved=[];
  const client={query:async (sql,args=[])=>{
    if(sql.includes('SELECT * FROM run_tasks WHERE run_id'))return {rows:saved.map((item,index)=>({
      run_id:'r1',id:item.id,position:index,type:item.type,status:item.status,
      depends_on:item.dependsOn,requires:item.requires,
      purpose:item.purpose,metadata:item.metadata,evidence:item.evidence??null
    }))};
    if(sql.includes('INSERT INTO run_tasks')&&sql.includes('VALUES ($1')){
      const [,id,position,type,dependencies,requires,purpose,metadata]=args;
      saved.push({id,position,type,status:'pending',dependsOn:JSON.parse(dependencies),
        requires:JSON.parse(requires),purpose,metadata:JSON.parse(metadata)});
      return {rows:[]};
    }
    return {rows:[]};
  }};
  return {saved,client};
};
const goal='Brainstorm different SaaS startup ideas, select the best, then build a new product MVP';
const baseRun=()=>({
  id:'r1',surface:'code',goal,situation:{risk:'ordinary',complexity:.7,
    successCriteria:['Select an MVP direction','Build only the approved implementation']},
  adaptation:{workflow:'full',scale:'complex',resourcePlan:{}},
  governance:{status:'unconfigured'},
  capabilities:{granted:['code-generation','reasoning','verification'],
    required:['code-generation']}
});
const emptyRequirements={version:1,items:[],completionReady:false};

test('server task graph enforces idea exploration before plan approval and code generation',async()=>{
  const {saved,client}=makeDb();
  const store=new RunStore(null);
  const understand={id:'understand',type:'understand',status:'complete',metadata:{}};
  saved.push({...understand,dependsOn:[],requires:['reasoning'],
    purpose:'Understand the desired outcome'});
  const run=baseRun();
  await store.adaptSteps(client,run,understand,{questions:[]},emptyRequirements);
  assert.equal(saved.at(-1).type,'step');
  assert.equal(saved.at(-1).metadata.ventureDiscovery,true);
  const venture=saved.at(-1);venture.status='complete';
  await store.adaptSteps(client,run,venture,{
    result:'Three concepts compared; selected a customer-support SaaS MVP.',
    enough:true
  },emptyRequirements);
  assert.equal(saved.at(-1).type,'plan');
  assert.equal(saved.at(-1).metadata.buildPlan,true,
    'even model enough:true cannot bypass build planning');
  const plan=saved.at(-1);plan.status='complete';
  await store.adaptSteps(client,run,plan,{summary:'Scoped MVP and validation'},
    emptyRequirements);
  assert.equal(saved.at(-1).type,'approval');
  assert.equal(saved.at(-1).metadata.planAgreement,true);
  const approval=saved.at(-1);approval.status='complete';
  await store.adaptSteps(client,run,approval,{approved:true},emptyRequirements);
  assert.equal(saved.at(-1).id,'build-code');
  assert.equal(saved.at(-1).type,'code');
  assert.ok(saved.findIndex(item=>item.metadata?.ventureDiscovery)
    <saved.findIndex(item=>item.id==='build-code'));
  assert.ok(saved.findIndex(item=>item.type==='approval')
    <saved.findIndex(item=>item.id==='build-code'));
});

test('ordinary code fixing does not introduce a speculative venture step',async()=>{
  const {saved,client}=makeDb();
  const store=new RunStore(null);
  const understand={id:'understand',type:'understand',status:'complete',metadata:{},
    dependsOn:[],requires:[],purpose:'Read the current state'};
  saved.push(understand);
  const run={...baseRun(),goal:'Fix the current cache bug in src/cache.js'};
  await store.adaptSteps(client,run,understand,{questions:[]},emptyRequirements);
  assert.equal(saved.at(-1).metadata.ventureDiscovery,undefined);
});

test('explicit skip-brainstorm request keeps the existing direct build plan route',async()=>{
  const {saved,client}=makeDb();
  const store=new RunStore(null);
  const understand={id:'understand',type:'understand',status:'complete',metadata:{},
    dependsOn:[],requires:[],purpose:'Read the current state'};
  saved.push(understand);
  const run={...baseRun(),goal:'Just build it: create a startup SaaS MVP app'};
  await store.adaptSteps(client,run,understand,{questions:[]},emptyRequirements);
  assert.equal(saved.at(-1).metadata.ventureDiscovery,undefined);
});

test('an untrusted model suggestion cannot build or claim enough before idea exploration',async()=>{
  const {saved,client}=makeDb();
  const store=new RunStore(null);
  const understood={id:'understand',type:'understand',status:'complete',
    metadata:{},dependsOn:[],requires:[],purpose:'Understand the idea'};
  saved.push(understood);
  const run=baseRun();
  await store.adaptSteps(client,run,understood,{
    enough:true,next:{type:'code',title:'Generate code immediately',
      purpose:'Skip idea selection and implement now'}
  },emptyRequirements);
  assert.equal(saved.at(-1).metadata.ventureDiscovery,true);
  assert.equal(saved.at(-1).type,'step');
  assert.equal(saved.at(-1).id,'step');
  assert.ok(!saved.some(t=>t.id==='build-code'));
});

test('the user may skip brainstorming, but the coding plan approval is not skipped',async()=>{
  const {saved,client}=makeDb();
  const store=new RunStore(null);
  const root={id:'understand',type:'understand',status:'complete',
    dependsOn:[],requires:[],metadata:{},purpose:'Understand constraints'};
  saved.push(root);
  const run={...baseRun(),goal:'Skip brainstorming and build a startup SaaS app'};
  await store.adaptSteps(client,run,root,{questions:[]},emptyRequirements);
  assert.equal(saved.at(-1).type,'plan');
  assert.equal(saved.at(-1).metadata.buildPlan,true);
  assert.notEqual(saved.at(-1).metadata.ventureDiscovery,true);
});

test('saved venture phase mode travels into the server-owned step metadata',async()=>{
  const {saved,client}=makeDb();
  const store=new RunStore(null);
  const understood={id:'understand',type:'understand',status:'complete',
    metadata:{},dependsOn:[],requires:[],purpose:'Understand the idea'};
  saved.push(understood);
  const run={...baseRun(),goal:'Validate my idea for a startup SaaS app and build an MVP'};
  await store.adaptSteps(client,run,understood,{enough:true,next:{type:'code'}},emptyRequirements);
  assert.equal(saved.at(-1).metadata.ventureDiscovery,true);
  assert.equal(saved.at(-1).metadata.ventureMode,'validate-selected');
  assert.match(saved.at(-1).purpose,/Keep the user-selected idea/);
});

test('server does not let an early enough:true skip ordinary Code build or approval',async()=>{
  const {saved,client}=makeDb();
  const store=new RunStore(null);
  const understood={id:'understand',type:'understand',status:'complete',
    metadata:{},dependsOn:[],requires:['reasoning'],purpose:'Understand existing code'};
  saved.push(understood);
  const run={...baseRun(),goal:'Build a new inventory dashboard application'};
  await store.adaptSteps(client,run,understood,{
    enough:true,next:{type:'verify',purpose:'Claim the dashboard already works'}
  },emptyRequirements);
  assert.equal(saved.at(-1).type,'plan');
  assert.equal(saved.at(-1).metadata.buildPlan,true);
  assert.equal(saved.at(-1).metadata.selectedBy,'server-required-stage-gate');
  const planned=saved.at(-1);
  planned.status='complete';
  await store.adaptSteps(client,run,planned,{
    enough:true,next:{type:'code',purpose:'Skip user approval'}
  },emptyRequirements);
  assert.equal(saved.at(-1).type,'approval');
  assert.equal(saved.at(-1).metadata.planAgreement,true);
});
test('server does not let an early answer skip explicitly planned Research retrieval',async()=>{
  const {saved,client}=makeDb();
  const store=new RunStore(null);
  const understood={id:'understand',type:'understand',status:'complete',
    metadata:{},dependsOn:[],requires:['reasoning'],purpose:'Understand research question'};
  saved.push(understood);
  const run={...baseRun(),surface:'research',
    goal:'Review the strongest sources for software supply chain security',
    capabilities:{required:['evidence-retrieval'],
      granted:['evidence-retrieval','verification']}};
  await store.adaptSteps(client,run,understood,{enough:true,
    next:{type:'respond',purpose:'Produce answer without research'}},emptyRequirements);
  // Source retrieval goes through the ordinary governed approval boundary,
  // not straight to the external research tool.
  assert.equal(saved.at(-1).type,'approval');
  assert.equal(saved.at(-1).metadata.approvalFor.type,'investigate');
  const approval=saved.at(-1);approval.status='complete';
  await store.adaptSteps(client,run,approval,{approved:true},emptyRequirements);
  assert.equal(saved.at(-1).type,'investigate');
  assert.match(saved.at(-1).purpose,/Gather authorized sources/);
});
