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

test('every workspace suggests the specialized destination required by current work', () => {
  const cases = [
    { currentSurface: 'research', goal: 'Fix the entire GitHub repository', attachments: [], want: 'code' },
    { currentSurface: 'code', goal: 'Write a systematic literature review for my thesis', attachments: [], want: 'research' },
    { currentSurface: 'research', goal: 'Run and fix these files', attachments: inputs, want: 'code' },
    { currentSurface: 'code', goal: 'Analyze this research bundle', attachments: [{ name: 'sources.zip', archiveKind: 'research-bundle' }], want: 'research' },
    { currentSurface: 'research', goal: 'Repair this project', attachments: [{ name: 'project.zip', archiveKind: 'code-project' }], want: 'code' }
  ];
  for (const { want, ...input } of cases) assert.equal(normalChatCapabilities(input).suggestedWorkspace, want);
});

test('clearly lightweight new work can return from a deep workspace to Normal Chat', () => {
  for (const currentSurface of ['code', 'research']) {
    assert.equal(normalChatCapabilities({ currentSurface, goal: 'Translate this paragraph', attachments: [{ name: 'note.txt' }] }).suggestedWorkspace, 'normal-chat');
    assert.equal(normalChatCapabilities({ currentSurface, goal: 'Explain this short script', attachments: [{ name: 'demo.py' }] }).suggestedWorkspace, 'normal-chat');
    for (const goal of ['', 'Continue', 'What about the previous result?']) {
      assert.equal(normalChatCapabilities({ currentSurface, goal }).suggestedWorkspace, null);
    }
  }
});

test('recommendations do not offer the selected workspace to itself', () => {
  for (const [currentSurface, goal] of [['code', 'Fix the entire GitHub repository'], ['research', 'Write my systematic literature review'], ['normal-chat', 'Translate this paragraph']]) {
    assert.equal(normalChatCapabilities({ currentSurface, goal }).suggestedWorkspace, null);
  }
});

test('task text alone suggests the right deep workspace before files are attached', () => {
  for (const currentSurface of ['normal-chat', 'code', 'research']) {
    for (const [goal, destination] of [
      ['Build a complete ecommerce website with authentication and a database', 'code'],
      ['Research battery recycling and compare credible sources', 'research']
    ]) {
      const result = normalChatCapabilities({ currentSurface, goal });
      assert.equal(result.suggestedWorkspace, currentSurface === destination ? null : destination);
      assert.equal(result.fileCount, 0);
    }
  }
});

test('ordinary requests about existing work stay in the selected deep workspace', () => {
  for (const currentSurface of ['code', 'research']) {
    for (const goal of ['Summarize the findings', 'Explain the previous result', 'Explain the next step', 'Summarize our work so far']) {
      assert.equal(normalChatCapabilities({ currentSurface, goal }).suggestedWorkspace, null);
    }
  }
});

test('incidental software words do not override the actual task intent', () => {
  assert.equal(normalChatCapabilities({ currentSurface: 'normal-chat', goal: 'Explain how to create a customer service policy' }).suggestedWorkspace, null);
  for (const currentSurface of ['normal-chat', 'code', 'research']) {
    for (const goal of ['Research GitHub adoption using credible sources', 'Investigate deployment failure rates across companies']) {
      assert.equal(normalChatCapabilities({ currentSurface, goal }).suggestedWorkspace, currentSurface === 'research' ? null : 'research');
    }
  }
});
