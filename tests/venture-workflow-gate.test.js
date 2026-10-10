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
