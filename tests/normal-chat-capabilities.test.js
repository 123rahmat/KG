import test from 'node:test';
import assert from 'node:assert/strict';
import { normalChatCapabilities } from '../public/normal-chat-capabilities.js';
import { classifySurfaceBoundary } from '../src/surface-policy.js';

const inputs = [{name:'a.py'},{name:'b.py'}];

test('Normal Chat keeps several bounded code files without forced workspace switching', () => {
  const d=classifySurfaceBoundary('Fix these Python files and run the tests.',{
    activeSurface:'normal-chat',flags:{code:true},actions:['transform','execute'],attachments:inputs
  });
  assert.equal(d.surface,'normal-chat');
  const ui=normalChatCapabilities({goal:'Fix these Python files and run the tests.',attachments:inputs});
  assert.equal(ui.multiFile,true);
  assert.equal(ui.fileCount,2);
  assert.equal(ui.suggestedWorkspace,'code');
  assert.match(ui.suggestion,/You can also stay here/);
});

test('Normal Chat handles multiple documents and images without unrelated escalation', () => {
  const files=[{name:'report.pdf'},{name:'sales.csv'},{name:'photo.png'}];
  const result=normalChatCapabilities({goal:'Summarize and compare these files',attachments:files});
  assert.equal(result.multiFile,true);
  assert.equal(result.suggestedWorkspace,null);
  assert.equal(classifySurfaceBoundary('Summarize and compare these files',{activeSurface:'normal-chat',attachments:files}).surface,'normal-chat');
});

test('Repo-level coding suggests Code without executing a switch', () => {
  const r=normalChatCapabilities({goal:'Fix the entire GitHub repository'});
  assert.equal(r.suggestedWorkspace,'code');
  assert.equal(r.fileCount,0);
});

test('Thesis and systematic research suggest Research while preserving attached files', () => {
  const files=[{name:'paper.pdf'},{name:'notes.docx'}];
  const r=normalChatCapabilities({goal:'Write a systematic literature review for my thesis',attachments:files});
  assert.equal(r.suggestedWorkspace,'research');
  assert.equal(r.fileCount,2);
  assert.equal(r.multiFile,true);
});

test('Sandbox displays ready only for an actual configured sandbox target', () => {
  const base={goal:'Run this Python script',attachments:[{name:'calc.py'}]};
  assert.equal(normalChatCapabilities(base).sandboxReady,false);
  assert.equal(normalChatCapabilities({...base,executionTargets:[
    {id:'generic-code-runner',taskTypes:['code'],configured:true}
  ]}).sandboxReady,false);
  assert.equal(normalChatCapabilities({...base,executionTargets:[
    {id:'general-ai-sandbox',taskTypes:['code'],configured:false}
  ]}).sandboxReady,false);
  assert.equal(normalChatCapabilities({...base,executionTargets:[
    {id:'general-ai-sandbox',taskTypes:['code'],configured:true}
  ]}).sandboxReady,true);
});

test('Simple chat never shows a sandbox or encourages a costly specialist workspace', () => {
  const r=normalChatCapabilities({goal:'Hello',attachments:[],currentSurface:'normal-chat'});
  assert.equal(r.showSandbox,false);
  assert.equal(r.suggestedWorkspace,null);
});

test('A specialized workspace is never offered a switch to itself', () => {
  for(const surface of ['code','research']) {
    assert.equal(normalChatCapabilities({currentSurface:surface,goal:'Build a full-stack repo and research a thesis'}).suggestedWorkspace,null);
  }
});

test('Attachment preview is a separate existing pathway from sandbox execution', async () => {
  const { readFile } = await import('node:fs/promises');
  const [preview,ui,uploads]=await Promise.all([
    readFile(new URL('../public/artifact-preview.js',import.meta.url),'utf8'),
    readFile(new URL('../public/adaptive-workspace.js',import.meta.url),'utf8'),
    readFile(new URL('../public/app-attachments.js',import.meta.url),'utf8')
  ]);
  assert.match(preview,/openArtifactPreview/);
  assert.match(ui,/normalChatToolStrip/);
  assert.match(ui,/Use .* workspace/);
  assert.match(uploads,/MAX_ATTACH_FILES = 10/);
  assert.match(uploads,/syncAdaptiveWorkspace\(\);/);
});
