const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash, webcrypto} = require('node:crypto');
const Sync = require('../sapix/record-sync.js');

// Separate browser stores, the real client, and the real Durable Object routes.
// Only platform persistence and outbound transport are replaced. No real secrets.
class Store {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
class DurableStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return Array.isArray(key) ? new Map(key.filter(k => this.values.has(k)).map(k => [k, structuredClone(this.values.get(k))])) : structuredClone(this.values.get(key)); }
  async put(key, value) { if (typeof key === 'object') { for (const [k,v] of Object.entries(key)) this.values.set(k, structuredClone(v)); } else this.values.set(key, structuredClone(value)); }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.values.delete(k); }
  async list({prefix = '', limit = Infinity, startAfter = ''} = {}) { return new Map([...this.values].sort(([a], [b]) => a.localeCompare(b)).filter(([k]) => k.startsWith(prefix) && k > startAfter).slice(0,limit).map(([k,v]) => [k,structuredClone(v)])); }
  async transaction(action) { const previous = structuredClone(this.values); try { return await action(this); } catch(error) { this.values = previous; throw error; } }
}
async function setup() {
  const {StudioState,seal} = await import('../proxy/src/studio.js');
  const env = {GOOGLE_CLIENT_ID:'test-client', GOOGLE_CLIENT_SECRET:'test-client-secret', STUDIO_SECRET:'integration-test-secret-only', STUDIO_OWNER_EMAIL:'owner@example.test', SAPIX_OWNER_EMAIL:'owner@example.test', STUDIO_ORIGIN:'https://math-app-proxy.iwslatojp29.workers.dev', ALLOWED_ORIGIN:'https://iwslatojp29.github.io'};
  const storage = new DurableStorage(), worker = new StudioState({storage},env);
  const cookie = await seal({email:env.STUDIO_OWNER_EMAIL, csrf:'test', expires:Date.now()+60000},env.STUDIO_SECRET,'session');
  async function transport(input, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('Origin',env.ALLOWED_ORIGIN);
    return worker.fetch(new Request(input,{...init,headers}));
  }
  async function credential() {
    const verifier = 'integration-verifier-' + webcrypto.randomUUID() + '-long-enough';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = 'integration-state-' + webcrypto.randomUUID();
    const start = await worker.fetch(new Request(env.STUDIO_ORIGIN + '/api/sapix/auth/start?' + new URLSearchParams({challenge,state}),{headers:{Cookie:'__Host-studio='+cookie}}));
    assert.equal(start.status,302);
    const hash = new URLSearchParams(new URL(start.headers.get('Location')).hash.slice(1));
    assert.equal(hash.get('sapix_state'),state);
    const response = await transport(env.STUDIO_ORIGIN + '/api/sapix/auth/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:hash.get('sapix_code'),verifier})});
    assert.equal(response.status,200);
    return response.json();
  }
  async function device({store = new Store(), fetch = transport} = {}) {
    store.setItem(Sync.authTokenKey,JSON.stringify(await credential()));
    const messages = [];
    const client = Sync.create({storage:store,sessionStorage:new Store(),fetch,crypto:webcrypto,now:Date.now,setTimeout:()=>1,clearTimeout:()=>{},onStatus:s=>messages.push(s)});
    client.load();
    return {client,store,messages};
  }
  return {worker,storage,env,transport,device,navigateOwner:url=>worker.fetch(new Request(url,{headers:{Cookie:'__Host-studio='+cookie}}))};
}
const row = r => ({d:'2026-09-26',r,s:12});
const grades = client => Object.values(client.getRecords()).flat().map(r => r.r).sort();

test('two devices merge independent attempts, propagate correction, and never resurrect deletion', async () => {
  const {device} = await setup();
  const a = await device(), b = await device();
  const aid = a.client.put('p1',row('o'));
  const bid = b.client.put('p1',row('x'));
  await Promise.all([a.client.sync(),b.client.sync()]);
  await a.client.sync(); await b.client.sync();
  assert.deepEqual(grades(a.client),['o','x']);
  assert.deepEqual(grades(b.client),['o','x']);
  a.client.put('p1',row('t'),aid);
  await a.client.sync(); await b.client.sync();
  assert.deepEqual(grades(b.client),['t','x']);
  // B edits an attempt while offline; A removes it before B's delayed send.
  b.client.put('p1',row('o'),bid);
  a.client.remove([bid]); await a.client.sync();
  await b.client.sync(); await a.client.sync();
  assert.deepEqual(grades(a.client),['t']);
  assert.deepEqual(grades(b.client),['t']);
  a.client.remove([aid]); await a.client.sync(); await b.client.sync();
  assert.deepEqual(grades(b.client),[]);
});

test('lost response and fresh browser load replay one attempt exactly once', async () => {
  const {device,transport} = await setup();
  let drop = true;
  const a = await device({fetch:async (url,init) => {
    const response = await transport(url,init);
    if (drop && init?.method === 'POST' && new URL(url).pathname === '/api/sapix/records') { drop = false; throw Error('connection closed after commit'); }
    return response;
  }});
  a.client.put('p1',row('o'));
  await a.client.sync().catch(()=>{});
  assert.ok(a.client.getState().outbox.length);
  const reloaded = await device({store:a.store});
  await reloaded.client.sync();
  const b = await device(); await b.client.sync();
  assert.deepEqual(grades(b.client),['o']);
  assert.equal(reloaded.client.getState().outbox.length,0);
});

test('same legacy backup on two devices deduplicates without dropping repeated attempts', async () => {
  const {device} = await setup();
  const stores = [new Store(),new Store()];
  for (const store of stores) store.setItem('sapix_sansu_records_v1',JSON.stringify({p1:[row('o'),row('o'),row('t')]}));
  const a = await device({store:stores[0]}), b = await device({store:stores[1]});
  await a.client.sync(); await b.client.sync(); await a.client.sync();
  assert.deepEqual(grades(a.client),['o','o','t']);
  assert.deepEqual(grades(b.client),['o','o','t']);
});

test('revoking one device does not sign out another or erase either record cache', async () => {
  const {device} = await setup();
  const a = await device(), b = await device();
  a.client.put('p1',row('x')); await a.client.sync(); await b.client.sync();
  await a.client.disconnect();
  assert.deepEqual(grades(a.client),['x']);
  b.client.put('p2',row('o')); await b.client.sync();
  assert.deepEqual(grades(b.client),['o','x']);
});

test('real client PKCE redirect and exchange complete owner login and upload pre-existing grades', async () => {
  const {navigateOwner,transport,device} = await setup();
  const store = new Store(), session = new Store();
  store.setItem('sapix_sansu_records_v1',JSON.stringify({p1:[row('t')]}));
  let destination = '', removedFragment = false;
  const location = {pathname:'/math-app/sapix/sapix_sansu_trainer.html',search:'',hash:'',assign:url=>{destination=url;}};
  const client = Sync.create({storage:store,sessionStorage:session,fetch:transport,crypto:webcrypto,now:Date.now,setTimeout:()=>1,clearTimeout:()=>{},location,history:{replaceState(){removedFragment=true;location.hash='';}}});
  client.load(); await client.connect();
  const redirect = await navigateOwner(destination);
  assert.equal(redirect.status,302);
  location.hash = new URL(redirect.headers.get('Location')).hash;
  assert.equal(await client.finishAuth(),true);
  assert.equal(removedFragment,true);
  assert.equal(client.getStatus().connected,true);
  assert.equal(client.getStatus().synced,true);
  assert.equal(client.getState().outbox.length,0);
  const second = await device(); await second.client.sync();
  assert.deepEqual(grades(second.client),['t']);
});
