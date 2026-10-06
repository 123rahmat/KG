/** Grok-only live provider contract check. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runProviderSmoke } from '../src/provider-smoke.js';
const reply=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
const grok=text=>reply({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:12,output_tokens:2}});
const classifierReply=()=>reply({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({actions:['answer'],signals:{research:false,file:false,code:false,creation:false,invention:false,uncertainty:false,physical:false,highImpact:false},unknownSituation:false,confidence:1,crisis:'none'})}]}],usage:{input_tokens:12,output_tokens:2}});
test('unconfigured Grok is skipped',async()=>{const s=await runProviderSmoke({env:{},fetchImpl:()=>{throw new Error('must not call');}});assert.equal(s.ran,0);});
test('configured Grok passes the smoke contract',async()=>{const s=await runProviderSmoke({env:{SMOKE_XAI_API_KEY:'k'},fetchImpl:async(_url,options)=>String(options?.body||'').includes('Classify the goal')?classifierReply():grok('ready')});assert.equal(s.ran,1);assert.equal(s.ok,true,JSON.stringify(s.results));});
