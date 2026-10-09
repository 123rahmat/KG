import test from 'node:test';
import assert from 'node:assert/strict';
import {
  controllerForSurface, buildModeControllerContract, workspaceComputePolicy
} from '../src/mode-controllers.js';

const mode = (surface, options = {}) => buildModeControllerContract({
  surface, complexity: .85, uncertainty: .65, pressure: 3,
  remainingBudgetRatio: 1, ...options
});

test('Normal Chat answers simple work with a single efficient model path', () => {
  const p = workspaceComputePolicy({ surface: 'normal-chat',
    complexity: .06, uncertainty: .03, independentWork: 0 });
  assert.equal(p.recommendedAgents, 1);
  assert.equal(p.maxParallel, 1);
  assert.equal(p.modelPolicy, 'efficient-first');
  const c = buildModeControllerContract({surface: 'normal-chat'});
  assert.equal(c.decision.recruitSpecialist, false);
  assert.equal(c.decision.parallelIndependentWork, false);
  assert.equal(c.decision.defaultAction, 'direct');
});

test('Complexity does not manufacture independent lanes in any workspace', () => {
  for (const surface of ['normal-chat','code','research']) {
    const c = mode(surface);
    assert.equal(c.decision.parallelIndependentWork, false, surface);
    assert.equal(c.compute.maxParallel, 1, surface);
    assert.equal(c.compute.parallelBasis, 'no-safe-parallelism-established', surface);
  }
});

test('Code agents specialize deeply and parallelize only an observed independent change set', () => {
  const c = mode('code', { situation:{ independentWork: .9 } });
  assert.equal(c.decision.recruitSpecialist, true);
  assert.equal(c.decision.parallelIndependentWork, true);
  assert.ok(c.compute.recommendedAgents >= 3);
  assert.ok(c.compute.maxParallel >= 2);
  assert.equal(c.compute.parallelBasis,'observed-independent-work');
  assert.match(c.verification.default,/diff-plus-targeted-tests/);
  assert.ok(c.roles.includes('implementer'));
  assert.ok(c.roles.includes('test-engineer'));
  assert.ok(c.roles.includes('security-reviewer'));
});

test('Research agents specialize by source quality and safe independent evidence lanes', () => {
  const c = mode('research', { situation:{ independentWork: .8 } });
  assert.equal(c.decision.recruitSpecialist, true);
  assert.equal(c.decision.parallelIndependentWork, true);
  assert.ok(c.compute.maxParallel >= 2);
  assert.match(c.verification.default,/provenance/);
  assert.ok(c.roles.includes('researcher'));
  assert.ok(c.roles.includes('analyst'));
  assert.ok(c.roles.includes('critic'));
  assert.notDeepEqual(c.roles,controllerForSurface('code').roles);
});

test('Low remaining budget suppresses optional teams despite high difficulty', () => {
  for (const surface of ['normal-chat','code','research']) {
    const p = workspaceComputePolicy({ surface,
      complexity: 1, uncertainty: 1, independentWork: 1,
      remainingBudgetRatio: .1, verificationRequired: true });
    assert.equal(p.budgetMode, 'conserve');
    assert.equal(p.recommendedAgents, 1);
    assert.equal(p.maxParallel, 1);
    assert.equal(p.qualityFloor, 'verified-before-completion');
  }
});

test('Safety serializes high-impact work, even when subgoals are independent', () => {
  for (const surface of ['normal-chat','code','research']) {
    const p = workspaceComputePolicy({surface,complexity:.9,uncertainty:.8,
      risk:'high-impact',independentWork:1,remainingBudgetRatio:1});
    assert.equal(p.maxParallel,1);
  }
});

test('When acceptance is verified, do not recruit more agents or expand work', () => {
  for (const surface of ['normal-chat','code','research']) {
    const c = mode(surface,{
      situation: {independentWork:1},
      acceptance:{satisfied:true,verificationSatisfied:true}
    });
    assert.equal(c.decision.recruitSpecialist,false,surface);
    assert.equal(c.decision.parallelIndependentWork,false,surface);
    assert.equal(c.decision.stopWhenSatisfied,true);
    assert.equal(c.decision.reuseVerifiedState,true);
  }
});

test('Normal Chat can still adapt for difficult tasks without a separate brain', () => {
  const c=mode('normal-chat',{situation:{independentWork:.8}});
  assert.equal(c.decision.recruitSpecialist,false);
  assert.equal(c.decision.parallelIndependentWork,false);
  assert.equal(c.compute.recommendedAgents,1);
  assert.equal(c.compute.maxParallel,1);
  assert.match(c.principle,/one shared state/i);
});

test('unknown compute budgets retain scoped expertise without false conservation', () => {
  for (const surface of ['normal-chat', 'code', 'research']) {
    for (const remainingBudgetRatio of [null, undefined, '', ' ', NaN, Infinity]) {
      const c = mode(surface, { remainingBudgetRatio });
      assert.equal(c.compute.budgetMode, 'normal');
      assert.equal(c.decision.recruitSpecialist, surface !== 'normal-chat');
      assert.equal(c.decision.reduceEffort, false);
    }
  }
});
