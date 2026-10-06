import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModeControllerContract, controllerForSurface, modeControllerCatalog } from '../src/mode-controllers.js';
import { classifySurfaceBoundary, surfaceIntelligenceProfile, surfaceRuntimePolicy } from '../src/surface-policy.js';

test('three mode controllers are distinct policies over one shared contract', () => {
  const modes=['normal-chat','code','research'];
  const controllers=modes.map(controllerForSurface);
  assert.deepEqual(controllers.map(item=>item.mode),modes);
  assert.equal(new Set(controllers.map(item=>item.id)).size,modes.length);
  assert.deepEqual(modeControllerCatalog().map(item=>item.mode),modes);
});

test('controller effort adapts without changing authority', () => {
  const code=buildModeControllerContract({
    surface:'code', situation:{successCriteria:['correct','tested']}, acceptance:{criteria:['correct','tested']},
    pressure:3, uncertainty:.8, complexity:.7, risk:'medium', remainingBudgetRatio:.9
  });
  assert.equal(code.mode,'code');
  assert.equal(code.decision.recruitSpecialist,true);
  assert.equal(code.decision.parallelIndependentWork,true);
  assert.equal(code.decision.stopWhenSatisfied,true);
  assert.match(code.principle,/one shared state/i);
});

test('visual and design work stays in NormalChat instead of becoming a workspace', () => {
  const boundary=classifySurfaceBoundary('Create a poster layout and visual identity',{activeSurface:'normal-chat',actions:['create']});
  assert.equal(boundary.surface,'normal-chat');
  assert.equal(boundary.redirect,false);
  assert.equal(surfaceRuntimePolicy('design').id,'normal-chat');
  assert.equal(surfaceIntelligenceProfile('design').id,'normal-chat-intelligence');
});

test('deep research and project code retain specialized boundaries', () => {
  assert.equal(classifySurfaceBoundary('Research the latest visual design trends with sources',{activeSurface:'normal-chat',actions:['investigate']}).surface,'research');
  assert.equal(classifySurfaceBoundary('Implement this design in the existing website repository',{activeSurface:'normal-chat',actions:['create','transform']}).surface,'code');
});

test('server run planning persists only the three workspace controllers', async () => {
  const {withServer}=await import('./helpers.js');
  await withServer(async ({call,seed})=>{
    const {token,workspace}=await seed({role:'admin'}); const auth={token,workspace};
    for(const surface of ['normal-chat','code','research']){
      const response=await call('POST','/api/runs',{...auth,body:{
        goal:surface==='research'?'Research this topic with sources.':surface==='code'?'Fix the repository project.':'Explain this clearly.',
        activeSurface:surface
      }});
      assert.equal(response.status,201,JSON.stringify(response.body));
      assert.equal(response.body.adaptation.modeController.mode,surface);
      assert.equal(response.body.adaptation.unifiedAdaptiveWorkflow.modeController.mode,surface);
    }
  });
});

test('visual specialists can still be recruited inside NormalChat', async () => {
  const {rolesFor}=await import('../src/multi-agent.js');
  const run={surface:'normal-chat',goal:'Create and refine a product launch visual and layout',
    situation:{complexity:.8,uncertainty:.7,risk:'medium',successCriteria:['legible','coherent']},
    adaptation:{scale:'complex',effortProfile:{maturity:{pressure:.8}}},attempt:1,
    capabilities:{required:['image-generation']}};
  const result=rolesFor(run,{id:'design',type:'design',metadata:{}},{mode:'always',maxAgents:5});
  assert.ok(result.roles.some(role=>['art-director','visual-designer','image-editor','layout-designer','visual-reviewer'].includes(role)));
});
