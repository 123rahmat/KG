import { once } from 'node:events';
import { createServer, request } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { installApiRequestBoundary, installBrowserBoundary, installIngressBoundary } from '../src/security-boundary.js';

async function withBoundaryApp(run) {
  const app = express();
  installIngressBoundary(app);
  installApiRequestBoundary(app, { exemptPaths: ['/api/stripe/webhook'] });
  installBrowserBoundary(app);
  app.post('/api/write', (_req, res) => res.status(204).end());
  app.post('/api/stripe/webhook', (_req, res) => res.status(204).end());
  app.get('/api/read', (_req, res) => res.json({ ok: true }));
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('ingress refuses methods that can reflect credentials', () => withBoundaryApp(async base => {
  const response = await new Promise((resolve, reject) => {
    const req = request(base + '/api/read', { method: 'TRACE' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once('error', reject).end();
  });
  assert.equal(response.status, 405);
  assert.equal(JSON.parse(response.body).code, 'method-not-allowed');
  assert.match(response.headers.allow, /POST/);
}));

test('fetch metadata blocks cross-site writes but not signed webhook ingress', () => withBoundaryApp(async base => {
  const blocked = await fetch(base + '/api/write', {
    method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, 'cross-site-request');

  const webhook = await fetch(base + '/api/stripe/webhook', {
    method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(webhook.status, 204);
}));

test('browser boundary denies unneeded powerful features', () => withBoundaryApp(async base => {
  const response = await fetch(base + '/api/read');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()');
}));
