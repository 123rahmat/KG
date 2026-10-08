import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readDocument, readZip } from '../src/documents.js';
import { zipRaw } from './document-fixtures.js';
import { inspectZipManifest } from '../src/zip-intake-policy.js';

const zipped = names => zipRaw(names.map(name => {
  const bytes = Buffer.from(name.endsWith('/') ? '' : 'Archive sample');
  return { name, compressed: zlib.deflateRawSync(bytes), size: bytes.length };
}));

test('archive reader accepts normal ZIP bundles and preserves file content', async () => {
  const archive = zipped(['docs/', 'docs/report.txt', 'docs/notes.md']);
  const result = await readDocument(archive, { name: 'notes.zip' });
  assert.equal(result.archiveKind, 'document-bundle');
  assert.equal(result.items.length, 2);
});

test('rejects traversal in directory names, not only regular files', async () => {
  for (const path of ['../', 'nested/../../', 'nested/../other.txt', 'nested//item.txt', '/absolute.txt']) {
    await assert.rejects(readDocument(zipped([path, 'report.txt']), { name: 'unsafe.zip' }), /ZIP archive rejected/);
  }
});

test('rejects Unicode-normalized and case-folded duplicate paths', async () => {
  const cases = [
    ['Report.txt', 'report.TXT'],
    ['caf\u00e9.txt', 'cafe\u0301.txt']
  ];
  for (const names of cases) {
    await assert.rejects(readDocument(zipped(names), { name: 'duplicates.zip' }), /ZIP archive rejected/);
  }
});

test('rejects symbolic links before an archive is opened as a project', async () => {
  const buffer = zipped(['src/index.js']);
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  buffer.writeUInt32LE(0xa0000000, central + 38);
  const meta = readZip(buffer, { collectManifest: true }).manifest;
  assert.equal(meta[0].type, 'symlink');
  await assert.rejects(readDocument(buffer, { name: 'source.zip' }), /ZIP archive rejected/);
});

test('rejects unusually high declared expansion before reading content', async () => {
  const buffer = zipRaw([{
    name: 'report.txt',
    compressed: zlib.deflateRawSync(Buffer.from('a')),
    size: 40 * 1024 * 1024
  }]);
  await assert.rejects(readDocument(buffer, { name: 'ratio.zip' }), /ZIP archive rejected/);
});

test('manifest analyzer remains advisory, never granting a workspace switch', () => {
  const decision = inspectZipManifest([{
    name: 'src/index.ts', type: 'file', uncompressedSize: 200, compressedSize: 100
  }]);
  assert.equal(decision.accepted, true);
  assert.equal(decision.suggestedWorkspace, 'code');
  assert.equal(decision.requiresUserConfirmation, true);
});
