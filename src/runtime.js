/** Grok 4.7-only inference and execution boundaries. */
import { MODEL_CATALOG, resolveConfiguredModel } from './model-catalog.js';
import { AdaptiveProviderGovernor } from './adaptive-provider-governor.js';
const text=value=>String(value??'').trim();
const providerGovernor=new AdaptiveProviderGovernor();
export const providerConcurrencyStats=()=>providerGovernor.stats();
export const resetProviderConcurrency=()=>providerGovernor.reset();
export const MODEL_TIMEOUT_MS=45_000;
export const MODEL_CASCADE_MS=120_000;
export const RUNNER_TIMEOUT_MS=60_000;
export const SANDBOX_TIMEOUT_MS=330_000;
const RETRY_STATUS=new Set([408,425,429,500,502,503,504]);
const imagesOf=message=>Array.isArray(message?.images)?message.images.filter(i=>i?.data&&i?.mediaType):[];
export function estimateModelTokens(messages=[],{maxOutputTokens=4096}={}){const chars=(Array.isArray(messages)?messages:[]).reduce((s,m)=>s+(typeof m?.content==='string'?m.content.length:0),0);const images=(Array.isArray(messages)?messages:[]).reduce((s,m)=>s+imagesOf(m).length,0);return Math.min(500_000,Math.max(256,Math.ceil(chars/4)+images*1024+(Number(maxOutputTokens)>0?Math.floor(Number(maxOutputTokens)):4096)));}
function grokInput(messages){return (Array.isArray(messages)?messages:[]).filter(m=>m&&((typeof m.content==='string'&&m.content.trim())||imagesOf(m).length)).map(m=>{const images=imagesOf(m);const content=[...(text(m.content)?[{type:'input_text',text:String(m.content)}]:[]),...images.map(i=>({type:'input_image',image_url:'data:'+i.mediaType+';base64,'+i.data}))];return {role:m.role==='assistant'?'assistant':m.role==='system'?'system':'user',content};});}
function grokBuild(credential,model,messages,{webSearch=false,imageGeneration=false,imageAction='auto',maxOutputTokens=null,effort=null,json=false}={}){const tools=[];if(webSearch)tools.push({type:'web_search'});if(imageGeneration)tools.push({type:'image_generation',action:['generate','edit','auto'].includes(String(imageAction))?String(imageAction):'auto'});const body={model,input:grokInput(messages),...(effort?{reasoning:{effort:String(effort)}}:{}),...(maxOutputTokens?{max_output_tokens:maxOutputTokens}:{}),...(json?{text:{format:{type:'json_object'}}}:{}),...(tools.length?{tools}:{})};return {url:'https://api.x.ai/v1/responses',headers:{'content-type':'application/json',authorization:'Bearer '+credential},body};}
function grokParse(data){const output=Array.isArray(data.output)?data.output:[];const textParts=[];const citations=[];const images=[];for(const item of output){if(item?.type==='message'){for(const part of item.content??[]){if(typeof part?.text==='string')textParts.push(part.text);}}if(item?.type==='image_generation_call'&&typeof item.result==='string'&&item.result){images.push({mediaType:'image/jpeg',data:item.result,prompt:text(item.prompt),id:text(item.id)});}for(const src of item?.sources??[]){if(src?.url)citations.push({url:text(src.url),title:text(src.title)});}for(const src of item?.content??[]){if(src?.type==='url_citation'&&src.url)citations.push({url:text(src.url),title:text(src.title)});}}const usage=data.usage||null;const inputTokens=Number(usage?.input_tokens??usage?.prompt_tokens??0);const outputTokens=Number(usage?.output_tokens??usage?.completion_tokens??0);const reasoningTokens=Number(usage?.reasoning_tokens??0);const status=text(data.status).toLowerCase();return {text:textParts.join(''),citations:[...new Map(citations.map(x=>[x.url,x])).values()],images,incomplete:status==='incomplete'?'incomplete':null,paused:false,content:output,usage:usage?{inputTokens,outputTokens,...(reasoningTokens?{reasoningTokens}: {})}:null};}
export const MODEL_DEFAULTS=Object.freeze(Object.fromEntries(MODEL_CATALOG.map(i=>[i.provider,i.model])));
export const SUPPORTED_PROVIDERS=Object.freeze(['xai']);
async function readBounded(response,maxBytes){const raw=await response.text();if(Buffer.byteLength(raw,'utf8')>maxBytes){const e=new Error('Upstream response exceeded '+maxBytes+' bytes');e.code='ERESPONSETOOLARGE';throw e;}return raw;}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function withRetry(attempt,{retries=1,backoffMs=500,maxWaitMs=8000,sleep=wait}={}){let last;for(let i=0;i<=retries;i++){try{const r=await attempt();if(!r.retryable||i===retries)return r;last=r;}catch(e){if(i===retries||e.code==='ERESPONSETOOLARGE')throw e;last=e;}const delay=backoffMs*2**i*(0.8+Math.random()*0.4);if(delay>maxWaitMs)break;await sleep(delay);}if(last instanceof Error)throw last;return last;}
export function retryAfterMs(headers){const h=typeof headers?.get==='function'?headers.get('retry-after'):null;if(!h)return null;const n=Number(h);return Number.isFinite(n)?n*1000:null;}
const MODEL_ERRORS={'model-rate-limited':'Grok is rate-limited; nothing was recorded.','model-not-authorized':'The xAI service rejected the API key; nothing was recorded.','model-not-found':'Grok 4.7 is not available to this API key.','model-unavailable':'Grok is temporarily unavailable; nothing was recorded.','model-request-rejected':'Grok rejected the request; nothing was recorded.'};
export class ModelProviderError extends Error{constructor(provider,status,{retryAfterMs:after=null}={}){const code=status===429?'model-rate-limited':status===401||status===403?'model-not-authorized':status===404?'model-not-found':status===408||status>=500?'model-unavailable':'model-request-rejected';super(MODEL_ERRORS[code]);this.name='ModelProviderError';this.provider=provider;this.code=code;this.upstreamStatus=status;this.status=code==='model-request-rejected'?502:503;this.retryAfterSeconds=after?Math.ceil(after/1000):null;this.expose=code!=='model-request-rejected';}}
const EFFORT_ORDER=['low','medium','high','xhigh'];
export function effectiveEffort(requested,ceiling){const w=EFFORT_ORDER.indexOf(requested),c=EFFORT_ORDER.indexOf(ceiling);if(w<0)return c<0?'high':ceiling;return c<0?requested:EFFORT_ORDER[Math.min(w,c)];}
export async function callModel(messages,{config,fetchImpl=fetch,sleep=wait,webSearch=false,imageGeneration=false,imageAction='auto',timeoutMs=MODEL_TIMEOUT_MS,retries=1,maxOutputTokens=null,modelId=null,effort=null,json=false,allowBackup=()=>true,usageGate=null,usageSource='chat'}={}) { if(!config?.ai)return null;const selected=resolveConfiguredModel(config,modelId||config.ai.modelId||null);if(!selected)return null;const providerLimit=config.providerConcurrency??{};providerGovernor.configure('xai:grok-4.7',providerLimit);const credential=selected.apiKey;if(!credential)return null;let reservation=null;let admitted=Math.max(1,Math.floor(Number(maxOutputTokens)||4096));if(usageGate){try{reservation=await usageGate.reserve({estimatedTokens:estimateModelTokens(messages,{maxOutputTokens:admitted}),usageSource});if(reservation?.estimatedTokens)admitted=Math.max(1,Math.min(admitted,Number(reservation.estimatedTokens)));}catch(e){if(e?.code==='usage-limit-reached')return {text:'',citations:[],usage:null,provider:'xai',model:'grok-4.7',incomplete:'usage-limit',status:'usage-limit-reached',message:e.message};throw e;}}
const modelKey='xai:grok-4.7';const doRequest=async search=>providerGovernor.run(modelKey,()=>withRetry(async()=>{const req=grokBuild(credential,'grok-4.7',messages,{webSearch:search,imageGeneration,imageAction,maxOutputTokens:admitted,effort:effectiveEffort(effort,config.ai.effort),json});const response=await fetchImpl(req.url,{method:'POST',headers:req.headers,body:JSON.stringify(req.body),signal:AbortSignal.timeout(timeoutMs)});const raw=await readBounded(response,config.limits.responseBytes);return {retryable:!response.ok&&RETRY_STATUS.has(response.status),status:response.status,raw,retryAfterMs:retryAfterMs(response.headers)};},{sleep,retries,backoffMs:500,maxWaitMs:8000}));
let outcome;let searchUnavailable=false;try{outcome=await doRequest(webSearch);}catch(e){if(webSearch&&(e instanceof ModelProviderError)&&(e.code==='model-request-rejected'||e.code==='model-rate-limited')){outcome=await doRequest(false);searchUnavailable=true;}else{if(reservation)await usageGate?.release(reservation).catch(()=>{});if(e?.name==='TimeoutError'||e?.name==='AbortError'||e instanceof TypeError)throw new ModelProviderError('xai',408);throw e;}}
if(outcome.status<200||outcome.status>=300){if(reservation)await usageGate?.release(reservation).catch(()=>{});throw new ModelProviderError('xai',outcome.status,{retryAfterMs:outcome.retryAfterMs});}
let segment;try{segment=grokParse(JSON.parse(outcome.raw));}catch{segment={text:'',citations:[],usage:null,incomplete:'invalid-provider-response'};}
if(reservation){const u=segment.usage??{};try{await usageGate.settle({reservationId:reservation.id,source:usageSource,provider:'xai',model:'grok-4.7',inputTokens:u.inputTokens||0,outputTokens:u.outputTokens||0,conversationId:null});reservation=null;}catch(e){await usageGate.release(reservation).catch(()=>{});throw e;}}
return {text:segment.text,citations:segment.citations,images:segment.images ?? [],content:segment.content ?? [],usage:segment.usage,provider:'xai',model:'grok-4.7',incomplete:segment.incomplete,usageRecorded:Boolean(!reservation),...(searchUnavailable?{webSearchUnavailable:true}: {})};}
export async function callRunner(url, payload, { config, fetchImpl = fetch, sleep = wait, timeoutMs = RUNNER_TIMEOUT_MS, token = null } = {}) {
  const endpoint = text(url);
  if (!endpoint) {
    return {
      configured: false,
      executed: false,
      status: 'not-configured',
      message: 'No execution runner is configured; nothing was executed.'
    };
  }

  const headers = { 'content-type': 'application/json' };
  const runnerToken = text(token);
  if (runnerToken) headers.authorization = `Bearer ${runnerToken}`;
  // The execution ID lets a runner deduplicate retries of the same request,
  // and binds the runner's receipt to exactly this request.
  const executionId = text(payload?.executionId);
  if (executionId) headers['x-kindgleam-execution-id'] = executionId;

  try {
    const outcome = await withRetry(async () => {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const raw = await readBounded(response, config.limits.responseBytes);
      return { retryable: RETRY_STATUS.has(response.status), status: response.status, raw };
    }, {
      sleep,
      // Runner calls can have side effects. Never retry an ambiguous POST here:
      // a timeout or dropped connection does not prove the runner did nothing.
      retries: 0
    });

    let result;
    try {
      result = JSON.parse(outcome.raw);
    } catch {
      result = { output: outcome.raw };
    }

    if (outcome.status < 200 || outcome.status >= 300) {
      return { configured: true, executed: false, status: 'failed', code: outcome.status, result };
    }
    if (result?.executed === false) {
      // An explicit refusal is an honest answer: pass its reason through.
      return {
        configured: true,
        executed: false,
        status: text(result.status) || 'not-executed',
        message: text(result.message) || 'The runner did not execute the task.',
        result
      };
    }
    if (result?.executed !== true) {
      return {
        configured: true,
        executed: false,
        status: 'invalid-runner-receipt',
        message: 'Runner returned success without an explicit executed=true receipt.'
      };
    }
    if (executionId && text(result.executionId) && text(result.executionId) !== executionId) {
      return {
        configured: true,
        executed: false,
        status: 'invalid-runner-receipt',
        message: 'Runner returned a receipt for a different execution request.'
      };
    }
    const runnerStatus = text(result.status) || 'completed';
    return {
      configured: true,
      executed: true,
      status: runnerStatus,
      result,
      executionReceipt: {
        executed: true,
        status: runnerStatus,
        runner: endpoint,
        executionTarget: text(payload.executionTarget),
        ...(executionId ? { executionId } : {}),
        managed: true,
        result
      }
    };
  } catch (error) {
    // A runner we could not reach did not run anything. Say exactly that.
    return {
      configured: true,
      executed: false,
      status: 'unreachable',
      message: error.name === 'TimeoutError' ? 'Runner timed out' : 'Runner could not be reached'
    };
  }
}
