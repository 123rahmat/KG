import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalQuery, rankLexical } from '../src/rag.js';

test('retrieval queries expose bounded normalized terms', () => {
  const query = buildRetrievalQuery('Fix the authentication timeout in login service', {
    projectPaths: ['src/auth.js']
  });
  assert.ok(query.terms.includes('authentication'));
  assert.equal(query.projectPaths[0], 'src/auth.js');
});

test('lexical ranking favors rows that share task terms', () => {
  const result = rankLexical('authentication timeout', [
    { id: '1', content: 'database migration' },
    { id: '2', content: 'authentication timeout retry policy' }
  ]);
  assert.equal(result[0].id, '2');
});
