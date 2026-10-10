import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationFileLinks, presentConversationFile } from '../src/chat-files.js';

test('only recognized run attachments and generated object refs enter a chat', () => {
  const list = conversationFileLinks([{
    id:'run-12345678',
    adaptation:{attachments:[{id:'attachment-12345678',name:'paper.pdf'}],
      generatedArtifacts:[{objectId:'generated-12345678'}]},
    tasks:[{evidence:{artifacts:[{id:'figure-12345678'}],
      text:'unrelated-987654321',artifact:{id:'figure-12345678'}}}]
  }]);
  assert.deepEqual(list.runIds,['run-12345678']);
  assert.deepEqual(list.attachmentIds,['attachment-12345678']);
  assert.deepEqual(list.artifactIds,['generated-12345678','figure-12345678']);
});

test('invalid references, repeated inputs and unrelated fields do not create objects', () => {
  const links=conversationFileLinks([{id:'run-12345678',
    adaptation:{attachments:['../../private','',null,'valid-id-12345678','valid-id-12345678']},
    tasks:[{evidence:{artifacts:['hi'],result:{someId:'hidden-id-12345678'}}}]}]);
  assert.deepEqual(links.attachmentIds,['valid-id-12345678']);
  assert.deepEqual(links.artifactIds,[]);
});

test('file projection contains no object provenance, secret metadata or stored bytes', () => {
  assert.deepEqual(presentConversationFile({
    id:'object-12345678',name:'output.pdf',type:'chat-answer',
    size:435,content_type:'application/pdf',created_at:'2026-10-10',
    provenance:{private:'secret'},digest:'private digest'
  },new Set()),{
    id:'object-12345678',name:'output.pdf',contentType:'application/pdf',
    size:435,createdAt:'2026-10-10',category:'artifact'
  });
});
