import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {storeHubSession,importHubKey,storedHubProfile,hubCredentialKind} from '../src/state/hub_credentials.js';
import {hubTasksScope} from '../src/state/hub_tasks.js';
import {loadHubConfig} from '../src/client/hub.js';
const root=fileURLToPath(new URL('..',import.meta.url));
test('explicit imported key preserves OAuth but selects one consistent HTTP/task identity',()=>{
 const state=mkdtempSync(join(tmpdir(),'n64-key-'));
 try{
  const env={ITPAY_STATE_DIR:state,ITPAY_HUB_URL:'http://localhost:18090',ITPAY_HUB_OAUTH_CLIENT:'fixture'};
  storeHubSession('synthetic-oauth',undefined,3600,'buyer-a',env.ITPAY_HUB_URL,env,'consumer-a');
  const old=hubTasksScope(env);
  importHubKey('itk_synthetic_key_a',env.ITPAY_HUB_URL,env);
  assert.equal(storedHubProfile(env)?.access_token,'synthetic-oauth');
  assert.equal(hubCredentialKind(env),'api_key');
  assert.equal(loadHubConfig(env).bearerToken,undefined);
  assert.notEqual(hubTasksScope(env),old);
  const keyScope=hubTasksScope(env);
  storeHubSession('synthetic-oauth-b',undefined,3600,'buyer-b',env.ITPAY_HUB_URL,env,'consumer-b');
  assert.equal(storedHubProfile(env)?.api_key,'itk_synthetic_key_a');
  assert.equal(hubCredentialKind(env),'oauth');
  assert.equal(hubTasksScope({...env,ITPAY_HUB_KEY:'itk_synthetic_key_a'}),keyScope);
  assert.equal(loadHubConfig({...env,ITPAY_HUB_KEY:'itk_synthetic_key_a'}).bearerToken,undefined);
  assert.throws(()=>loadHubConfig({...env,ITPAY_HUB_KEY:'itk_synthetic_key_a',ITPAY_HUB_TOKEN:'other'}),/credential_conflict/);
 }finally{rmSync(state,{recursive:true,force:true})}
});
test('profile key reads scoped usage without OAuth and rejected key cannot fall back',async()=>{
 const state=mkdtempSync(join(tmpdir(),'n64-wallet-'));let writes=0,oauth=0;
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method!=='GET')writes++;
  if(req.headers.authorization){oauth++;res.writeHead(401);res.end('{"error":{"code":"unauthenticated","message":"not this identity"}}');return;}
  if(req.headers['x-itpay-key']==='itk_rejected'){res.writeHead(401);res.end('{"error":{"code":"unauthenticated","message":"key rejected"}}');return;}
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'issuer|buyer_AAAAAA',key_id:'key-a',account_hint:'…AAAAAA',consumer_id:''}));return;}
  if(req.url==='/v1/me/wallet'){res.end(JSON.stringify({available:{amount_atoms:'9990000',currency:'CNY',scale:6},held:{amount_atoms:'0',currency:'CNY',scale:6},topup_url:'https://official.example/me/wallet',owner_billing_url:'https://official.example/me/usage?wallet=1'}));return;}
  if(req.url==='/v1/me/usage'){res.end(JSON.stringify({gross_atoms:'10000',net_atoms:'10000',consumer_key:'key-a',by_operation:[]}));return;}
  if(req.url==='/v1/me/wallet/transactions'){res.end(JSON.stringify({items:[{kind:'credit_funding',amount:{amount_atoms:'500000000'}},{kind:'charge',amount:{amount_atoms:'10000'}}],has_more:true,limit:100}));return;}
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
 const base='http://127.0.0.1:'+a.port;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_'))),ITPAY_HUB_URL:base,ITPAY_STATE_DIR:state,ITPAY_HUB_KEY:'itk_synthetic_key_a'};
 async function cli(args:string[],overrides:Record<string,string>={}){
  return new Promise<{code:number|null,value:any,output:string}>(resolve=>{
   const p=spawn(process.execPath,['--import','tsx','src/main.ts',...args,'--json'],{cwd:root,env:{...env,...overrides}});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('close',code=>{assert.ok(!out.includes('itk_synthetic_key_a'));resolve({code,value:JSON.parse(out),output:out+err})});
  });
 }
 try{
  const usage=await cli(['api','wallet','--usage']);assert.equal(usage.code,0);assert.equal(usage.value.result.scope,'api_key');assert.equal(usage.value.result.gross_atoms,'10000');
  const tx=await cli(['api','wallet','--transactions']);assert.equal(tx.value.result.items.length,1);assert.equal(tx.value.result.truncated,true);assert.equal(tx.value.result.owner_billing_url,'https://official.example/me/usage?wallet=1');
  const failed=await cli(['api','wallet'],{ITPAY_HUB_KEY:'itk_rejected'});assert.equal(failed.code,1);assert.equal(failed.value.next,null);assert.match(failed.value.instruction,/密钥页/);assert.doesNotMatch(failed.output,/api connect/);
  const agent=await cli(['--agent-type','codex-desktop','agent','--surface','api','--task','free data','--wait','0'],{ITPAY_AGENT_HOME:join(state,'agent')});assert.equal(agent.value.status,'connected');assert.equal(agent.value.result.identity.credential_kind,'api_key');assert.equal(writes,0);assert.equal(oauth,0);
  const imported=await new Promise<string>(resolve=>{const p=spawn(process.execPath,['--import','tsx','src/main.ts','api','credentials','import','--json'],{cwd:root,env:{...env,ITPAY_HUB_KEY:''}});let out='';p.stdout.on('data',x=>out+=x);p.on('close',()=>resolve(out));p.stdin.end('itk_synthetic_key_a');});
  assert.doesNotMatch(imported,/itk_synthetic_key_a/);
  const selected=await cli(['--agent-type','muse','agent','--surface','api','--task','free data','--wait','0'],{ITPAY_AGENT_HOME:join(state,'imported-agent'),ITPAY_HUB_KEY:''});assert.equal(selected.value.status,'connected',JSON.stringify(selected.value));assert.equal(selected.value.result.identity.credential_kind,'api_key');assert.equal(oauth,0);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(state,{recursive:true,force:true})}
});
