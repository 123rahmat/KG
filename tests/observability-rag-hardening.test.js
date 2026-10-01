import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTraceparent, createTraceContext, traceparentOf } from '../src/observability.js';
import { rankLexical } from '../src/rag.js';

test('trace context rejects malformed and accepts valid W3C traceparent', () => {
  assert.equal(parseTraceparent('bad'), null);
  const incoming = parseTraceparent('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
  assert.equal(incoming.traceId, '0123456789abcdef0123456789abcdef');
  const context = createTraceContext('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
  assert.equal(context.traceId, incoming.traceId);
  assert.match(traceparentOf(context), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test('retrieval favors repeated matches and title matches', () => {
  const rows = [
    { id: 'a', sourceId: 'a', title: 'deployment', content: 'deployment' },
    { id: 'b', sourceId: 'b', title: 'deployment resilience', content: 'deployment deployment resilience deployment' }
  ];
  const ranked = rankLexical('deployment resilience', rows, 2);
  assert.equal(ranked[0].id, 'b');
  assert.equal(ranked[0].matchedTerms, 2);
});
