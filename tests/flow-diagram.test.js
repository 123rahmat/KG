import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlowDiagram } from '../public/flow-diagram.js';
import { parseMarkdown } from '../public/markdown.js';

test('short linear process becomes a safe, bounded diagram model', () => {
  assert.deepEqual(parseFlowDiagram('Read files -> Edit changes -> Run tests -> Verify'), [
    'Read files', 'Edit changes', 'Run tests', 'Verify'
  ]);
  assert.deepEqual(parseFlowDiagram('Understand\nWork\nCheck'), [
    'Understand', 'Work', 'Check'
  ]);
});

test('unrelated text and branching graph syntax are not falsely rendered as linear diagrams', () => {
  for (const raw of ['Only one step', 'A -> B\nA -> C', 'graph TD\nA --> B', 'A -> B ->', 'A <script> -> B']) {
    assert.equal(parseFlowDiagram(raw), null);
  }
});

test('huge diagrams cannot exhaust the answer UI', () => {
  assert.equal(parseFlowDiagram('A -> ' + 'a'.repeat(1700)), null);
  assert.equal(parseFlowDiagram(Array.from({ length: 12 }, (_, n) => String(n)).join(' -> ')), null);
});

test('regular code, tables and prose remain distinct from opt-in flow diagrams', () => {
  const content = 'Here is a quick explanation.\n\n' +
    '| Step | Result |\n| --- | --- |\n| A | Passed |\n\n' +
    '~~~flow\nInspect -> Verify\n~~~\n\n' +
    '~~~js\nconst x = 1;\n~~~';
  const blocks = parseMarkdown(content);
  assert.deepEqual(blocks.map(b => b.type), ['paragraph', 'table', 'code', 'code']);
  assert.equal(blocks[2].language, 'flow');
  assert.equal(blocks[3].language, 'js');
});

test('HTML or graph directives never become rendered markup by the flow parser', () => {
  assert.equal(parseFlowDiagram('Inspect -> <img src=x onerror=alert(1)>'), null);
  assert.equal(parseFlowDiagram('flowchart TD\nA --> B'), null);
});
