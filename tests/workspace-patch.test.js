import test from 'node:test';
import assert from 'node:assert/strict';
import { applySurgicalChanges, changeSetDigest, contentDigest } from '../src/workspace-patch.js';
import { materializeCodePackage } from '../src/code-workflow.js';
import { workspaceContentHash } from '../src/code-workspace.js';

test('surgical range patches require the expected pre-image and preserve unrelated files', () => {
  const files = [
    { path: 'src/a.js', content: 'const a = 1;\nconst b = 2;\n' },
    { path: 'src/b.js', content: 'export const b = 3;\n' }
  ];
  const baseHash = workspaceContentHash(files);
  const expected = contentDigest(files[0].content);
  const result = applySurgicalChanges(files, [{
    path: 'src/a.js',
    kind: 'range',
    startLine: 2,
    endLine: 2,
    expectedDigest: expected,
    replacement: 'const b = 4;'
  }], { expectedContentHash: baseHash });
  assert.equal(result.files.find(f => f.path === 'src/a.js').content, 'const a = 1;\nconst b = 4;\n');
  assert.equal(result.files.find(f => f.path === 'src/b.js').content, files[1].content);
  assert.ok(changeSetDigest(result.changed.map(path => ({ path }))));
});

test('stale workspace changes are rejected', () => {
  const files = [{ path: 'src/a.js', content: 'const a = 1;\n' }];
  assert.throws(() => applySurgicalChanges(files, [{
    path: 'src/a.js',
    kind: 'range',
    startLine: 1,
    endLine: 1,
    expectedDigest: contentDigest(files[0].content),
    replacement: 'const a = 2;'
  }], { expectedContentHash: workspaceContentHash([{ path: 'src/a.js', content: 'const a = 9;\n' }]) }), error => error.code === 'stale-workspace');
});

test('code workflow materializes compact patches into the project contract', () => {
  const baseFiles = [{ path: 'src/a.js', content: 'const a = 1;\nconst b = 2;\n' }];
  const pkg = materializeCodePackage({
    language: 'javascript',
    patches: [{
      path: 'src/a.js',
      kind: 'range',
      startLine: 2,
      endLine: 2,
      expectedDigest: contentDigest(baseFiles[0].content),
      replacement: 'const b = 5;'
    }],
    baseContentHash: workspaceContentHash(baseFiles)
  }, { baseFiles });
  assert.equal(pkg.files[0].content, 'const a = 1;\nconst b = 5;\n');
  assert.equal(pkg.patches, undefined);
});

test('workspace patches reject credential and private-key files', () => {
  assert.throws(() => applySurgicalChanges(
    [],
    [{ path: '.env', content: 'SECRET=value' }]
  ), /credential or private-key/);
  assert.throws(() => applySurgicalChanges(
    [],
    [{ path: 'certs/server.pem', content: 'PRIVATE' }]
  ), /credential or private-key/);
  assert.doesNotThrow(() => applySurgicalChanges(
    [],
    [{ path: '.env.example', content: 'PUBLIC_EXAMPLE=value' }]
  ));
});

test('range patch digests change when the exact operation changes', () => {
  const base = {
    path: 'src/a.js',
    kind: 'range',
    startLine: 2,
    endLine: 2,
    expectedDigest: contentDigest('const a = 1;'),
    replacement: 'const a = 2;'
  };
  const line = changeSetDigest([base]);
  const replacement = changeSetDigest([{ ...base, replacement: 'const a = 3;' }]);
  const range = changeSetDigest([{ ...base, startLine: 3 }]);
  assert.notEqual(line, replacement);
  assert.notEqual(line, range);
});

test('mature coding patches require revision or preimage for any existing file mutation',()=>{
  const files=[{path:'src/a.js',content:'old\n'}];
  for(const patch of [
    {path:'src/a.js',kind:'upsert',content:'new\n'},
    {path:'src/a.js',kind:'delete'},
    {path:'src/a.js',kind:'range',startLine:1,endLine:1,replacement:'new'}
  ]){
    assert.throws(()=>applySurgicalChanges(files,[patch]),
      error=>error.code==='missing-preimage',JSON.stringify(patch));
  }
  assert.equal(applySurgicalChanges(files,[{
    path:'src/a.js',kind:'upsert',content:'new\n',beforeDigest:contentDigest(files[0].content)
  }]).files[0].content,'new\n');
  assert.equal(applySurgicalChanges(files,[{
    path:'src/a.js',kind:'delete',beforeDigest:contentDigest(files[0].content)
  }]).files.length,0);
  assert.equal(applySurgicalChanges(files,[{
    path:'src/a.js',kind:'range',startLine:1,endLine:1,
    expectedDigest:contentDigest(files[0].content),replacement:'new'
  }]).files[0].content,'new\n');
});
test('mixed patch methods on one file are rejected before execution',()=>{
  const base=[{path:'src/a.js',content:'alpha\nbeta'}];
  const range={path:'src/a.js',kind:'range',startLine:1,endLine:1,
    expectedDigest:contentDigest(base[0].content),replacement:'new'};
  const deleteOp={path:'src/a.js',kind:'delete'};
  const upsert={path:'src/a.js',kind:'upsert',content:'new'};
  for(const patch of [
    [range,deleteOp],[deleteOp,range],[range,upsert],[upsert,range],
    [upsert,upsert],[deleteOp,deleteOp]
  ]){
    assert.throws(()=>applySurgicalChanges(base,patch,{expectedContentHash:workspaceContentHash(base)}),
      /conflicting operations/,JSON.stringify(patch));
  }
});
test('stale range bounds, missing preimage targets, and overlapping edits fail closed',()=>{
  const files=[{path:'src/main.js',content:'one\ntwo\nthree'}],hash=workspaceContentHash(files);
  const digest=contentDigest(files[0].content);
  assert.throws(()=>applySurgicalChanges(files,[{
    path:'src/main.js',kind:'range',startLine:5,endLine:5,
    expectedDigest:digest,replacement:'five'
  }],{expectedContentHash:hash}),e=>e.code==='stale-file');
  assert.throws(()=>applySurgicalChanges(files,[{
    path:'src/missing.js',kind:'delete',beforeDigest:digest
  }],{expectedContentHash:hash}),e=>e.code==='stale-file');
  const ranges=[
    {path:'src/main.js',kind:'range',startLine:1,endLine:2,expectedDigest:digest,replacement:'a'},
    {path:'src/main.js',kind:'range',startLine:2,endLine:3,expectedDigest:digest,replacement:'b'}
  ];
  assert.throws(()=>applySurgicalChanges(files,ranges,{expectedContentHash:hash}),
    /Overlapping patch ranges/);
});
test('independent descending line-range patches retain deterministic diff and other files',()=>{
  const files=[
    {path:'src/main.js',content:'one\ntwo\nthree\nfour'},
    {path:'README.md',content:'not touched'}
  ];
  const d=contentDigest(files[0].content);
  const patches=[
    {path:'src/main.js',kind:'range',startLine:1,endLine:1,
      expectedDigest:d,replacement:'ONE'},
    {path:'src/main.js',kind:'range',startLine:4,endLine:4,
      expectedDigest:d,replacement:'FOUR'}
  ];
  const applied=applySurgicalChanges(files,patches,{expectedContentHash:workspaceContentHash(files)});
  assert.equal(applied.files.find(x=>x.path==='src/main.js').content,'ONE\ntwo\nthree\nFOUR');
  assert.equal(applied.files.find(x=>x.path==='README.md').content,'not touched');
  assert.deepEqual(applied.changed,['src/main.js']);
});
