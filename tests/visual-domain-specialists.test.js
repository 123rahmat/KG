import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_SPECIALISTS, domainSpecialistMatch } from '../src/domain-specialists.js';

test('visual specialists are selected only for evidence-backed domain work', () => {
  assert.equal(domainSpecialistMatch('ui-visual-reviewer', {
    surface: 'code', goal: 'Review the UI screenshot against the responsive layout',
    task: { type: 'code' }
  }), 0.99);
  assert.equal(domainSpecialistMatch('research-visualization-reviewer', {
    surface: 'research', goal: 'Verify the scientific chart and data table',
    task: { type: 'verify' }
  }), 0.99);
  assert.equal(domainSpecialistMatch('ui-visual-reviewer', {
    surface: 'research', goal: 'Review this screenshot', task: { type: 'verify' }
  }), 0);
  assert.equal(domainSpecialistMatch('research-visualization-reviewer', {
    surface: 'code', goal: 'Generate a chart in React', task: { type: 'code' }
  }), 0);
  assert.equal(domainSpecialistMatch('ui-visual-reviewer', {
    surface: 'code', goal: 'Fix authentication and SQL queries', task: { type: 'code' }
  }), 0);
  assert.equal(domainSpecialistMatch('research-visualization-reviewer', {
    surface: 'research', goal: 'Check paper reference accuracy', task: { type: 'verify' }
  }), 0);
});

test('visual specialists are advisory-only and cannot assert unseen output', () => {
  for (const name of ['ui-visual-reviewer', 'research-visualization-reviewer']) {
    const info = DOMAIN_SPECIALISTS[name];
    assert.ok(info.purpose);
    assert.match(info.purpose, /never/i);
    assert.ok(info.workspaces.length === 1);
  }
});
