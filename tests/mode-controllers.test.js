import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModeControllerContract, controllerForSurface, modeControllerCatalog, workspaceComputePolicy } from '../src/mode-controllers.js';
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
    surface:'code', situation:{successCriteria:['correct','tested'],independentWork:.82}, acceptance:{criteria:['correct','tested']},
    pressure:3, uncertainty:.8, complexity:.7, risk:'medium', remainingBudgetRatio:.9
  });
  assert.equal(code.mode,'code');
  assert.equal(code.decision.recruitSpecialist,true);
  assert.equal(code.decision.parallelIndependentWork,true);
  assert.equal(code.decision.stopWhenSatisfied,true);
  assert.match(code.principle,/one KG system and shared task lifecycle/i);
  assert.equal(code.controlEngine.id,'coding');
  assert.equal(code.controlEngine.controller,'CodingControlEngine');
  assert.equal(code.sharedRuntime.runStore,'shared-single-source-of-truth');
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

test('Normal Chat visuals use the direct model even with always-agents configured', async () => {
  const {rolesFor}=await import('../src/multi-agent.js');
  const run={surface:'normal-chat',goal:'Create and refine a product launch visual and layout',
    situation:{complexity:.8,uncertainty:.7,risk:'medium',successCriteria:['legible','coherent']},
    adaptation:{scale:'complex',effortProfile:{maturity:{pressure:.8}}},attempt:1,
    capabilities:{required:['image-generation']}};
  const result=rolesFor(run,{id:'design',type:'design',metadata:{}},{mode:'always',maxAgents:5});
  assert.deepEqual(result.roles,[]);
  assert.equal(result.agentCount,0);
  assert.equal(result.decision.reason,'direct-conversation-no-agent-recruitment');
});


test('workspace compute policy keeps simple chat cheap and expands specialized work only when justified', () => {
  const chat = workspaceComputePolicy({ surface:'normal-chat', complexity:.15, uncertainty:.05, independentWork:.2 });
  assert.equal(chat.recommendedAgents, 1);
  assert.equal(chat.maxParallel, 1);
  assert.equal(chat.modelPolicy, 'efficient-first');

  const code = workspaceComputePolicy({ surface:'code', complexity:.8, uncertainty:.45, independentWork:.8, verificationRequired:true });
  assert.ok(code.recommendedAgents >= 3);
  assert.ok(code.maxParallel >= 2);
  assert.match(code.modelPolicy, /frontier-build-and-verify/);

  const research = workspaceComputePolicy({ surface:'research', complexity:.6, uncertainty:.65, independentWork:.9, verificationRequired:true });
  assert.ok(research.recommendedAgents >= 3);
  assert.ok(research.maxParallel >= 2);
  assert.equal(research.qualityFloor, 'verified-before-completion');
});

test('Coding and Research have distinct control profiles but one runtime contract', () => {
  const coding = buildModeControllerContract({ surface:'code' });
  const research = buildModeControllerContract({ surface:'research' });
  assert.equal(research.controlEngine.id,'research');
  assert.equal(research.controlEngine.controller,'ResearchControlEngine');
  assert.notDeepEqual(coding.controlEngine.agents,research.controlEngine.agents);
  assert.notEqual(coding.controlEngine.acceptance,research.controlEngine.acceptance);
  assert.deepEqual(coding.sharedRuntime,research.sharedRuntime);
  const historic = buildModeControllerContract({surface:'normal-chat'});
  assert.equal(historic.controlEngine,undefined,'Legacy chat must not gain active domain work authority');
});
