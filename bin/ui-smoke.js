/** Browser regression checks for the real UI with controlled API boundaries. */
/* global document, window, getSelection */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
const output = process.env.UI_SMOKE_OUTPUT_DIR || await mkdtemp(path.join(tmpdir(), 'kindgleam-ui-'));
const artifact = name => path.join(output, name);
const app = express();
app.use('/api', (_req,res) => res.status(401).json({code:'unauthenticated',error:'Sign in'}));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.UI_SMOKE_EXECUTABLE ? { executablePath: process.env.UI_SMOKE_EXECUTABLE } : {}),
  ...(process.env.UI_SMOKE_EXECUTABLE ? { args: ['--no-sandbox', '--no-zygote', '--single-process', '--disable-gpu', '--disable-software-rasterizer', '--use-gl=disabled'] } : {})
});
const page = await browser.newPage({viewport:{width:1440,height:950},reducedMotion:'reduce'});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.getElementById('landing').hidden===false);
 await page.screenshot({path:artifact('landing-desktop.png')});
 await page.evaluate(async()=>{
  const {state}=await import('/ui-core.js'); const {renderThread}=await import('/app-attachments.js');
  document.getElementById('landing').hidden=true;document.getElementById('gate').hidden=true;document.getElementById('app').hidden=false;
  state.principal={id:'tester'};state.role='admin';state.workspaceId='ws';
  state.executionConfig={reasoning:{configured:true,provider:'google'},targets:[]};
  const task=(id,type,status,evidence={})=>({id,type,status,evidence,metadata:{},dependsOn:[]});
  const history=Array.from({length:9},(_,i)=>({id:'old-'+i,conversationId:'chat',goal:'Explain this idea '+i,workflow:'direct',state:'complete',attempt:1,tasks:[task('respond','respond','complete',{text:'A clear answer for your request.\n\n'+('Useful explanation with enough detail to read comfortably. '.repeat(12))})],adaptation:{},updatedAt:new Date().toISOString()}));
  const live={id:'live',conversationId:'chat',goal:'Review this code and explain the change.',workflow:'adaptive',surface:'normal-chat',state:'respond',next:'respond',attempt:1,tasks:[task('understand','understand','complete'),task('respond','respond','running')],adaptation:{},updatedAt:new Date().toISOString()};
  state.chat={id:'chat',runs:[...history,live],pending:null};state.run=live;state.driving='live';state.drivingRuns.add('live');
  window.qa={state,renderThread,task};renderThread();window.oldNode=document.querySelector('[data-render-key="old-0:assistant"]');
 });
 await page.evaluate(()=>window.qa.renderThread());
 assert.equal(await page.evaluate(()=>window.oldNode===document.querySelector('[data-render-key="old-0:assistant"]')),true,'unchanged history must remain mounted');
 await page.screenshot({path:artifact('chat-desktop.png')});
 await page.evaluate(()=>window.scrollTo(0,700));
 const scrollBefore=await page.evaluate(()=>window.scrollY);
 await page.evaluate(()=>{const {state,renderThread}=window.qa;state.run.updatedAt=new Date(Date.now()+1000).toISOString();renderThread();});
 assert.ok(Math.abs(await page.evaluate(()=>window.scrollY)-scrollBefore)<3,'background updates must not pull readers to the bottom');
 assert.equal(await page.locator('#threadJump').isVisible(),true);
 await page.locator('#threadJump').click();
 await page.waitForFunction(()=>document.scrollingElement.scrollHeight-window.scrollY-window.innerHeight<150);
 await page.evaluate(()=>{const {state,renderThread,task}=window.qa;state.driving=null;state.drivingRuns.clear();state.run.state='clarify';state.run.next='question';state.run.tasks.push(task('question','clarify','pending'));renderThread();});
 const draft=page.locator('[data-input-context] textarea').first();
 await draft.fill('Keep my draft while the server updates.');
 const focusBefore=await draft.evaluate(node=>{node.focus();node.setSelectionRange(5,9);return node.value;});
 await page.evaluate(()=>{const {state,renderThread}=window.qa;state.run.updatedAt=new Date(Date.now()+2000).toISOString();renderThread();});
 assert.equal(await draft.inputValue(),focusBefore,'polling must preserve a typed clarification');
 assert.equal(await draft.evaluate(node=>node===document.activeElement),true,'polling must preserve input focus');
 assert.equal(await draft.evaluate(node=>node.selectionStart),5,'polling must preserve the caret');
 await page.evaluate(()=>{
  const {state,renderThread,task}=window.qa;
  state.executionConfig.targets=[{id:'research',label:'Research',taskTypes:['investigate'],configured:true}];
  state.run.next='research';state.run.state='investigate';state.run.tasks.push(task('research','investigate','pending'));renderThread();
 });
 const approval=page.locator('[data-input-context] input[type="checkbox"]').first();
 await approval.check();
 const runResearch=page.getByRole('button',{name:'Run the research',exact:true});
 assert.equal(await runResearch.isEnabled(),true);
 await page.evaluate(()=>{window.qa.state.run.updatedAt=new Date(Date.now()+4000).toISOString();window.qa.renderThread();});
 assert.equal(await approval.isChecked(),true,'same-step refresh must retain approval');
 assert.equal(await runResearch.isEnabled(),true,'restored approval must keep its action enabled');
 await page.evaluate(()=>{
  const answer=document.querySelector('[data-render-key="old-8:assistant"] .answer p');
  const range=document.createRange();range.selectNodeContents(answer);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  window.selectedText=selection.toString();window.qa.state.run.updatedAt=new Date(Date.now()+5000).toISOString();window.qa.renderThread();
 });
 assert.equal(await page.evaluate(()=>getSelection().toString()===window.selectedText),true,'polling must preserve text selection');
 await page.evaluate(()=>getSelection().removeAllRanges());
 await page.evaluate(()=>{const {state,renderThread}=window.qa;state.network.online=false;state.network.reachable=false;renderThread();});
 assert.equal(await page.locator('.work-status-copy strong').last().textContent(),'Connection lost');
 assert.equal(await page.locator('[data-work-live="true"]').count(),0);
 await page.screenshot({path:artifact('offline-desktop.png')});
 await page.evaluate(()=>{const {state,renderThread}=window.qa;state.network.online=true;state.network.reachable=true;state.activeSurface='code';state.workspaceSource={id:'project',kind:'github',name:'123rahmat/KG',repoRef:'main',permissions:{write:true},metadata:{commitSha:'abc123',manifest:[]}};renderThread();});
 await page.screenshot({path:artifact('code-desktop.png')});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';window.scrollTo(0,document.scrollingElement.scrollHeight);});
 await page.screenshot({path:artifact('code-dark.png')});
 await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
 for(const width of [320,390,768,1024]) {
  await page.setViewportSize({width,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,`workspace must fit at ${width}px`);
  await page.screenshot({path:artifact(`code-${width}.png`)});
 }
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{const {state,renderThread}=window.qa;state.activeSurface='research';state.run.adaptation.researchWorkspace={sourceCount:3,evidenceCount:5,unresolvedQuestions:['Need a primary source']};renderThread();window.scrollTo(0,0);});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'research must fit mobile');
 await page.screenshot({path:artifact('research-mobile.png')});
 await page.evaluate(()=>{document.getElementById('app').hidden=true;document.getElementById('landing').hidden=false;window.scrollTo(0,0);});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'landing must fit mobile');
 await page.screenshot({path:artifact('landing-mobile.png')});
 assert.deepEqual(errors,[],'no client runtime errors');
 console.log('Screenshots: ' + output);
 console.log('PASS: stable history, scroll anchoring, jump to latest, drafts, focus, caret, approvals, text selection, offline truth, responsive code/research/landing, no runtime errors');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
