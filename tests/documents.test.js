import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readDocument, describeTable, parseDelimited, formatOf, readZip, classifyAttachmentSet } from '../src/documents.js';
import { readDocumentIsolated } from '../src/document-runner.js';
import { docx, pptx, xlsx, pdf, png, zipRaw } from './document-fixtures.js';

test('Word, PowerPoint and Excel files become text and tables', async () => {
  const word = await readDocument(docx(['Pump datasheet', 'Flow: 40 L/min & head 12 m']), { name: 'pump.docx' });
  assert.equal(word.format, 'docx');
  assert.equal(word.text, 'Pump datasheet\nFlow: 40 L/min & head 12 m');

  const slides = await readDocument(pptx([['Plan', 'Phase 1'], ['Budget']]), { name: 'deck.pptx' });
  assert.equal(slides.slides, 2);
  assert.match(slides.text, /Slide 1\nPlan\nPhase 1\n\nSlide 2\nBudget/);

  const sheet = await readDocument(xlsx('Loads', [['Room', 'Watts'], ['Kitchen', 3000], ['Bedroom', 800]]), { name: 'loads.xlsx' });
  assert.equal(sheet.kind, 'spreadsheet');
  assert.deepEqual(sheet.tables[0].rows, [['Room', 'Watts'], ['Kitchen', '3000'], ['Bedroom', '800']]);
  assert.match(sheet.text, /Sheet: Loads\nRoom,Watts\nKitchen,3000/);
});

test('PDF text is read page by page, in an isolated thread', async () => {
  const result = await readDocumentIsolated(pdf(['Beam span 5 m', 'Load 2 kN/m']), { name: 'calc.pdf', contentType: 'application/pdf' });
  assert.equal(result.format, 'pdf');
  assert.equal(result.pages, 2);
  assert.match(result.text, /Page 1\nBeam span 5 m/);
  assert.match(result.text, /Page 2\nLoad 2 kN\/m/);
  assert.equal(result.scanned, false);
});

test('broken and hostile files fail clearly instead of hurting the server', async () => {
  await assert.rejects(readDocumentIsolated(Buffer.from('%PDF-1.4 not really'), { name: 'x.pdf' }), error => /could not be/.test(error.message));
  await assert.rejects(readDocument(Buffer.from('not a zip'), { name: 'x.docx' }), error => error.code === 'document-unreadable');
  await assert.rejects(readDocument(Buffer.from('x'), { name: 'old.doc' }), error => error.code === 'document-format-unsupported');
  // A zip bomb: an entry that declares 10 bytes but inflates to 50 MB stops at 10.
  const bomb = zipRaw([{ name: 'word/document.xml', compressed: zlib.deflateRawSync(Buffer.alloc(50 * 1024 * 1024)), size: 10 }]);
  await assert.rejects(readDocumentIsolated(bomb, { name: 'bomb.docx' }), error => error.code === 'document-unreadable');
  assert.throws(() => readZip(bomb).get('word/document.xml')(), /expands to more than it declares/);
  // One that honestly declares 2 GB is not expanded at all.
  const declared = zipRaw([{ name: 'word/document.xml', compressed: Buffer.alloc(10), size: 2 ** 31 }]);
  assert.equal(readZip(declared).size, 0);
});

test('ZIP archives adapt to their contents instead of always becoming code projects', async () => {
  const makeEntry = (name, value) => ({ name, compressed: zlib.deflateRawSync(Buffer.from(value)), size: Buffer.byteLength(value) });
  const code = await readDocument(zipRaw([
    makeEntry('src/index.js', 'export const ok = true;'),
    makeEntry('package.json', '{"name":"demo"}')
  ]), { name: 'code.zip', contentType: 'application/zip' });
  assert.equal(code.format, 'project');
  assert.equal(code.archiveKind, 'code-project');
  assert.deepEqual(code.files.map(file => file.path), ['package.json', 'src/index.js']);

  const documents = await readDocument(zipRaw([
    makeEntry('report.txt', 'Quarterly report'),
    makeEntry('notes.md', '# Notes')
  ]), { name: 'documents.zip', contentType: 'application/zip' });
  assert.equal(documents.format, 'bundle');
  assert.equal(documents.archiveKind, 'document-bundle');
  assert.equal(documents.items.length, 2);
  assert.equal(documents.items[0].text, 'Quarterly report');

  const research = await readDocument(zipRaw([
    makeEntry('paper-results.txt', 'Study results'),
    makeEntry('references.txt', 'References')
  ]), { name: 'research.zip', contentType: 'application/zip' });
  assert.equal(research.format, 'bundle');
  assert.equal(research.archiveKind, 'research-bundle');
  assert.equal(research.items.length, 2);
});

test('ZIP profiling distinguishes real projects, research bundles, mixed archives and neutral archives', async () => {
  const makeEntry = (name, value) => ({ name, compressed: zlib.deflateRawSync(Buffer.from(value)), size: Buffer.byteLength(value) });
  const neutral = await readDocument(zipRaw([
    makeEntry('meeting.md', '# Meeting notes'),
    makeEntry('budget.xlsx', 'not-real-xlsx')
  ]), { name: 'neutral.zip', contentType: 'application/zip' }).catch(error => ({ error }));
  // The invalid spreadsheet is skipped, but the archive must not become a code project.
  assert.equal(neutral.error ?? neutral.archiveKind, neutral.error ? 'document-format-unsupported' : 'document-bundle');

  const mixed = await readDocument(zipRaw([
    makeEntry('src/app.py', 'def run():\n    return 1'),
    makeEntry('paper.pdf.txt', 'Abstract: study results. References and DOI included.')
  ]), { name: 'mixed.zip', contentType: 'application/zip' });
  assert.equal(mixed.archiveKind, 'mixed-bundle');
});

test('multiple attachment metadata is classified conservatively', () => {
  assert.equal(classifyAttachmentSet([{ name: 'a.py', format: 'text' }, { name: 'b.py', format: 'text' }]).kind, 'code');
  assert.equal(classifyAttachmentSet([{ name: 'paper-one.pdf', format: 'pdf' }, { name: 'paper-two.pdf', format: 'pdf' }]).kind, 'research');
  assert.equal(classifyAttachmentSet([{ name: 'report.pdf', format: 'pdf' }, { name: 'notes.docx', format: 'docx' }]).kind, 'neither');
  assert.equal(classifyAttachmentSet([{ name: 'project.zip', format: 'bundle', archiveKind: 'mixed-bundle' }]).kind, 'neither');
  assert.equal(classifyAttachmentSet([{ name: 'project.zip', format: 'project', archiveKind: 'code-project' }]).kind, 'code');
  assert.equal(classifyAttachmentSet([{ name: 'papers.zip', format: 'bundle', archiveKind: 'research-bundle' }]).kind, 'research');
});

test('workspace snapshots preserve explicit source completeness metadata', async () => {
  const snapshot = Buffer.from(JSON.stringify({
    version: 1,
    ingestion: { partial: true, skippedCount: 3, skippedBytes: 1234, skippedExamples: [{ path: 'dist/generated.js', reason: 'file-count-limit', bytes: 100 }] },
    files: [{ path: 'src/app.js', content: 'export const ok = true;' }]
  }));
  const result = await readDocument(snapshot, { name: 'project.workspace', contentType: 'application/vnd.kindgleam.workspace+json' });
  assert.equal(result.format, 'project');
  assert.equal(result.ingestion.partial, true);
  assert.equal(result.ingestion.skippedCount, 3);
  assert.equal(result.ingestion.skippedExamples[0].reason, 'file-count-limit');
  assert.deepEqual(result.files, [{ path: 'src/app.js', content: 'export const ok = true;' }]);
});

test('images are passed on for the model to look at; formats are recognised from type or name', async () => {
  const image = await readDocument(png, { name: 'wiring.png', contentType: 'image/png' });
  assert.equal(image.kind, 'image');
  assert.equal(image.image.mediaType, 'image/png');
  assert.equal(Buffer.from(image.image.data, 'base64').length, png.length);
  assert.equal(formatOf({ name: 'Report.PDF' }), 'pdf');
  assert.equal(formatOf({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'xlsx');
  assert.equal(formatOf({ name: 'main.ino' }), 'text');
});

test('tables are described column by column', () => {
  const rows = parseDelimited('Room,Watts,On\nKitchen,"3,000",yes\nBedroom,800,no\nHall,200,yes\n');
  assert.deepEqual(rows[1], ['Kitchen', '3,000', 'yes']);
  const described = describeTable(rows);
  assert.equal(described.rows, 3);
  const watts = described.columns.find(column => column.name === 'Watts');
  assert.deepEqual([watts.type, watts.min, watts.max, watts.sum, watts.median], ['number', 200, 3000, 4000, 800]);
  const on = described.columns.find(column => column.name === 'On');
  assert.equal(on.type, 'text');
  assert.deepEqual(on.top[0], { value: 'yes', count: 2 });
  assert.deepEqual(parseDelimited('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});
