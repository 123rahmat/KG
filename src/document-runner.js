/**
 * Reads documents people attach in a worker thread: a malformed or hostile
 * PDF or Office file can use up its own time and memory, never the server's.
 * Plain text is cheap and safe to read inline.
 */

import { Worker } from 'node:worker_threads';
import { readDocument, formatOf, DocumentError } from './documents.js';

export const DOCUMENT_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 2;
let running = 0;
const waiting = [];

async function slot() {
  if (running < MAX_CONCURRENT) { running += 1; return; }
  await new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running -= 1;
}

/** Read one file: { kind, format, text?, tables?, image?, truncated, pages? }. */
export async function readDocumentIsolated(buffer, meta = {}, { timeoutMs = DOCUMENT_TIMEOUT_MS } = {}) {
  const format = formatOf(meta);
  if (['text', 'csv', 'image', 'unknown', 'legacy-office'].includes(format)) return readDocument(Buffer.from(buffer), meta);
  await slot();
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./document-thread.js', import.meta.url), {
        workerData: { buffer: new Uint8Array(buffer), meta: { name: meta.name, contentType: meta.contentType } },
        resourceLimits: { maxOldGenerationSizeMb: 384 }
      });
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new DocumentError('Reading this file took too long.', 'document-timeout')), timeoutMs);
      worker.once('message', message => (message.ok ? finish(resolve, message.value) : finish(reject, new DocumentError(message.message, message.code))));
      worker.once('error', error => finish(reject, new DocumentError(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'This file needs more memory to read than is allowed.' : 'This file could not be read.', 'document-unreadable')));
      worker.once('exit', () => finish(reject, new DocumentError('This file could not be read.', 'document-unreadable')));
    });
  } finally {
    release();
  }
}
