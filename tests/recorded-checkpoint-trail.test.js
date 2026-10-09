import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedCheckpointTrail } from '../public/work-progress-panels.js';

test('simple Normal Chat requests do not invent a workflow timeline', () => {
  const empty = recordedCheckpointTrail({state:'running',tasks:[]});
  assert.equal(empty.recordedCount,0);
  assert.deepEqual(empty.markers,[]);
  assert.equal(empty.completedCount,0);
  assert.match(empty.explanation,/not a fixed plan/);
});
test('checkpoints come only from saved steps and identify a queued next action', () => {
  const panel = recordedCheckpointTrail({
    state:'running',next:'verify',
    tasks:[
      {id:'understand',status:'complete'},
      {id:'verify',status:'pending'},
    ]
  });
  assert.deepEqual(panel.markers.map(x=>x.status),['complete','pending']);
  assert.equal(panel.markers[1].next,true);
  assert.equal(panel.markers[1].statusLabel,'Up next');
  assert.equal(panel.completedCount,1);
  assert.equal(panel.recordedCount,2);
  assert.equal(panel.hiddenCount,0);
});
test('failed and blocked work retains truthful attention states', () => {
  const panel = recordedCheckpointTrail({
    state:'blocked',
    tasks:[{id:'test-code',status:'failed'},{id:'approval',status:'blocked'}]
  });
  assert.equal(panel.failedCount,2);
  assert.equal(panel.markers[0].statusLabel,'Failed');
  assert.equal(panel.markers[1].statusLabel,'Blocked');
  assert.ok(panel.markers.every(x=>x.next === false));
});
test('only last bounded stages show and count is never an estimated total', () => {
  const tasks = Array.from({length:25},(_,i)=>({id:'part-'+i,status:i<20?'complete':'pending'}));
  const panel = recordedCheckpointTrail({state:'running',tasks,next:'part-24'},{maxMarkers:8});
  assert.equal(panel.recordedCount,25);
  assert.equal(panel.completedCount,20);
  assert.equal(panel.hiddenCount,17);
  assert.equal(panel.markers.length,8);
  assert.equal(panel.markers.at(-1).next,true);
  assert.equal(Object.hasOwn(panel,'percent'),false);
});
test('long untrusted labels are bounded and unusual statuses normalize to pending', () => {
  const panel = recordedCheckpointTrail({state:'running',tasks:[
    {id:'custom',status:'<script>alert(1)</script>',metadata:{title:'X'.repeat(2000)}}
  ]});
  assert.equal(panel.markers[0].status,'pending');
  assert.equal(panel.markers[0].label.length,120);
  assert.equal(Object.isFrozen(panel.markers[0]),true);
});
test('max marker bound is enforced for malformed inputs', () => {
  const tasks=Array.from({length:30},(_,i)=>({id:String(i),status:'complete'}));
  assert.equal(recordedCheckpointTrail({tasks},{maxMarkers:Infinity}).markers.length,8);
  assert.equal(recordedCheckpointTrail({tasks},{maxMarkers:100}).markers.length,12);
  assert.equal(recordedCheckpointTrail({tasks},{maxMarkers:-5}).markers.length,1);
});
