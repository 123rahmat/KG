import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatSendKey, chatIsSending, syncVisibleChatSending, markChatSending
} from '../public/chat-send-state.js';
import { retrySubmissionScope } from '../public/conversation-submission-scope.js';

const chat=id=>({id,runs:[]});
const store=(id='ws-one')=>({workspaceId:id,chat:chat('coding-one'),
  sendingChats:new Set(),sendWaiting:false});

test('concurrent chat submissions lock only their own active composer',()=>{
  const state=store();
  const coding=state.chat;
  assert.equal(chatSendKey(state.workspaceId,coding.id),
    JSON.stringify(['ws-one','coding-one']));
  markChatSending(state,coding,'ws-one',true);
  assert.equal(state.sendWaiting,true);
  assert.equal(chatIsSending(state,coding),true);
  state.chat=chat('research-two');
  syncVisibleChatSending(state);
  assert.equal(state.sendWaiting,false,'switching chats allows independent submission');
  const research=state.chat;
  markChatSending(state,research,'ws-one',true);
  assert.equal(state.sendWaiting,true);
  assert.equal(state.sendingChats.size,2);
  markChatSending(state,coding,'ws-one',false);
  assert.equal(state.sendWaiting,true,'late completion must not unlock research composer');
  markChatSending(state,research,'ws-one',false);
  assert.equal(state.sendWaiting,false);
  assert.equal(state.sendingChats.size,0);
});

test('reopening the same conversation stays locked until its original send completes',()=>{
  const state=store();
  const earlier=state.chat;
  markChatSending(state,earlier,'ws-one',true);
  state.chat=chat('coding-one');
  assert.equal(syncVisibleChatSending(state),true);
  markChatSending(state,earlier,'ws-one',false);
  assert.equal(syncVisibleChatSending(state),false);
});

test('workspace boundaries prevent another account workspace from owning the visible lock',()=>{
  const state=store();
  const old=state.chat;
  markChatSending(state,old,'ws-one',true);
  state.workspaceId='ws-other';
  state.chat=chat('coding-one');
  assert.equal(syncVisibleChatSending(state),false);
  markChatSending(state,old,'ws-one',false);
  assert.equal(state.sendWaiting,false);
  assert.equal(chatSendKey(null,'x'),null);
  assert.equal(chatSendKey('ws-one',null),null);
});

test('retry always preserves original conversation project and workspace surface',()=>{
  const retry=retrySubmissionScope({
    conversationId:'existing-chat',projectId:'original-project',surface:'research',
    adaptation:{workspaceSourceId:'approved-source-id'}
  },{id:'unrelated-chat',projectId:'new-project',workspaceSourceId:'other-source'});
  assert.deepEqual(retry,{
    conversationId:'existing-chat',projectId:'original-project',
    activeSurface:'research',workspaceSourceId:'approved-source-id'
  });
  assert.equal(Object.isFrozen(retry),true);
  const noProject=retrySubmissionScope({
    conversationId:'projectless',projectId:null,surface:'code'
  },{id:'projectless',projectId:'sidebar-project'});
  assert.equal(noProject.projectId,null,'explicit projectless chat cannot migrate');
  assert.equal(noProject.activeSurface,'code');
  const primary=retrySubmissionScope({conversationId:'chat-two',
    adaptation:{primarySurface:'research'}},{id:'chat-two'});
  assert.equal(primary.activeSurface,'research');
});
