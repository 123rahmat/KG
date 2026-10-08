import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProjectIndex } from '../src/project-index.js';
import { compileCodeContext } from '../src/context-compiler.js';
import { workspaceContentHash } from '../src/code-workspace.js';
import { contentDigest } from '../src/workspace-patch.js';
import { materializeCodePackage, missingTests, sandboxPayload } from '../src/code-workflow.js';

const pricing = [
  'export function orderTotal(items, shipping = 0, discount = 0) {',
  '  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);',
  '  return Number(((subtotal + shipping) * (1 - discount)).toFixed(2));',
  '}', ''
].join('\n');
const spec = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { orderTotal } from '../src/pricing.mjs';",
  "test('shipping is never discounted', () => {",
  '  assert.equal(orderTotal([{price:50,quantity:2}], 10, .1), 100);',
  '});',
  "test('empty cart without shipping remains zero', () => {",
  '  assert.equal(orderTotal([], 0, .25), 0);',
  '});',
  "test('undiscounted totals still work', () => {",
  '  assert.equal(orderTotal([{price:20,quantity:3}], 5), 65);',
  '});', ''
].join('\n');
const base = [
  {path:'src/pricing.mjs',content:pricing},
  {path:'tests/pricing.test.mjs',content:spec},
  {path:'README.md',content:'Pricing fixture\n'}
];
function runFixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(),'kg-real-code-'));
  try {
    for (const file of files) {
      const target = path.join(dir,file.path);
      mkdirSync(path.dirname(target),{recursive:true});
      writeFileSync(target,file.content);
    }
    // A nested node:test process must not inherit its parent's test-worker
    // context, or it can exit successfully without running any tests.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', 'tests/pricing.test.mjs'], {
        cwd:dir, encoding:'utf8', timeout:15_000, env
      });
    assert.equal(child.error, undefined, String(child.error));
    const output = String(child.stdout ?? '');
    const passed = Number(output.match(/^# pass (\d+)/m)?.[1] ?? 0);
    const failed = Number(output.match(/^# fail (\d+)/m)?.[1] ?? 0);
    assert.ok(passed + failed > 0,
      'Nested test runner executed no tests: ' + String(child.stderr ?? '').slice(0, 300));
    return {exitCode:child.status, passed, failed};
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

test('coding task: real failing test, scoped fix, then actual passing Node test', () => {
  const goal='Fix the bug where merchandise discount incorrectly reduces shipping.';
  const context=compileCodeContext({
    files:base,index:buildProjectIndex(base),goal,changedPaths:['src/pricing.mjs'],
    task:{id:'build-code',type:'code',purpose:goal},scale:'small',maxChars:6000,maxFiles:3
  });
  assert.ok(context.files.some(file=>file.path==='src/pricing.mjs'));
  assert.ok(context.files.some(file=>file.path==='tests/pricing.test.mjs'));
  assert.deepEqual(runFixture(base),{exitCode:1,passed:2,failed:1});

  const hash=workspaceContentHash(base);
  const patch={language:'javascript',baseContentHash:hash,patches:[{
    path:'src/pricing.mjs',kind:'range',startLine:3,endLine:3,
    expectedDigest:contentDigest(pricing),
    replacement:'  return Number((subtotal * (1 - discount) + shipping).toFixed(2));'
  }]};
  const fixed=materializeCodePackage(patch,{baseFiles:base,baseContentHash:hash});
  assert.equal(missingTests(fixed),false);
  assert.equal(fixed.files.find(file=>file.path==='README.md').content,'Pricing fixture\n');
  const payload=sandboxPayload(fixed);
  assert.match(payload.files['src/pricing.mjs'],/subtotal \* \(1 - discount\) \+ shipping/);
  assert.deepEqual(runFixture(fixed.files),{exitCode:0,passed:3,failed:0});
  assert.throws(()=>materializeCodePackage(patch,{baseFiles:base,baseContentHash:'0'.repeat(64)}),
    error=>error.code==='workspace-revision-stale');
});
