/**
 * web.fetch and http.check: guarded retrieval of public URLs.
 *
 * Every hop, including each redirect, is re-checked by the network guard,
 * and the connection is pinned to the address that was checked.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { checkUrl, resolvePublic, GuardError } from './net-guard.js';

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml))/i;

/** One guarded request, no redirect handling. Resolves with status, headers and body. */
function requestOnce(url, address, { method, timeoutMs, maxBytes, readBody, signal }) {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      timeout: timeoutMs,
      signal,
      headers: { 'user-agent': 'Kindgleam-Fetcher/1.0 (+reads public pages for its users)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.1' },
      // Pin the connection to the vetted address; SNI and Host keep the name.
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, [{ address: address.address, family: address.family }])
        : callback(null, address.address, address.family)
    }, response => {
      if (!readBody) {
        response.resume();
        return resolve({ status: response.statusCode, headers: response.headers, body: Buffer.alloc(0), truncated: false });
      }
      const chunks = [];
      let size = 0;
      let truncated = false;
      response.on('data', chunk => {
        if (truncated) return;
        size += chunk.length;
        if (size > maxBytes) {
          truncated = true;
          chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('close', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), truncated }));
      response.on('error', error => truncated ? null : reject(error));
    });
    request.on('timeout', () => request.destroy(new GuardError('The request timed out', 'timeout')));
    request.on('error', reject);
    request.end();
  });
}

async function guardedRequest(rawUrl, { method = 'GET', readBody = true, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, resolve, isAllowed, ports, signal } = {}) {
  signal?.throwIfAborted();
  const hops = [];
  let url = checkUrl(rawUrl, { ports });
  const started = Date.now();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    signal?.throwIfAborted();
    const address = await resolvePublic(url.hostname, { resolve, isAllowed });
    signal?.throwIfAborted();
    const response = await requestOnce(url, address, { method, timeoutMs, maxBytes, readBody, signal });
    signal?.throwIfAborted();
    hops.push({ url: url.href, status: response.status, address: address.address });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (hop === MAX_REDIRECTS) throw new GuardError('Too many redirects', 'too-many-redirects');
      url = checkUrl(new URL(response.headers.location, url).href, { ports });
      continue;
    }
    return { url, response, hops, elapsedMs: Date.now() - started };
  }
  throw new GuardError('Too many redirects', 'too-many-redirects');
}

/** Readable text from HTML, without executing or trusting any of it. */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export async function webFetch(input = {}, options = {}) {
  const { url, response, hops, elapsedMs } = await guardedRequest(input.url, options);
  const contentType = String(response.headers['content-type'] ?? '');
  if (!TEXTUAL.test(contentType)) {
    throw new GuardError(`Only textual content can be retrieved (got "${contentType || 'unknown'}")`, 'unsupported-content-type');
  }
  const raw = response.body.toString('utf8');
  const content = /html/i.test(contentType) ? htmlToText(raw) : raw;
  const title = /html/i.test(contentType) ? (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim() : '';
  return {
    output: { title, content, contentType, status: response.status, truncated: response.truncated },
    // Provenance: what was fetched, from where, and a digest of exactly the bytes.
    provenance: {
      requestedUrl: String(input.url),
      finalUrl: url.href,
      hops,
      retrievedAt: new Date().toISOString(),
      sha256: crypto.createHash('sha256').update(response.body).digest('hex'),
      bytes: response.body.length,
      elapsedMs
    }
  };
}

export async function httpCheck(input = {}, options = {}) {
  const { url, response, hops, elapsedMs } = await guardedRequest(input.url, { ...options, method: 'HEAD', readBody: false });
  return {
    output: {
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      contentType: String(response.headers['content-type'] ?? ''),
      elapsedMs
    },
    provenance: { requestedUrl: String(input.url), finalUrl: url.href, hops, checkedAt: new Date().toISOString() }
  };
}

/** Largest file the AI may download from the web. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Download a public file (PDF, spreadsheet, CSV, JSON, image…) through the
 * same guard as web.fetch. The bytes are returned for a reader to parse; the
 * caller never executes them.
 */
export async function webDownload(input = {}, options = {}) {
  const { url, response, hops, elapsedMs } = await guardedRequest(input.url, { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: 30_000, ...options });
  if (response.status >= 400) throw new GuardError(`The server answered ${response.status}`, 'http-error');
  if (response.truncated) throw new GuardError(`The file is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB`, 'too-large');
  return {
    body: response.body,
    contentType: String(response.headers['content-type'] ?? '').split(';')[0].trim(),
    name: decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname),
    provenance: {
      requestedUrl: String(input.url), finalUrl: url.href, hops, retrievedAt: new Date().toISOString(),
      sha256: crypto.createHash('sha256').update(response.body).digest('hex'), bytes: response.body.length, elapsedMs
    }
  };
}
