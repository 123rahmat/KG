import test from 'node:test';
import assert from 'node:assert/strict';
import { tablePreviewModel } from '../public/table-preview-model.js';

test('array data renders as cells, without fabricating the first row as headers',()=>{
  const result=tablePreviewModel({name:'Sheet 1',sample:[['Name','Price'],['Notebook',12]]});
  assert.deepEqual(result.header,[]);
  assert.deepEqual(result.rows,[['Name','Price'],['Notebook','12']]);
  assert.equal(result.readOnly,true);
});
test('object rows use stable property keys and visible column labels',()=>{
  const result=tablePreviewModel({sample:[{product:'Paper',quantity:4},{product:'Pen',quantity:9}]});
  assert.deepEqual(result.header,['product','quantity']);
  assert.deepEqual(result.rows,[['Paper','4'],['Pen','9']]);
});
test('explicit headers are preserved',()=>{
  const result=tablePreviewModel({headers:['Date','Total'],sample:[['2026-10-09',25]]});
  assert.deepEqual(result.header,['Date','Total']);
  assert.deepEqual(result.rows,[['2026-10-09','25']]);
});
test('wide and long samples are bounded without writing source data',()=>{
  const sample=Array.from({length:40},()=>Array.from({length:30},()=>('x'.repeat(1000))));
  const result=tablePreviewModel({sample},{maxRows:15,maxColumns:9});
  assert.equal(result.rows.length,15);
  assert.equal(result.rows[0].length,9);
  assert.equal(result.rows[0][0].length,238);
  assert.equal(result.truncatedRows,true);
  assert.equal(result.truncatedColumns,true);
  assert.equal(sample[0][0].length,1000);
});
test('empty and malformed samples produce an empty safe model',()=>{
  const result=tablePreviewModel({sample:{bad:'shape'}});
  assert.deepEqual(result.rows,[]);
  assert.equal(result.name,'Table sample');
  assert.equal(Object.isFrozen(result),true);
});
test('structured cell contents are escaped by DOM text rendering, not compiled as HTML',()=>{
  const result=tablePreviewModel({sample:[['<img src=x onerror=alert(1)>']]});
  assert.equal(result.rows[0][0],'<img src=x onerror=alert(1)>');
  assert.equal(result.readOnly,true);
});
