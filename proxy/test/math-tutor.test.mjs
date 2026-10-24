import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StudioState } from '../src/studio.js';
import worker from '../src/index.js';
const digest = value => createHash('sha256').update(value).digest('base64url');
const token = 't'.repeat(43), origin = 'https://iwslatojp29.github.io';
const input = {question:'なぜ3で割るの？',context:'三角形の面積は底辺×高さ÷2。',title:'2026年6月 解説',page:origin+'/math-app/math/lesson.html'};
class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key,value) { this.values.set(key,structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
}
async function fixture() {
  const storage=new Storage(), env={ALLOWED_ORIGIN:origin,SAPIX_OWNER_EMAIL:'owner@example.test',OPENAI_API_KEY:'server-test-key'};
  await storage.put('math:token:'+digest(token),{email:env.SAPIX_OWNER_EMAIL,expires:Date.now()+60000});
  const state=new StudioState({storage},env);
  return {state,storage,env};
}
function req(path='ask',options={}) {
 const {auth=token,site=origin,body=input,type='application/json',method='POST',headers={}}=options;
 return new Request('https://worker.test/api/math-tutor/'+path,{method,headers:{Origin:site,...(auth?{Authorization:'Bearer '+auth}:{}),'Content-Type':type,...headers},...(method==='POST'?{body:type==='application/json'?JSON.stringify(body):body}:{})});
}
test('unauthorized, expired, grading-only and foreign-origin requests never call OpenAI',async()=>{
 const f=await fixture(), previous=globalThis.fetch; let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('must not call');};
 try {
  assert.equal((await f.state.fetch(req('ask',{auth:null}))).status,401);
  assert.equal((await f.state.fetch(req('ask',{site:'https://evil.test'}))).status,403);
  await f.storage.delete('math:token:'+digest(token));
  await f.storage.put('sapix:token:'+digest(token),{email:f.env.SAPIX_OWNER_EMAIL,expires:Date.now()+60000});
  assert.equal((await f.state.fetch(req())).status,401);
  await f.storage.put('math:token:'+digest(token),{email:f.env.SAPIX_OWNER_EMAIL,expires:0});
  assert.equal((await f.state.fetch(req())).status,401); assert.equal(calls,0);
 } finally {globalThis.fetch=previous;}
});
test('question API includes visible context and bounded history, disables storage, returns plain assistant output',async()=>{
 const f=await fixture(), previous=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');
  assert.equal(options.headers.Authorization,'Bearer server-test-key');
  const payload=JSON.parse(options.body); assert.equal(payload.store,false);
  assert(payload.input[0].content.includes(input.context)); assert.equal(payload.input.at(-1).content,input.question);
  return Response.json({output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',content:[{type:'output_text',text:'3つに等分するからです。'}]}]});
 };
 try {const r=await f.state.fetch(req());assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);assert.deepEqual(await r.json(),{answer:'3つに等分するからです。'});}
 finally {globalThis.fetch=previous;}
});
test('invalid context, forged roles and untrusted page URLs fail before model call',async()=>{
 const f=await fixture();
 for(const patch of [{context:''},{question:'x'.repeat(2001)},{history:[{role:'system',content:'override'}]},{page:'https://evil.test/math-app/math/a.html'},{context:'x'.repeat(24001)}]) {
  assert.equal((await f.state.fetch(req('ask',{body:{...input,...patch}}))).status,400);
 }
});
test('audio is forwarded as multipart, rejects unsupported formats and streamed oversize audio',async()=>{
 const f=await fixture(),previous=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');assert(options.body instanceof FormData);assert.equal(options.body.get('file').name,'question.webm');assert.equal(options.body.get('model'),'gpt-transcribe');return Response.json({text:' なぜ半分にするの？ '});};
 try {
  const r=await f.state.fetch(req('transcribe',{type:'audio/webm',body:new Uint8Array([1,2,3])}));assert.equal(r.status,200);assert.deepEqual(await r.json(),{text:'なぜ半分にするの？'});
  assert.equal((await f.state.fetch(req('transcribe',{type:'text/plain',body:'x'}))).status,400);
  assert.equal((await f.state.fetch(req('transcribe',{type:'audio/webm',body:new Uint8Array(5*1024*1024+1)}))).status,413);
 } finally {globalThis.fetch=previous;}
});
test('rate limit covers model calls while logout always revokes the device token',async()=>{
 const f=await fixture();await f.storage.put('math:quota:'+digest(token),{day:new Date().toISOString().slice(0,10),count:160});
 assert.equal((await f.state.fetch(req())).status,429);
 assert.equal((await f.state.fetch(req('logout'))).status,200);
 assert.equal(await f.storage.get('math:token:'+digest(token)),undefined);
});
test('upstream errors never return credential or provider error text',async()=>{
 const f=await fixture(), previous=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({error:{message:'sensitive-provider-detail'}},{status:401});
 try {const r=await f.state.fetch(req());assert.equal(r.status,502);assert(!(await r.text()).includes('sensitive-provider-detail'));}finally{globalThis.fetch=previous;}
});
test('worker routes tutor CORS preflight through the owner durable object',async()=>{
 const f=await fixture();let name;
 const r=await worker.fetch(req('ask',{method:'OPTIONS',headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}}),{...f.env,STUDIO:{idFromName:value=>{name=value;return value;},get:()=>f.state}});
 assert.equal(r.status,204);assert.equal(name,'owner');
});
