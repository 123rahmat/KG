import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, quotePresentation } from '../public/markdown.js';

test('explicit reasoning summary renders as an explanation callout', () => {
  const blocks = parseMarkdown('> Reasoning summary: Compare the evidence and explain the result.');
  assert.equal(quotePresentation(blocks[0]), 'reasoning');
});

test('educational examples and cautions use distinct callouts', () => {
  assert.equal(quotePresentation(parseMarkdown('> **Example:** Solve for x.')[0]), 'example');
  assert.equal(quotePresentation(parseMarkdown('> Caution: Check the units.')[0]), 'caution');
});

test('normal quotations are not restyled as invented findings', () => {
  const quote = parseMarkdown('> The original source states this.');
  assert.equal(quotePresentation(quote[0]), null);
});

test('comparison tables retain parsed structure and not executable HTML', () => {
  const table = parseMarkdown('| Choice | Cost |\n| --- | ---: |\n| A | 5 |');
  assert.equal(table[0].type, 'table');
  assert.equal(table[0].rows.length, 1);
  assert.deepEqual(table[0].align, [null, 'right']);
});
