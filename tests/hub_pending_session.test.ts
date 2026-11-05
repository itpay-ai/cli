import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,readdirSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectedHubToken,hubCredentialsPath,storeHubSession,storedHubProfile,storedHubToken} from '../src/state/hub_credentials.js';
import {HubClient,loadHubConfig} from '../src/client/hub.js';

async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'itpay-pending-session-'));
 let mode='ok',rotations=0,probes=0,business=0,base='';
 let probeGate: (()=>Promise<void>)|undefined;
 const refreshTokens:string[]=[];
 const admissions:{body:unknown;key:string|undefined;resource:string|undefined}[]=[];
 const sdkRequests:{method:string;path:string;resource:string|undefined}[]=[];
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/oauth2/token'){
   let body='';for await(const b of req)body+=b;const form=new URLSearchParams(body);
   assert.equal(form.get('resource'),base);assert.equal(form.get('client_id'),'fixture-cli');refreshTokens.push(form.get('refresh_token')!);rotations++;
   if(mode==='issuer503'){res.writeHead(503);res.end('{}');return}
   if(mode==='invalid-grant'){res.writeHead(400);res.end(JSON.stringify({error:'invalid_grant'}));return}
   res.end(JSON.stringify({access_token:'synthetic-new-'+rotations,refresh_token:'synthetic-rt-'+rotations,expires_in:300,token_type:'Bearer'}));return;
  }
  if(req.url==='/v1/me'){
   probes++;if(probeGate)await probeGate();assert.equal(req.headers['x-itpay-oauth-resource'],base,'explicit resource required, never default canonical audience');
   if(mode==='503'||mode==='401'||mode==='403'){res.writeHead(Number(mode));res.end('{}');return}
   if(mode==='malformed'){res.end('not-json');return}
   if(mode==='disconnect'){req.socket.destroy();return}
   res.end(JSON.stringify({buyer_id:mode==='wrong-buyer'?'other':'buyer-original',...(mode==='missing-consumer'?{}:{consumer_id:mode==='wrong-consumer'?'other':'consumer-original'})}));return;
  }
  if(req.url==='/v1/operations/op-original/runs'){
   let raw='';for await(const chunk of req)raw+=chunk;
   admissions.push({body:JSON.parse(raw),key:req.headers['idempotency-key'] as string|undefined,resource:req.headers['x-itpay-oauth-resource'] as string|undefined});
   if(req.headers['x-itpay-oauth-resource']!==base){res.writeHead(401);res.end(JSON.stringify({error:{code:'unauthenticated',message:'synthetic exact resource required'}}));return}
   res.end(JSON.stringify({run_id:'run-original',operation_id:'op-original',publication_id:'pub-original',execution_state:'succeeded',settlement_state:'captured'}));return;
  }
  if(req.url?.startsWith('/v1/runs/')){
   business++;sdkRequests.push({method:req.method!,path:req.url,resource:req.headers['x-itpay-oauth-resource'] as string|undefined});
   if(req.headers['x-itpay-oauth-resource']!==base || (mode==='reject-old' && req.headers.authorization==='Bearer synthetic-old')){
    res.writeHead(401);res.end(JSON.stringify({error:{code:'unauthenticated',message:'synthetic exact resource and active token required'}}));return;
   }
   res.end(JSON.stringify({run_id:'run-original',execution_state:'succeeded'}));return;
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert.ok(addr&&typeof addr!=='string');base='http://127.0.0.1:'+addr.port;
 const env={...process.env,HOME:dir,ITPAY_STATE_DIR:dir,ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base,ITPAY_HUB_OAUTH_CLIENT:'fixture-cli',ITPAY_HUB_TOKEN:'',ITPAY_HUB_KEY:''};
 storeHubSession('synthetic-old','synthetic-rt-old',-1,'buyer-original',base,env,'consumer-original');
 return{env,dir,sdkRequests,admissions,setProbeGate:(gate:()=>Promise<void>)=>probeGate=gate,setMode:(s:string)=>mode=s,counts:()=>({rotations,probes,business}),refreshTokens,edit:(fields:Record<string,unknown>)=>{const path=hubCredentialsPath(env);const file=JSON.parse(readFileSync(path,'utf8'));Object.assign(file.profiles.default,fields);writeFileSync(path,JSON.stringify(file),{mode:0o600})},close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true})}};
}

function child(env:NodeJS.ProcessEnv,code:string){
 const proc=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{env,stdio:['ignore','pipe','pipe']});let out='',err='';proc.stdout.on('data',b=>out+=b);proc.stderr.on('data',b=>err+=b);
 return new Promise<{exit:number|null;out:string;err:string}>((resolve,reject)=>{proc.on('error',reject);proc.on('close',exit=>resolve({exit,out,err}))});
}
const moduleURL=new URL('../src/state/hub_credentials.ts',import.meta.url).href;

test('separate processes share one exact-resource refresh and persist verified session 0600',async()=>{
 const f=await fixture();try{
  const code=`import {connectedHubToken} from ${JSON.stringify(moduleURL)};await connectedHubToken();console.log('verified');`;
  const results=await Promise.all(Array.from({length:4},()=>child(f.env,code)));
  for(const r of results){assert.equal(r.exit,0,r.err);assert.equal(r.out.trim(),'verified')}
  assert.deepEqual(f.counts(),{rotations:1,probes:1,business:0});assert.equal(statSync(hubCredentialsPath(f.env)).mode&0o777,0o600);assert.equal(storedHubProfile(f.env)?.identity_verification_pending,undefined);
 }finally{await f.close()}
});

for(const mode of ['503','malformed','disconnect'])test('pending survives '+mode+' and original reader recovers without consuming old rotation',async()=>{
 const f=await fixture();try{
  f.setMode(mode);await assert.rejects(connectedHubToken(f.env),/connection_verification_pending:/);
  assert.equal(storedHubToken(f.env),undefined);assert.ok(!loadHubConfig(f.env).apiKey);
  const pending=storedHubProfile(f.env)!;assert.equal(pending.refresh_token,'synthetic-rt-1');assert.equal(pending.identity_verification_pending,true);assert.equal(pending.subject,'buyer-original');assert.equal(pending.consumer_id,'consumer-original');
  const expiry=pending.expires_at;f.setMode('ok');const cli=new HubClient(loadHubConfig(f.env));const run=await cli.runStatus('run-original');assert.equal(run.run_id,'run-original');assert.deepEqual(f.counts(),{rotations:1,probes:2,business:1});assert.equal(storedHubProfile(f.env)?.expires_at,expiry,'verification must not extend the issuer TTL');
 }finally{await f.close()}
});

for(const mode of ['401','403','wrong-buyer','wrong-consumer','missing-consumer'])test(mode+' never promotes pending or changes the original owner',async()=>{
 const f=await fixture();try{
  f.setMode(mode);await assert.rejects(connectedHubToken(f.env),mode==='missing-consumer'?/connection_verification_pending:/:/authorization_required:/);
  assert.equal(storedHubToken(f.env),undefined);assert.equal(storedHubProfile(f.env)?.identity_verification_pending,true);assert.equal(storedHubProfile(f.env)?.subject,'buyer-original');assert.equal(storedHubProfile(f.env)?.consumer_id,'consumer-original');assert.equal(f.counts().business,0);
 }finally{await f.close()}
});

test('expired pending rotates using its saved refresh token; no replay of the consumed token',async()=>{
 const f=await fixture();try{
  f.setMode('503');await assert.rejects(connectedHubToken(f.env));f.edit({expires_at:'2000-01-01T00:00:00Z'});f.setMode('ok');assert.equal(await connectedHubToken(f.env),'synthetic-new-2');assert.deepEqual(f.refreshTokens,['synthetic-rt-old','synthetic-rt-1']);
 }finally{await f.close()}
});

test('fresh or pending profiles reject changed resource, issuer and client before any request',async()=>{
 const f=await fixture();try{
  storeHubSession('fresh','rt',300,'buyer-original',f.env.ITPAY_HUB_URL,f.env,'consumer-original');
  await assert.rejects(connectedHubToken({...f.env,ITPAY_HUB_OAUTH_ISSUER:'http://127.0.0.1:1'}),/configuration changed/);
  await assert.rejects(connectedHubToken({...f.env,ITPAY_HUB_OAUTH_CLIENT:'other'}),/configuration changed/);
  f.edit({base_url:'https://other.example',identity_verification_pending:true});await assert.rejects(connectedHubToken(f.env),/configuration changed/);assert.deepEqual(f.counts(),{rotations:0,probes:0,business:0});
 }finally{await f.close()}
});

test('legacy verified profiles retain fresh-token reuse; new connect clears old pending under the same lock',async()=>{
 const f=await fixture();try{
  storeHubSession('legacy','rt',300,'buyer-original',f.env.ITPAY_HUB_URL,f.env,'consumer-original');assert.equal(await connectedHubToken(f.env),'legacy');assert.equal(f.counts().rotations,0);
  f.edit({expires_at:'2000-01-01T00:00:00Z',refresh_after:'2000-01-01T00:00:00Z'});f.setMode('503');await assert.rejects(connectedHubToken(f.env));
  // A new process commits a completed normal connect, without a browser wait inside the lock.
  const r=await child(f.env,`import {storeHubSession} from ${JSON.stringify(moduleURL)};storeHubSession('synthetic-connected','synthetic-connect-rt',300,'buyer-original',process.env.ITPAY_HUB_URL,process.env,'consumer-original');`);assert.equal(r.exit,0,r.err);assert.equal(await connectedHubToken(f.env),'synthetic-connected');assert.equal(storedHubProfile(f.env)?.identity_verification_pending,undefined);
 }finally{await f.close()}
});

test('rotation persistence failure stops before who/business, preserves original bytes and cleans private temporary file',async t=>{
 const f=await fixture();const path=hubCredentialsPath(f.env),before=readFileSync(path);try{
  const mocked=t.mock.method(fs,'renameSync',()=>{throw new Error('synthetic disk failure')});syncBuiltinESMExports();
  await assert.rejects(connectedHubToken(f.env),/credential_persistence_failed:/);assert.deepEqual(readFileSync(path),before);assert.deepEqual(f.counts(),{rotations:1,probes:0,business:0});assert.equal(readdirSync(f.dir).some(x=>x.endsWith('.tmp')),false);mocked.mock.restore();syncBuiltinESMExports();
 }finally{t.mock.restoreAll();syncBuiltinESMExports();await f.close()}
});

test('promotion persistence failure retains pending and a later verification uses the saved rotation',async t=>{
 const f=await fixture();try{
  f.setMode('503');await assert.rejects(connectedHubToken(f.env));const pending=readFileSync(hubCredentialsPath(f.env));f.setMode('ok');
  const mocked=t.mock.method(fs,'renameSync',()=>{throw new Error('synthetic disk failure')});syncBuiltinESMExports();
  await assert.rejects(connectedHubToken(f.env),/credential_persistence_failed:/);assert.deepEqual(readFileSync(hubCredentialsPath(f.env)),pending);assert.equal(storedHubToken(f.env),undefined);mocked.mock.restore();syncBuiltinESMExports();assert.equal(await connectedHubToken(f.env),'synthetic-new-1');assert.equal(f.counts().rotations,1);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();await f.close()}
});

for(const mode of ['503','invalid-grant'])test('CLI distinguishes '+mode+' from consent and preserves original run reader',async()=>{
 const f=await fixture();try{
  f.setMode(mode);
  // Exercise the real command registration with the exact original reference.
  const p=spawn(process.execPath,['--import','tsx','src/main.ts','api','run-status','run-original','--json'],{env:f.env,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const exit=await new Promise<number|null>(resolve=>p.on('close',resolve));assert.equal(exit,1,err);
  const envelope=JSON.parse(out);assert.equal(envelope.error.code,mode==='503'?'connection_verification_pending':'authorization_required');if(mode==='503')assert.equal(envelope.next,null);else assert.match(envelope.next.command,/api connect/);assert.ok(!out.includes('synthetic-'));assert.equal(f.counts().business,0);
 }finally{await f.close()}
});


test('persisted pending is recovered by another process without another token exchange',async()=>{
 const f=await fixture();try{
  f.setMode('503');const code=`import {connectedHubToken} from ${JSON.stringify(moduleURL)};try{await connectedHubToken();console.log('verified')}catch{process.exitCode=1}`;
  assert.equal((await child(f.env,code)).exit,1);assert.equal(storedHubProfile(f.env)?.identity_verification_pending,true);
  f.setMode('ok');const result=await child(f.env,code);assert.equal(result.exit,0,result.err);assert.equal(result.out.trim(),'verified');assert.equal(f.counts().rotations,1);
 }finally{await f.close()}
});

test('a concurrent completed connect waits for refresh lock and cannot be overwritten by its old snapshot',async()=>{
 const f=await fixture();let release!:()=>void;let reached!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);const ready=new Promise<void>(resolve=>reached=resolve);
 f.setProbeGate(async()=>{reached();await gate});
 try{
  const refresh=connectedHubToken(f.env);await ready;
  const code=`import {storeHubSession} from ${JSON.stringify(moduleURL)};console.log('committing');storeHubSession('new-connect','connect-rt',300,'buyer-original',process.env.ITPAY_HUB_URL,process.env,'consumer-original');`;
  const proc=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{env:f.env,stdio:['ignore','pipe','pipe']});let err='';proc.stderr.on('data',b=>err+=b);
  const exit=new Promise<number|null>(resolve=>proc.on('close',resolve));await new Promise<void>(resolve=>proc.stdout.once('data',()=>resolve()));release();await refresh;assert.equal(await exit,0,err);
  assert.equal(storedHubProfile(f.env)?.access_token,'new-connect');assert.equal(await connectedHubToken(f.env),'new-connect');assert.equal(f.counts().rotations,1);
 }finally{release();await f.close()}
});

test('temporary verification failure preserves the persisted logical request and offers only its scoped reader',async()=>{
 const f=await fixture();try{
  f.setMode('503');
  const proc=spawn(process.execPath,['--import','tsx','src/main.ts','api','run','op-original','--publication','pub-original','--input','{}','--request-id','req-original','--json'],{env:f.env,stdio:['ignore','pipe','pipe']});let out='',err='';proc.stdout.on('data',b=>out+=b);proc.stderr.on('data',b=>err+=b);
  const exit=await new Promise<number|null>(resolve=>proc.on('close',resolve));assert.equal(exit,1,err);const result=JSON.parse(out);
  assert.equal(result.error.code,'connection_verification_pending');assert.equal(result.result.request_id,'req-original');assert.match(result.next.command,/api tasks --refresh --request-id req-original --json/);assert.equal(result.next.read_only.method,"GET");assert.doesNotMatch(result.next.command,/api (connect|run)\b/);assert.equal(f.counts().business,0);assert.equal(storedHubProfile(f.env)?.identity_verification_pending,true);assert.ok(!out.includes('synthetic-'));
 }finally{await f.close()}
});


for(const auth of ['bearer','key','anonymous'] as const)test('initial SDK '+auth+' configuration preserves its exact selected resource',async()=>{
 const f=await fixture();try{
  const cfg={baseURL:f.env.ITPAY_HUB_URL,...(auth==='bearer'?{bearerToken:'synthetic-explicit'}:auth==='key'?{apiKey:'itk_synthetic_explicit'}:{})};
  const result=await new HubClient(cfg).runStatus('run-original');assert.equal(result.run_id,'run-original');assert.deepEqual(f.sdkRequests,[{method:'GET',path:'/v1/runs/run-original',resource:f.env.ITPAY_HUB_URL}]);assert.equal(f.counts().rotations,0);
 }finally{await f.close()}
});

test('fresh original session reader succeeds on the strict alias without refreshing',async()=>{
 const f=await fixture();try{
  storeHubSession('synthetic-old','synthetic-rt-old',300,'buyer-original',f.env.ITPAY_HUB_URL,f.env,'consumer-original');
  assert.equal((await new HubClient(loadHubConfig(f.env)).runStatus('run-original')).run_id,'run-original');assert.deepEqual(f.counts(),{rotations:0,probes:0,business:1});assert.equal(f.sdkRequests[0]?.resource,f.env.ITPAY_HUB_URL);
 }finally{await f.close()}
});

test('strict alias rejects an issuer-expired token once; refresh and the identical original reader both retain resource',async()=>{
 const f=await fixture();try{
  storeHubSession('synthetic-old','synthetic-rt-old',300,'buyer-original',f.env.ITPAY_HUB_URL,f.env,'consumer-original');f.setMode('reject-old');
  assert.equal((await new HubClient(loadHubConfig(f.env)).runStatus('run-original')).run_id,'run-original');assert.deepEqual(f.counts(),{rotations:1,probes:1,business:2});assert.deepEqual(f.sdkRequests,Array.from({length:2},()=>({method:'GET',path:'/v1/runs/run-original',resource:f.env.ITPAY_HUB_URL})));assert.equal(storedHubProfile(f.env)?.consumer_id,'consumer-original');assert.equal(storedHubProfile(f.env)?.subject,'buyer-original');
 }finally{await f.close()}
});


test('strict alias pending request resumes the identical frozen admission once and subsequent resume only reads the original run',async()=>{
 const f=await fixture();
 const invoke=(args:string[])=>child(f.env,`process.argv=['node','itpay','api',...${JSON.stringify(args)},'--json'];await import('./src/main.ts');`);
 try{
  f.setMode('503');const first=await invoke(['run','op-original','--publication','pub-original','--input','{"value":"original"}','--max-charge','123','--request-id','req-original']);assert.equal(first.exit,1,first.err);assert.equal(JSON.parse(first.out).result.request_id,'req-original');assert.equal(f.admissions.length,0);
  f.setMode('ok');const resumed=await invoke(['resume','req-original']);assert.equal(resumed.exit,0,resumed.out+resumed.err);assert.equal(JSON.parse(resumed.out).result.run_id,'run-original');assert.equal(f.admissions.length,1);assert.deepEqual(f.admissions[0],{body:{expected_publication_id:'pub-original',input:{value:'original'},max_charge:{currency:'CNY',scale:6,amount_atoms:'123'}},key:'cli-req-req-original',resource:f.env.ITPAY_HUB_URL});
  const read=await invoke(['resume','req-original']);assert.equal(read.exit,0,read.out+read.err);assert.equal(JSON.parse(read.out).result.run_id,'run-original');assert.equal(f.admissions.length,1);assert.equal(f.counts().rotations,1);assert.equal(f.sdkRequests.at(-1)?.resource,f.env.ITPAY_HUB_URL);assert.equal(storedHubProfile(f.env)?.subject,'buyer-original');assert.equal(storedHubProfile(f.env)?.consumer_id,'consumer-original');
 }finally{await f.close()}
});
