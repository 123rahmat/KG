import test from 'node:test';
import assert from 'node:assert/strict';
import { chatNavigationModel, chatSurface, chatWorkStatus } from '../public/chat-navigation-model.js';
import { chatDraftKey } from '../public/chat-draft-key.js';
const chats=[
  {id:'r1',title:'Review primary papers',surface:'research',projectId:'p-research',
    state:'investigate',updatedAt:'2026-10-10T09:00:00Z'},
  {id:'c1',title:'Build backend API',surface:'code',projectId:'p-code',
    state:'approval',updatedAt:'2026-10-10T08:00:00Z'},
  {id:'c2',title:'Fix UI regression',surface:'code',projectId:'p-code',
    state:'complete',updatedAt:'2026-10-09T08:00:00Z'},
  {id:'r2',title:'Compare clinical evidence',surface:'research',projectId:'p-research',
    state:'waiting',updatedAt:'2026-10-09T07:00:00Z'},
  {id:'r3',title:'Unresolved document',surface:'research',projectId:'p-research',
    state:'failed',updatedAt:'2026-10-08T07:00:00Z'},
  {id:'n1',title:'General question',surface:'chat',projectId:null,
    state:'complete',updatedAt:'2026-10-07T07:00:00Z'}
];
test('workspace list filters preserve server ordering and scoped chat ownership',()=>{
  const all=chatNavigationModel(chats);
  assert.deepEqual(all.chats.map(x=>x.id),chats.map(x=>x.id));
  assert.equal(all.coding,2);
  assert.equal(all.research,3);
  assert.equal(all.needsAction,3);
  assert.equal(all.loaded,6);
  assert.deepEqual(chatNavigationModel(chats,{surface:'code'}).chats.map(x=>x.id),['c1','c2']);
  assert.deepEqual(chatNavigationModel(chats,{surface:'research',
    status:'action'}).chats.map(x=>x.id),['r2']);
  assert.deepEqual(chatNavigationModel(chats,{status:'issues'}).chats.map(x=>x.id),['r3']);
  assert.deepEqual(chatNavigationModel(chats,{status:'working'}).chats.map(x=>x.id),['r1']);
  assert.deepEqual(chatNavigationModel(chats,{projectId:'p-code'}).chats.map(x=>x.id),['c1','c2']);
  assert.deepEqual(chatNavigationModel(chats,{projectId:'p-research',query:'papers'}).chats.map(x=>x.id),['r1']);
  assert.equal(chatNavigationModel(chats,{projectId:'unknown'}).shown,0);
});
test('terminal, action and background statuses are distinct',()=>{
  assert.equal(chatSurface({surface:'visual'}),'normal-chat');
  for(const state of ['approval','clarify','waiting','iterate','verify']){
    assert.equal(chatWorkStatus({state}),'action',state);
  }
  for(const state of ['blocked','failed','exhausted']){
    assert.equal(chatWorkStatus({state}),'issues',state);
  }
  assert.equal(chatWorkStatus({state:'complete'}),'complete');
  assert.equal(chatWorkStatus({state:'code'}),'working');
});
test('draft keys isolate conversations, new project surfaces, workspaces and users',()=>{
  const initial={principalId:'person-a',workspaceId:'workspace-a',
    conversationId:'code-1',projectId:'project-a',surface:'code'};
  const key=chatDraftKey(initial);
  assert.equal(chatDraftKey({...initial,surface:'research'}),key,
    'same existing chat owns a single draft even when the composer surface changes');
  for(const alternate of [
    {...initial,conversationId:'research-1'},
    {...initial,workspaceId:'workspace-b'},
    {...initial,principalId:'person-b'}
  ])assert.notEqual(chatDraftKey(alternate),key);
  assert.notEqual(chatDraftKey({...initial,conversationId:null,projectId:'project-a'}),
    chatDraftKey({...initial,conversationId:null,projectId:'project-b'}));
  assert.notEqual(chatDraftKey({...initial,conversationId:null,surface:'code'}),
    chatDraftKey({...initial,conversationId:null,surface:'research'}));
  assert.ok(key.includes('chat:code-1'));
});

test('chat-title search matches server semantics rather than transient project-name matches',()=>{
  const view=chatNavigationModel([
    {id:'a',title:'Tests for backend',projectName:'Website launch',surface:'code'},
    {id:'b',title:'Research Website launch risks',surface:'research'}
  ],{query:'Website launch'});
  assert.deepEqual(view.chats.map(item=>item.id),['b']);
});
