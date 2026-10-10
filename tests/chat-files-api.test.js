import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

test('Chat Files lists only attached files and generated artifacts from this conversation', async () => {
  await withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({ role:'admin' });
    const auth = { token, workspace };
    const attachment = await call('POST','/api/objects',{ ...auth,
      body:{ type:'attachment', name:'source-paper.pdf', contentType:'application/pdf',
        content:'fake pdf bytes', visibility:'private' }
    });
    assert.equal(attachment.status,201,JSON.stringify(attachment.body));
    const unrelated = await call('POST','/api/objects',{ ...auth,
      body:{ type:'artifact', name:'unrelated.txt', content:'Unrelated private data' }
    });
    assert.equal(unrelated.status,201);
    const id = 'chat-files-scope-12345678';
    const run = await call('POST','/api/runs',{ ...auth,
      body:{
        goal:'Explain this Python code and the attached source file.',
        conversationId:id, activeSurface:'code', attachments:[attachment.body.id],
        privacyConsent:{modelProvider:false}
      }
    });
    assert.equal(run.status,201,JSON.stringify(run.body));
    // Upload directly from the Files pane: not from GitHub and not tied to
    // a message until the person explicitly uses it in the next request.
    const fromDevice = await call('POST','/api/objects',{ ...auth,
      body:{ type:'attachment', name:'my-phone-photo.png', contentType:'image/png',
        content:'phone-upload-binary', visibility:'private',
        provenance:{source:'chat-upload',runId:run.body.id}
      }
    });
    assert.equal(fromDevice.status,201,JSON.stringify(fromDevice.body));
    const saved = await call('POST','/api/objects',{ ...auth,
      body:{ type:'chat-answer', name:'answer.txt', content:'saved answer',
        provenance:{source:'chat-answer',runId:run.body.id} }
    });
    assert.equal(saved.status,201,JSON.stringify(saved.body));
    const response = await call('GET','/api/conversations/'+id+'/files',auth);
    assert.equal(response.status,200,JSON.stringify(response.body));
    const ids = response.body.files.map(file => file.id);
    assert.ok(ids.includes(attachment.body.id),'saved input attachment is present');
    assert.ok(ids.includes(fromDevice.body.id),'direct device upload belongs to the chat');
    assert.equal(response.body.files.find(file => file.id === fromDevice.body.id).category,'attachment');
    assert.ok(ids.includes(saved.body.id),'saved result artifact is present');
    assert.ok(!ids.includes(unrelated.body.id),'unrelated workspace file must not leak');
    assert.equal(response.body.files.find(file => file.id === attachment.body.id).category,'attachment');
    assert.equal(response.body.files.find(file => file.id === saved.body.id).category,'artifact');
    assert.ok(response.body.files.every(file => !('provenance' in file) && !('digest' in file)));
    const other = await call('GET','/api/conversations/another-chat-000000/files',auth);
    assert.equal(other.status,404);
  });
});

test('Chat Files respects principal access even for linkable provenance', async () => {
  await withServer(async ({call,seed}) => {
    const first=await seed({workspace:'one'});
    const second=await seed({workspace:'two'});
    const a={token:first.token,workspace:first.workspace};
    const b={token:second.token,workspace:second.workspace};
    const id='chat-files-private-12345';
    const run=await call('POST','/api/runs',{...a,body:{
      goal:'Explain a TypeScript function',activeSurface:'code',conversationId:id,
      privacyConsent:{modelProvider:false}
    }});
    assert.equal(run.status,201,JSON.stringify(run.body));
    await call('POST','/api/objects',{...a,body:{
      name:'secret.txt',content:'Secret',type:'artifact',provenance:{runId:run.body.id}
    }});
    const isolated=await call('GET','/api/conversations/'+id+'/files',b);
    assert.equal(isolated.status,404);
  });
});

test('shared workspace member cannot inject forged artifacts into another owner’s chat', async () => {
  await withServer(async ({call,seed}) => {
    const owner=await seed({workspace:'shared-chat',role:'admin'});
    const colleague=await seed({workspace:'shared-chat',role:'editor'});
    const chatId='shared-chat-files-12345';
    const victimRun=await call('POST','/api/runs',{token:owner.token,workspace:owner.workspace,
      body:{goal:'Explain TypeScript interfaces',activeSurface:'code',conversationId:chatId,
        privacyConsent:{modelProvider:false},visibility:'workspace'}
    });
    assert.equal(victimRun.status,201,JSON.stringify(victimRun.body));
    const forged=await call('POST','/api/objects',{token:colleague.token,workspace:colleague.workspace,
      body:{name:'unrelated-fake-artifact.txt',content:'not from this chat',type:'artifact',
        provenance:{runId:victimRun.body.id},visibility:'workspace'}
    });
    assert.equal(forged.status,201,JSON.stringify(forged.body));
    const listed=await call('GET','/api/conversations/'+chatId+'/files',{
      token:owner.token,workspace:owner.workspace
    });
    assert.equal(listed.status,200,JSON.stringify(listed.body));
    assert.ok(!listed.body.files.some(file => file.id === forged.body.id));
  });
});
