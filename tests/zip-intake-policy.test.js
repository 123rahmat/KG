import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectZipManifest } from '../src/zip-intake-policy.js';
const entry = (name, uncompressedSize = 200, compressedSize = 100) =>
  ({ name, type: 'file', uncompressedSize, compressedSize });

test('suggests Code for source bundles without automatically switching', () => {
  const result = inspectZipManifest([entry('src/app.ts'), entry('package.json')]);
  assert.equal(result.accepted, true);
  assert.equal(result.kind, 'code');
  assert.equal(result.suggestedWorkspace, 'code');
  assert.equal(result.requiresUserConfirmation, true);
});
test('suggests Research for bibliography bundles', () => {
  const result = inspectZipManifest([entry('sources/paper.pdf'), entry('references.bib')]);
  assert.equal(result.kind, 'research');
});
test('supports everyday document bundles without forcing a project workspace', () => {
  const result = inspectZipManifest([entry('reports/summary.pdf'), entry('notes.txt')]);
  assert.equal(result.kind, 'documents');
  assert.equal(result.suggestedWorkspace, null);
});
test('recognizes mixed bundles', () => {
  assert.equal(inspectZipManifest([entry('src/main.py'), entry('papers/refs.bib')]).kind, 'mixed');
});
test('rejects traversal and special files', () => {
  assert.equal(inspectZipManifest([entry('../secret.txt')]).accepted, false);
  assert.equal(inspectZipManifest([{ ...entry('link'), type: 'symlink' }]).accepted, false);
});
test('rejects decompression bombs and duplicate names', () => {
  assert.equal(inspectZipManifest([entry('bomb.txt', 5000000, 1)]).accepted, false);
  assert.equal(inspectZipManifest([entry('a.txt'), entry('a.txt')]).accepted, false);
});
test('enforces expanded size and entry counts', () => {
  assert.equal(inspectZipManifest([entry('a.txt', 200, 100)], { maxEntries: 0 }).accepted, false);
  assert.equal(inspectZipManifest([entry('a.txt', 200, 100)], {
    maxEntries: 2, maxExpandedBytes: 150, maxEntryBytes: 300, maxCompressionRatio: 100
  }).accepted, false);
});
