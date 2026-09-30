/** Reads one untrusted document off the request thread (see document-runner.js). */

import { parentPort, workerData } from 'node:worker_threads';
import { readDocument } from './documents.js';

try {
  const value = await readDocument(Buffer.from(workerData.buffer), workerData.meta);
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message, code: error.code ?? 'document-unreadable' });
}
