import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalQuery, rankLexical } from '../src/rag.js';
test('retrieval query is bounded', () => {
  const q = buildRetrievalQuery('Fix authentication timeout in login service', { projectPaths: ['src/auth.js'] });
  assert.ok(q.terms.includes('authentication')); assert.equal(q.projectPaths[0], 'src/auth.js');
});
test('lexical ranking favors matching task terms', () => {
  const r = rankLexical('authentication timeout', [{ id: '1', content: 'database migration' }, { id: '2', content: 'authentication timeout retry' }]);
  assert.equal(r[0].id, '2');
});