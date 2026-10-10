import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatRefreshCoalescer } from '../public/chat-refresh-coalescer.js';
test('many background run updates coalesce to one chat-list request',()=>{
  const scheduled=new Map();let id=0,refreshes=0;
  const coalescer=createChatRefreshCoalescer(()=>refreshes++,{
    delayMs:2400,
    schedule(fn,ms){assert.equal(ms,2400);const token=++id;scheduled.set(token,fn);return token;},
    cancel(token){scheduled.delete(token);}
  });
  assert.equal(coalescer.request(),true);
  for(let i=0;i<50;i++)assert.equal(coalescer.request(),false);
  assert.equal(scheduled.size,1);
  assert.equal(refreshes,0);
  const [[token,fn]]=[...scheduled.entries()];
  scheduled.delete(token);fn();
  assert.equal(refreshes,1);
  assert.equal(coalescer.request(),true);
  assert.equal(coalescer.flush(),true);
  assert.equal(refreshes,2);
  assert.equal(coalescer.flush(),false);
  assert.equal(scheduled.size,0);
  assert.equal(coalescer.request(),true);
  assert.equal(coalescer.cancel(),true);
  assert.equal(coalescer.cancel(),false);
  assert.equal(scheduled.size,0);
});
