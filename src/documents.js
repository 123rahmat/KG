/**
 * Reading documents people attach: PDF, Word, Excel, PowerPoint, CSV and
 * plain text become text (and tables) the AI can use; images are passed to
 * the model to look at; a ZIP is classified from its contents as a code
 * project or a general document/data bundle.
 *
 * These files come from users, so they are untrusted: this module runs in a
 * worker thread with time and memory limits (see document-runner.js), and
 * every archive is read with size limits so a zip bomb cannot expand.
 */

import zlib from 'node:zlib';
import { inspectZipManifest, ZIP_LIMITS } from './zip-intake-policy.js';

export const MAX_TEXT_CHARS = 400_000;
// PDFs are attacker-controlled input. Bound page fan-out and decoded image size
// before unpdf extracts every page, while document-runner.js adds a worker timeout.
export const MAX_PDF_PAGES = 250;
export const MAX_PDF_IMAGE_PIXELS = 16_777_216;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const MAX_ROWS = 5_000;
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class DocumentError extends Error {
  constructor(message, code = 'document-unreadable') {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ zip */

/** The entries of a ZIP archive: name → () => Buffer, with size limits. */
export function readZip(buffer, { collectManifest = false } = {}) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buffer.length) throw new DocumentError('This file is not a valid Office document or zip archive (no ZIP directory).');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_ZIP_ENTRIES) throw new DocumentError('This document has too many parts to read safely.');
  const entries = new Map();
  const manifest = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset < 0 || offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new DocumentError('This document is damaged (bad ZIP entry).');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) throw new DocumentError('This document has a truncated ZIP directory.');
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset = end;
    if (collectManifest) {
      const fileType = (externalAttributes >>> 16) & 0xf000;
      const type = fileType === 0xa000 ? 'symlink'
        : name.endsWith('/') || fileType === 0x4000 ? 'directory'
          : fileType && fileType !== 0x8000 ? 'special' : 'file';
      if (flags & 1) throw new DocumentError('Encrypted ZIP entries are not supported.');
      if (method !== 0 && method !== 8) throw new DocumentError('This ZIP uses unsupported compression.');
      manifest.push({ name, type, compressedSize: compressed, uncompressedSize: size });
    }
    if (size > MAX_ENTRY_BYTES) continue;
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new DocumentError('This document expands to more than can be read safely.');
    entries.set(name, () => {
      if (buffer.readUInt32LE(local) !== 0x04034b50) throw new DocumentError('This document is damaged (bad ZIP header).');
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
        } catch {
          // Inflating past the declared size is how a zip bomb behaves.
          throw new DocumentError('This document is damaged or expands to more than it declares.');
        }
      }
      throw new DocumentError(`This document uses a ZIP compression that is not supported (${method}).`);
    });
  }
  if (collectManifest) entries.manifest = manifest;
  return entries;
}

/* ------------------------------------------------------------------ xml */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeXml = value => String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) => {
  if (code[0] === '#') {
    const point = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }
  return ENTITIES[code.toLowerCase()] ?? '';
});
const textOf = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map(match => decodeXml(match[1])).join('');
const attr = (xml, name) => decodeXml(xml.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '');

/* ------------------------------------------------------------------ formats */

function readDocx(buffer) {
  const zip = readZip(buffer);
  const body = zip.get('word/document.xml');
  if (!body) throw new DocumentError('This Word file has no document body.');
  const xml = body().toString('utf8');
  const paragraphs = xml.split(/<\/w:p>/).map(part => {
    const withBreaks = part.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t>\n</w:t>');
    return textOf(withBreaks, 'w:t');
  });
  return { kind: 'document', format: 'docx', text: paragraphs.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

function readPptx(buffer) {
  const zip = readZip(buffer);
  const slides = [...zip.keys()]
    .map(name => ({ name, number: Number(name.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]) }))
    .filter(item => item.number)
    .sort((a, b) => a.number - b.number);
  const text = slides.map(({ name, number }) => {
    const xml = zip.get(name)().toString('utf8');
    const lines = xml.split(/<\/a:p>/).map(part => textOf(part, 'a:t')).filter(Boolean);
    return `Slide ${number}\n${lines.join('\n')}`;
  }).join('\n\n');
  return { kind: 'document', format: 'pptx', slides: slides.length, text };
}

/** Column letters (A, AB) to a zero-based index. */
const columnIndex = ref => [...ref.replace(/\d+/g, '')].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;

function readXlsx(buffer) {
  const zip = readZip(buffer);
  const shared = zip.get('xl/sharedStrings.xml')
    ? [...zip.get('xl/sharedStrings.xml')().toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => textOf(match[1], 't'))
    : [];
  const workbook = zip.get('xl/workbook.xml')?.().toString('utf8') ?? '';
  const rels = zip.get('xl/_rels/workbook.xml.rels')?.().toString('utf8') ?? '';
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(match => [attr(match[0], 'Id'), attr(match[0], 'Target')]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(match => {
    const target = targets.get(attr(match[0], 'r:id')) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    return { name: attr(match[0], 'name'), path };
  });
  const tables = sheets.map(sheet => {
    const xml = zip.get(sheet.path)?.().toString('utf8') ?? '';
    const rows = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS) break;
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(cell[1], 't');
        const index = columnIndex(attr(cell[1], 'r') || 'A1');
        const raw = cell[2] ?? '';
        const value = type === 's' ? shared[Number(textOf(raw, 'v'))] ?? ''
          : type === 'inlineStr' ? textOf(raw, 't')
            : type === 'b' ? (textOf(raw, 'v') === '1' ? 'TRUE' : 'FALSE')
              : textOf(raw, 'v');
        if (index >= 0 && index < 500) cells[index] = value;
      }
      rows.push(Array.from(cells, value => value ?? ''));
    }
    return { name: sheet.name, rows };
  });
  const text = tables.map(table => `Sheet: ${table.name}\n${table.rows.map(row => row.map(csvCell).join(',')).join('\n')}`).join('\n\n');
  return { kind: 'spreadsheet', format: 'xlsx', tables, text };
}

const csvCell = value => (/[",\n]/.test(value) ? `"${String(value).replace(/"/g, '""')}"` : String(value));

/** CSV or TSV, with quoted fields. */
export function parseDelimited(textValue, delimiter = null) {
  const sample = textValue.slice(0, 2000);
  const separator = delimiter ?? ((sample.match(/\t/g) ?? []).length > (sample.match(/,/g) ?? []).length ? '\t' : (sample.match(/;/g) ?? []).length > (sample.match(/,/g) ?? []).length ? ';' : ',');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < textValue.length && rows.length < MAX_ROWS; i += 1) {
    const char = textValue[i];
    if (quoted) {
      if (char === '"' && textValue[i + 1] === '"') { field += '"'; i += 1; } else if (char === '"') quoted = false; else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === separator) { row.push(field); field = ''; } else if (char === '\n' || char === '\r') {
      if (char === '\r' && textValue[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(item => item.some(cell => cell !== ''));
}

async function readPdf(buffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer), {
      isEvalSupported: false,
      disableFontFace: true,
      stopAtErrors: true,
      maxImageSize: MAX_PDF_IMAGE_PIXELS
    });
  } catch (error) {
    throw new DocumentError(/password/i.test(error?.message ?? '') ? 'This PDF is password-protected.' : 'This PDF could not be opened.', /password/i.test(error?.message ?? '') ? 'document-encrypted' : 'document-unreadable');
  }
  if (pdf.numPages > MAX_PDF_PAGES) {
    throw new DocumentError(`This PDF has ${pdf.numPages} pages; at most ${MAX_PDF_PAGES} can be read safely.`);
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((page, index) => `Page ${index + 1}\n${page.trim()}`);
  const joined = pages.join('\n\n');
  return {
    kind: 'document', format: 'pdf', pages: totalPages, text: joined,
    // A scan has pages but no text layer; the person should know why nothing was read.
    scanned: totalPages > 0 && text.join('').replace(/\s/g, '').length < 3 * totalPages
  };
}

/* ------------------------------------------------------------------ entry */

const EXTENSION = name => String(name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';

/** Which reader a file needs, from its type and name. */
export function formatOf({ name, contentType }) {
  const type = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  const ext = EXTENSION(name);
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.includes('wordprocessingml') || ext === 'docx') return 'docx';
  if (type.includes('spreadsheetml') || ext === 'xlsx') return 'xlsx';
  if (type.includes('presentationml') || ext === 'pptx') return 'pptx';
  if (IMAGE_TYPES.has(type) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  if (['text/csv', 'text/tab-separated-values'].includes(type) || ['csv', 'tsv'].includes(ext)) return 'csv';
  if (type === 'application/vnd.kindgleam.workspace+json') return 'workspace-project';
  if (type.startsWith('text/') || /json|xml|yaml|javascript|x-sh|sql/.test(type)
      || ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'pyi', 'toml', 'cfg', 'ini', 'c', 'h', 'cc', 'cxx', 'cpp', 'hh', 'hpp', 'ino',
        'java', 'kt', 'kts', 'gradle', 'go', 'mod', 'sum', 'rs', 'lock', 'sql', 'html', 'css', 'sh', 'log'].includes(ext)) return 'text';
  if (['doc', 'xls', 'ppt'].includes(ext)) return 'legacy-office';
  if (['application/zip', 'application/x-zip-compressed'].includes(type) || ext === 'zip') return 'project';
  return 'unknown';
}

/* ------------------------------------------------------------------ projects */

// Source and config files a project is made of; the rest (binaries, media) is left out.
const SOURCE_EXT = new Set(['py', 'pyi', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'toml', 'cfg', 'ini', 'yaml', 'yml', 'md', 'txt', 'rst',
  'html', 'css', 'scss', 'sql', 'sh', 'c', 'h', 'cc', 'cxx', 'cpp', 'hh', 'hpp', 'ino', 'java', 'kt', 'kts', 'gradle', 'go', 'mod', 'sum', 'rs', 'lock',
  'rb', 'php', 'cs', 'swift', 'proto', 'cmake', 'csv', 'xml', 'env.example']);
// Build and module files a project needs to run as it is (go.mod names the module every import uses).
const SOURCE_NAMES = new Set(['Makefile', 'Dockerfile', 'requirements.txt', 'package.json', 'pyproject.toml', 'setup.cfg', 'README', 'LICENSE',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'CMakeLists.txt', 'build.gradle', 'settings.gradle', 'pom.xml']);
// Folders that are installed, generated or version control, never source.
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.hg|__pycache__|\.venv|venv|env|dist|build|\.next|\.cache|\.pytest_cache|\.mypy_cache|coverage|target)\//;
const MAX_PROJECT_FILES = 250;
const MAX_PROJECT_FILE_BYTES = 256 * 1024;
const MAX_PROJECT_BYTES = 4 * 1024 * 1024;

const MAX_ARCHIVE_ITEMS = 80;
const MAX_ARCHIVE_ITEM_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_CONTENT_BYTES = 12 * 1024 * 1024;
const MAX_ARCHIVE_IMAGES = 4;
const MAX_ARCHIVE_PROFILE_SAMPLE_BYTES = 8 * 1024;
const ARCHIVE_RESEARCH_HINT = /\b(?:paper|study|studies|article|literature|citation|citations|reference|references|bibliograph(?:y|ies)|thesis|journal|publication|preprint|survey|systematic|review|doi|arxiv)\b/i;
const ARCHIVE_CODE_CONTENT_HINT = /(?:^|\n)\s*(?:import\s+|from\s+\S+\s+import\s+|export\s+(?:default\s+)?(?:class|function|const|let|var)|(?:async\s+)?function\s+\w+\s*\(|class\s+\w+[\s:{]|def\s+\w+\s*\(|fn\s+\w+\s*\(|package\s+main\b|#include\s*[<"]|using\s+System\s*;|SELECT\s+.+\s+FROM\s+|require\s*\(|if\s+__name__\s*==)/im;
const ARCHIVE_RESEARCH_CONTENT_HINT = /(?:\babstract\b[\s:,-]|\bintroduction\b[\s:,-]|\bmethod(?:s|ology)?\b[\s:,-]|\bresults?\b[\s:,-]|\bdiscussion\b[\s:,-]|\bconclusion\b[\s:,-]|\bdoi\b|\barxiv\b|\bet\s+al\.\b|\bbibliograph(?:y|ies)\b)/i;

const CODE_ARCHIVE_EXT = new Set([
  'py','pyi','js','mjs','cjs','jsx','ts','tsx','go','mod','rs','java','kt','kts',
  'c','cc','cxx','cpp','h','hh','hpp','cs','rb','php','swift','sql','sh','html',
  'css','scss','proto','cmake','gradle'
]);
const CODE_PROJECT_MARKERS = new Set([
  ...SOURCE_NAMES,
  'package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock',
  'composer.json','Gemfile','mix.exs','mix.lock','build.gradle.kts',
  'gradlew','gradlew.bat','requirements.in','Pipfile','Pipfile.lock'
]);
const RESEARCH_DOCUMENT_FORMATS = new Set(['pdf', 'docx', 'pptx']);
const DOCUMENT_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'text']);

function archiveEntries(buffer) {
  const zip = readZip(buffer, { collectManifest: true });
  const assessment = inspectZipManifest(zip.manifest, {
    ...ZIP_LIMITS,
    maxExpandedBytes: Math.min(ZIP_LIMITS.maxExpandedBytes, MAX_TOTAL_BYTES),
    maxEntryBytes: Math.min(ZIP_LIMITS.maxEntryBytes, MAX_ENTRY_BYTES)
  });
  if (!assessment.accepted) {
    throw new DocumentError('ZIP archive rejected: ' + assessment.reason, 'document-unreadable');
  }
  const entries = new Map([...zip]);
  const names = [...entries.keys()]
    .filter(name => !name.endsWith('/')
      && !SKIP_DIRS.test('/' + name)
      && !name.split('/').some(part => part.startsWith('.') && part !== '.env.example'))
    .sort();
  return { entries, names };
}

function archiveFormat(name) {
  return formatOf({ name, contentType: '' });
}

function pathExtension(name) {
  const base = String(name ?? '').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function archiveTextSignals(bytes) {
  if (!bytes?.length) return { code: 0, research: 0 };
  const sample = bytes.subarray(0, MAX_ARCHIVE_PROFILE_SAMPLE_BYTES).toString('utf8').replace(/\0/g, '');
  const code = ARCHIVE_CODE_CONTENT_HINT.test(sample) ? 2 : 0;
  const research = ARCHIVE_RESEARCH_CONTENT_HINT.test(sample) ? 2 : 0;
  return { code, research };
}

function archiveProfile(names, entries = null) {
  let codeFiles = 0;
  let codeMarkers = 0;
  let documents = 0;
  let researchDocuments = 0;
  let images = 0;
  let data = 0;
  let researchHints = 0;
  let codeContentSignals = 0;
  let researchContentSignals = 0;
  for (const name of names) {
    const format = archiveFormat(name);
    const base = String(name).split('/').pop() ?? '';
    const codePath = CODE_ARCHIVE_EXT.has(pathExtension(name));
    if (codePath) codeFiles += 1;
    if (CODE_PROJECT_MARKERS.has(base)) codeMarkers += 1;
    if (DOCUMENT_FORMATS.has(format)) documents += 1;
    if (RESEARCH_DOCUMENT_FORMATS.has(format)) researchDocuments += 1;
    else if (format === 'text' && ARCHIVE_RESEARCH_HINT.test(name)) researchDocuments += 1;
    else if (format === 'csv') data += 1;
    else if (format === 'image') images += 1;
    if (ARCHIVE_RESEARCH_HINT.test(name)) researchHints += 1;

    if (entries?.has(name) && (codePath || DOCUMENT_FORMATS.has(format) || format === 'text')) {
      try {
        const signals = archiveTextSignals(entries.get(name)());
        codeContentSignals += signals.code;
        researchContentSignals += signals.research;
      } catch {
        // Classification remains deterministic from names/types when sampling fails.
      }
    }
  }

  const projectShape = codeFiles >= 2 || (codeFiles >= 1 && codeMarkers >= 1);
  const codeScore = codeFiles * 3 + codeMarkers * 2 + codeContentSignals;
  const researchScore = researchDocuments * 2 + researchHints * 2 + researchContentSignals;
  const strongCode = projectShape && codeScore >= 6 && codeScore > researchScore + 1;
  const strongResearch = researchDocuments > 0 && researchScore >= 6 && researchScore > codeScore + 1;

  if (strongCode) {
    return {
      archiveKind: 'code-project',
      confidence: Math.min(1, 0.55 + Math.min(0.4, (codeScore - researchScore) / 12)),
      code: codeFiles,
      codeFiles,
      codeMarkers,
      codeScore,
      codeContentSignals,
      documents,
      researchDocuments,
      images,
      data,
      researchHints,
      researchScore,
      researchContentSignals
    };
  }
  if (strongResearch) {
    return {
      archiveKind: 'research-bundle',
      confidence: Math.min(1, 0.55 + Math.min(0.4, (researchScore - codeScore) / 12)),
      code: codeFiles,
      codeFiles,
      codeMarkers,
      codeScore,
      codeContentSignals,
      documents,
      researchDocuments,
      images,
      data,
      researchHints,
      researchScore,
      researchContentSignals
    };
  }
  if (documents > 0 || images > 0 || data > 0) {
    return {
      archiveKind: codeFiles > 0 || codeMarkers > 0 || researchDocuments > 0 ? 'mixed-bundle' : 'document-bundle',
      confidence: 0.5,
      code: codeFiles,
      codeFiles,
      codeMarkers,
      codeScore,
      codeContentSignals,
      documents,
      researchDocuments,
      images,
      data,
      researchHints,
      researchScore,
      researchContentSignals
    };
  }
  return {
    archiveKind: 'unknown-bundle',
    confidence: 0.45,
    code: codeFiles,
    codeFiles,
    codeMarkers,
    codeScore,
    codeContentSignals,
    documents,
    researchDocuments,
    images,
    data,
    researchHints,
    researchScore,
    researchContentSignals
  };
}

/** Aggregate attachment metadata into a conservative work-context profile. */
export function classifyAttachmentSet(attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  let codeSignals = 0;
  let researchSignals = 0;
  let neutralSignals = 0;
  const codeFiles = [];
  const researchFiles = [];
  for (const item of list) {
    const name = String(item?.name ?? '');
    const archiveKind = String(item?.archiveKind ?? '');
    const format = String(item?.format ?? '').toLowerCase();
    const ext = pathExtension(name);
    if (archiveKind === 'code-project') {
      codeSignals += 8;
      codeFiles.push(name);
      continue;
    }
    if (archiveKind === 'research-bundle') {
      researchSignals += 8;
      researchFiles.push(name);
      continue;
    }
    if (['project', 'workspace-project'].includes(format)) {
      codeSignals += 8;
      codeFiles.push(name);
      continue;
    }
    if (CODE_ARCHIVE_EXT.has(ext)) {
      codeSignals += 3;
      codeFiles.push(name);
    } else if (RESEARCH_DOCUMENT_FORMATS.has(format) && ARCHIVE_RESEARCH_HINT.test(name)) {
      researchSignals += 4;
      researchFiles.push(name);
    } else if (RESEARCH_DOCUMENT_FORMATS.has(format) || format === 'bundle') {
      neutralSignals += 1;
    } else {
      neutralSignals += 1;
    }
  }
  const code = codeSignals >= 6 && codeSignals >= researchSignals + 3;
  const research = researchSignals >= 6 && researchSignals >= codeSignals + 3;
  const kind = code ? 'code' : research ? 'research' : 'neither';
  const confidence = kind === 'code'
    ? Math.min(1, 0.62 + Math.min(0.3, (codeSignals - researchSignals) / 20))
    : kind === 'research'
      ? Math.min(1, 0.62 + Math.min(0.3, (researchSignals - codeSignals) / 20))
      : Math.max(0.4, 0.7 - Math.min(0.25, Math.abs(codeSignals - researchSignals) / 20));
  return {
    kind,
    confidence,
    codeSignals,
    researchSignals,
    neutralSignals,
    fileCount: list.length,
    codeFiles: codeFiles.slice(0, 20),
    researchFiles: researchFiles.slice(0, 20)
  };
}

/**
 * A zipped code project: its source files as { path, content }, with the
 * one top folder most archives have taken off, and a text view (the file
 * tree, then the files) for the model.
 */
export function readWorkspaceSnapshot(buffer) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(buffer).toString('utf8')); }
  catch { throw new DocumentError('This workspace snapshot is invalid.', 'document-format-unsupported'); }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw new DocumentError('This workspace snapshot has an invalid format.', 'document-format-unsupported');
  }
  const files = [];
  const skipped = [];
  let total = 0;
  for (const item of parsed.files.slice(0, MAX_PROJECT_FILES)) {
    const path = String(item?.path ?? '').replaceAll('\\', '/');
    if (!path || path.includes('..') || path.startsWith('/') || path.startsWith('.')) { skipped.push(path); continue; }
    const content = String(item?.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_PROJECT_FILE_BYTES || total + bytes > MAX_PROJECT_BYTES || content.includes('\\0')) { skipped.push(path); continue; }
    total += bytes;
    files.push({ path, content });
  }
  if (!files.length) throw new DocumentError('This workspace snapshot contains no readable source files.', 'document-format-unsupported');
  const tree = files.map(file => `${file.path} (${file.content.length} chars)`).join('\\n');
  const text = [
    `Code workspace: ${files.length} files.`,
    'Files:', tree, '',
    ...files.map(file => `=== ${file.path} ===\\n${file.content}`)
  ].join('\\n');
  return {
    kind: 'project',
    format: 'project',
    files,
    skipped: skipped.slice(0, 50),
    ingestion: parsed.ingestion && typeof parsed.ingestion === 'object' ? {
      partial: parsed.ingestion.partial === true,
      skippedCount: Number(parsed.ingestion.skippedCount) || 0,
      skippedBytes: Number(parsed.ingestion.skippedBytes) || 0,
      skippedExamples: Array.isArray(parsed.ingestion.skippedExamples) ? parsed.ingestion.skippedExamples.slice(0, 40) : []
    } : null,
    text
  };
}

export function readProject(buffer) {
  const zip = readZip(buffer);
  // Archives made on Windows may separate folders with backslashes.
  const entries = new Map([...zip].map(([name, read]) => [name.replaceAll('\\', '/'), read]));
  const names = [...entries.keys()].filter(name => !name.endsWith('/') && !SKIP_DIRS.test(`/${name}`) && !name.split('/').some(part => part.startsWith('.') && part !== '.env.example'));
  // The one folder most archives wrap everything in is taken off, unless it
  // is itself a Python package: its name is part of every import.
  const shared = names.length && names.every(name => name.includes('/') && name.split('/')[0] === names[0].split('/')[0]) ? `${names[0].split('/')[0]}/` : '';
  const top = shared && !names.includes(`${shared}__init__.py`) ? shared : '';
  const files = [];
  const skipped = [];
  let total = 0;
  for (const name of names.sort()) {
    const base = name.split('/').pop();
    const ext = base.includes('.') ? base.split('.').slice(1).join('.').toLowerCase() : '';
    if (!SOURCE_EXT.has(ext) && !SOURCE_EXT.has(ext.split('.').pop()) && !SOURCE_NAMES.has(base)) { skipped.push(name.slice(top.length)); continue; }
    const bytes = entries.get(name)();
    if (bytes.length > MAX_PROJECT_FILE_BYTES || total + bytes.length > MAX_PROJECT_BYTES || files.length >= MAX_PROJECT_FILES || bytes.includes(0)) { skipped.push(name.slice(top.length)); continue; }
    total += bytes.length;
    files.push({ path: name.slice(top.length), content: bytes.toString('utf8').replace(/^\uFEFF/, '') });
  }
  if (!files.length) throw new DocumentError('This zip has no source files to read.', 'document-format-unsupported');
  const tree = files.map(file => `${file.path} (${file.content.length} chars)`).join('\n');
  const text = [
    `Code project: ${files.length} source files${skipped.length ? `; ${skipped.length} other files left out (binary, generated or too large)` : ''}.`,
    'Files:', tree, '',
    ...files.map(file => `=== ${file.path} ===\n${file.content}`)
  ].join('\n');
  return { kind: 'project', format: 'project', files, skipped: skipped.slice(0, 50), text };
}

async function readArchiveBundle(buffer, profile) {
  const { entries, names } = archiveEntries(buffer);
  const items = [];
  const skipped = [];
  let total = 0;
  let images = 0;
  for (const name of names.slice(0, MAX_ARCHIVE_ITEMS)) {
    const format = archiveFormat(name);
    if (!['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'text', 'image'].includes(format)) {
      skipped.push(name);
      continue;
    }
    const bytes = entries.get(name)();
    if (bytes.length > MAX_ARCHIVE_ITEM_BYTES || total + bytes.length > MAX_ARCHIVE_CONTENT_BYTES) {
      skipped.push(name);
      continue;
    }
    if (format === 'image' && images >= MAX_ARCHIVE_IMAGES) {
      skipped.push(name);
      continue;
    }
    try {
      const result = await readDocument(bytes, { name });
      items.push({
        path: name,
        name: name.split('/').pop(),
        kind: result.kind,
        format: result.format,
        ...(result.text ? { text: result.text } : {}),
        ...(result.pages ? { pages: result.pages } : {}),
        ...(result.tables ? { tables: result.tables } : {}),
        ...(result.image ? { image: result.image } : {})
      });
      total += bytes.length;
      if (format === 'image') images += 1;
    } catch {
      skipped.push(name);
    }
  }
  if (names.length > MAX_ARCHIVE_ITEMS) skipped.push(...names.slice(MAX_ARCHIVE_ITEMS));
  if (!items.length) throw new DocumentError('This zip has no readable document, data or image files.', 'document-format-unsupported');
  const summary = [
    `Archive: ${profile.archiveKind}; ${items.length} readable items.`,
    'Contents:',
    ...items.map(item => `${item.path} [${item.format}]${item.text ? ` — ${item.text.slice(0, 240)}` : ''}`)
  ].join('\n');
  return {
    kind: 'bundle',
    format: 'bundle',
    archiveKind: profile.archiveKind,
    profile,
    items,
    skipped: skipped.slice(0, 80),
    text: summary
  };
}

export function inspectArchive(buffer) {
  const { entries, names } = archiveEntries(buffer);
  return {
    itemCount: names.length,
    ...archiveProfile(names, entries)
  };
}

export async function readArchive(buffer) {
  const { names, entries } = archiveEntries(buffer);
  const profile = archiveProfile(names, entries);
  if (profile.archiveKind === 'code-project') return { ...readProject(buffer), archiveKind: 'code-project', profile };
  return readArchiveBundle(buffer, profile);
}

const IMAGE_MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** Read one file. Returns { kind, format, text?, tables?, image?, truncated }. */
export async function readDocument(buffer, meta = {}) {
  const format = formatOf(meta);
  let result;
  if (format === 'pdf') result = await readPdf(buffer);
  else if (format === 'docx') result = readDocx(buffer);
  else if (format === 'xlsx') result = readXlsx(buffer);
  else if (format === 'pptx') result = readPptx(buffer);
  else if (format === 'project') result = await readArchive(buffer);
  else if (format === 'workspace-project') result = readWorkspaceSnapshot(buffer);
  else if (format === 'csv') {
    const textValue = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const rows = parseDelimited(textValue);
    result = { kind: 'spreadsheet', format: 'csv', tables: [{ name: String(meta.name ?? 'table'), rows }], text: textValue };
  } else if (format === 'text') result = { kind: 'text', format: 'text', text: buffer.toString('utf8').replace(/^\uFEFF/, '') };
  else if (format === 'image') {
    const mediaType = IMAGE_TYPES.has(String(meta.contentType).split(';')[0]) ? String(meta.contentType).split(';')[0] : IMAGE_MEDIA[EXTENSION(meta.name)];
    result = { kind: 'image', format: 'image', image: { mediaType, data: buffer.toString('base64') }, text: '' };
  } else if (format === 'legacy-office') throw new DocumentError('Old Office formats (.doc, .xls, .ppt) cannot be read. Save it as .docx, .xlsx or .pptx.', 'document-format-unsupported');
  else throw new DocumentError('This kind of file cannot be read as text.', 'document-format-unsupported');
  const truncated = (result.text?.length ?? 0) > MAX_TEXT_CHARS;
  if (truncated) result.text = result.text.slice(0, MAX_TEXT_CHARS);
  return { ...result, truncated };
}

/* ------------------------------------------------------------------ tables */

/** What a table holds: per column, how many values, and for numbers min, max, mean and median. */
export function describeTable(rows, { headerRow = true } = {}) {
  if (!rows?.length) return { columns: [], rows: 0 };
  const header = headerRow ? rows[0].map((name, index) => String(name || `Column ${index + 1}`)) : rows[0].map((_, index) => `Column ${index + 1}`);
  const body = headerRow ? rows.slice(1) : rows;
  const width = Math.max(header.length, ...body.map(row => row.length));
  const columns = [];
  for (let index = 0; index < width && index < 200; index += 1) {
    const values = body.map(row => row[index]).filter(value => value !== undefined && String(value).trim() !== '');
    const numbers = values.map(value => Number(String(value).replace(/,/g, ''))).filter(Number.isFinite);
    const numeric = numbers.length >= Math.max(1, values.length * 0.8);
    const column = { name: header[index] ?? `Column ${index + 1}`, count: values.length, empty: body.length - values.length };
    if (numeric && numbers.length) {
      const sorted = [...numbers].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const round = value => Number(value.toPrecision(6));
      Object.assign(column, {
        type: 'number', min: round(sorted[0]), max: round(sorted.at(-1)),
        mean: round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length),
        median: round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
        sum: round(numbers.reduce((sum, value) => sum + value, 0))
      });
    } else {
      const counts = new Map();
      for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
      Object.assign(column, { type: 'text', distinct: counts.size, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value: value.slice(0, 80), count })) });
    }
    columns.push(column);
  }
  return { rows: body.length, columns, sample: body.slice(0, 5) };
}
