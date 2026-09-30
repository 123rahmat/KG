import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

test('the workflow graph grows one task at a time from the current situation', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    let { body: run } = await call('POST', '/api/runs', {
      ...auth,
      body: { goal: 'Research an unfamiliar topic and give me a verified conclusion.', privacyConsent: { modelProvider: true } }
    });

    assert.deepEqual(run.tasks.map(task => task.id), ['understand']);
    assert.equal(run.next, 'understand');

    let response = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth,
      body: {
        taskId: 'understand',
        summary: 'The situation is understood.',
        evidence: {
          structured: {
            successCriteria: ['the conclusion is evidence-backed'],
            next: { type: 'step', title: 'Gather evidence', purpose: 'Collect the evidence needed for the conclusion.' }
          }
        }
      }
    });
    assert.equal(response.status, 200);
    run = (await call('GET', `/api/runs/${run.id}`, auth)).body;
    assert.deepEqual(run.tasks.map(task => task.id), ['understand', 'step']);
    assert.equal(run.next, 'step');

    response = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth,
      body: {
        taskId: 'step',
        summary: 'Evidence gathered.',
        evidence: {
          structured: {
            next: { type: 'step', title: 'Compare evidence', purpose: 'Compare the gathered evidence.' }
          }
        }
      }
    });
    assert.equal(response.status, 200);
    run = (await call('GET', `/api/runs/${run.id}`, auth)).body;
    assert.deepEqual(run.tasks.map(task => task.id), ['understand', 'step', 'step-1']);
    assert.equal(run.next, 'step-1');

    response = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth,
      body: {
        taskId: 'step-1',
        summary: 'The evidence is sufficient.',
        evidence: { structured: { enough: true } }
      }
    });
    assert.equal(response.status, 200);
    run = (await call('GET', `/api/runs/${run.id}`, auth)).body;

    assert.deepEqual(run.tasks.map(task => task.id), ['understand', 'step', 'step-1', 'verify']);
    assert.equal(run.next, 'verify');
    assert.ok(!run.tasks.some(task => ['plan', 'adapt', 'observe', 'reassess', 'deliver', 'iterate'].includes(task.id)));
  }));

test('a changed situation replaces the future instead of executing a prebuilt plan', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    let { body: run } = await call('POST', '/api/runs', {
      ...auth,
      body: { goal: 'Build a solution for a changing requirement.' }
    });

    await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth,
      body: {
        taskId: 'understand',
        summary: 'First requirement understood.',
        evidence: { structured: { next: { type: 'step', title: 'First approach', purpose: 'Try the first approach.' } } }
      }
    });

    run = (await call('GET', `/api/runs/${run.id}`, auth)).body;
    assert.equal(run.tasks.length, 2);

    await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth,
      body: {
        taskId: 'step',
        summary: 'The requirement changed.',
        evidence: { structured: { next: { type: 'step', title: 'Changed approach', purpose: 'Use the new requirement instead.' } } }
      }
    });

    run = (await call('GET', `/api/runs/${run.id}`, auth)).body;
    assert.equal(run.tasks.length, 3);
    assert.equal(run.tasks.at(-1).metadata.createdFrom, 'step');
    assert.equal(run.tasks.at(-1).purpose, 'Use the new requirement instead.');
    assert.equal(run.tasks.at(-1).dependsOn[0], 'step');
  }));
