import test from 'node:test';
import assert from 'node:assert/strict';
import { isHtmlSource, staticHtmlDocument, HTML_SOURCE_LIMIT, createStaticHtmlFrame } from '../public/static-html-preview.js';
import { previewKind } from '../public/artifact-preview.js';
import { formatOf } from '../src/documents.js';

test('HTML and XHTML files are recognized without treating arbitrary UI source as runnable HTML', () => {
  assert.equal(isHtmlSource({name:'index.html',contentType:'text/plain'}),true);
  assert.equal(isHtmlSource({name:'page.xhtml'}),true);
  assert.equal(isHtmlSource({name:'unknown',contentType:'text/html; charset=utf-8'}),true);
  assert.equal(isHtmlSource({name:'App.tsx'}),false);
  assert.equal(previewKind({name:'index.html',contentType:'text/html'}),'html');
  assert.equal(previewKind({name:'App.tsx',contentType:'text/plain'}),'text');
  assert.equal(previewKind({name:'App.vue'}),'text');
});
test('HTML preview is a non-executing, no-network isolated document', () => {
  const document = staticHtmlDocument('<script>throw Error("must not run")</script>');
  for (const directive of ["script-src 'none'","style-src 'none'","connect-src 'none'","object-src 'none'","form-action 'none'"]) {
    assert.ok(document.includes(directive),directive);
  }
  assert.ok(document.indexOf('Content-Security-Policy') < document.indexOf('<script>'));
});
test('HTML preview is explicitly bounded to server preview limit', () => {
  const result=staticHtmlDocument('x'.repeat(HTML_SOURCE_LIMIT+300));
  assert.equal(result.includes('x'.repeat(HTML_SOURCE_LIMIT+1)),false);
  assert.ok(result.includes('x'.repeat(HTML_SOURCE_LIMIT)));
});
test('generated frame has no script, origin or form permission', () => {
  const attrs = new Map();
  const frame = {setAttribute:(key,value)=>attrs.set(key,value)};
  const oldDocument=globalThis.document;
  globalThis.document={createElement:tag=>{assert.equal(tag,'iframe');return frame;}};
  try {
    const result=createStaticHtmlFrame('<h1>Preview</h1>');
    assert.equal(result,frame);
    assert.equal(attrs.get('sandbox'),'');
    assert.equal(attrs.get('referrerpolicy'),'no-referrer');
    assert.match(frame.srcdoc,/script-src 'none'/);
  } finally {
    if (oldDocument===undefined) delete globalThis.document; else globalThis.document=oldDocument;
  }
});
test('additional common UI and code formats are readable as text without execution',()=>{
  for(const ext of ['html','htm','css','scss','less','svg','vue','svelte','astro','jsx','tsx','swift','php','rb']) {
    assert.equal(formatOf({name:'component.'+ext,contentType:'application/octet-stream'}),'text',ext);
  }
});
