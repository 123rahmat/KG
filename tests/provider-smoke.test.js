/** Grok-only live provider contract check. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runProviderSmoke } from '../src/provider-smoke.js';
const reply=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
const grok=text=>reply({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:12,output_tokens:2}});
test('unconfigured Grok is skipped',async()=>{const s=await runProviderSmoke({env:{},fetchImpl:()=>{throw new Error('must not call');}});assert.equal(s.ran,0);});
test('configured Grok passes the smoke contract',async()=>{const s=await runProviderSmoke({env:{SMOKE_XAI_API_KEY:'k'},fetchImpl:async()=>grok('ready')});assert.equal(s.ran,1);assert.equal(s.ok,true,JSON.stringify(s.results));});
