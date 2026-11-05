import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoverHubConnection,connectedHubToken,storeHubSession,hubCredentialsPath,storedHubProfile,withNewHubSession} from '../src/state/hub_credentials.js';
async function fixture(mode:string){
 const dir=mkdtempSync(join(tmpdir(),'itpay-recover-'));const calls={oauth:0,recover:0,me:0,business:0};let lost=false;let conflict=mode==='conflict';
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');let raw='';for await(const c of req)raw+=c;
  if(req.url==='/oauth2/token'){
   calls.oauth++;assert.equal(new URLSearchParams(raw).get('refresh_token'),calls.oauth===1?'original-refresh':'rotated');
   if(mode==='refresh-denied'){res.writeHead(400);res.end('{"error":"invalid_grant"}');return}
   if(mode==='refresh-lost'){req.socket.destroy();return}
   if(mode==='refresh-unavailable'){res.writeHead(503);res.end('{}');return}
   res.end(JSON.stringify({access_token:'candidate',refresh_token:'rotated',token_type:'Bearer',expires_in:300}));return;
  }
  if(req.url==='/v1/connection/recover'){
   calls.recover++;if(conflict){res.writeHead(409);res.end('{}');return;}assert.deepEqual(JSON.parse(raw),{expected_buyer_id:'original-buyer',expected_consumer_id:'oauth:client:original'});assert.equal(req.headers.authorization,'Bearer candidate');
   if(mode==='revoked'||mode==='wrong-binding'){res.writeHead(403);res.end('{}');return}
   if(mode==='recovery-lost'&&!lost){lost=true;req.socket.destroy();return}
   res.end(JSON.stringify({buyer_id:'original-buyer',consumer_id:'oauth:client:original',status:'recovered'}));return;
  }
  if(req.url==='/v1/me'){
   calls.me++;res.end(JSON.stringify({buyer_id:mode==='wrong-buyer'?'other-buyer':'original-buyer',consumer_id:mode==='wrong-consumer'?'oauth:client:other':'oauth:client:original'}));return;
  }
  calls.business++;res.writeHead(500);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_')&&!k.startsWith('MONID_'))),ITPAY_STATE_DIR:dir,ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base,ITPAY_HUB_OAUTH_CLIENT:'client'};
 storeHubSession('expired','original-refresh',-1,'original-buyer',base,env,'oauth:client:original');
 const path=hubCredentialsPath(env),before=readFileSync(path),task=join(dir,'original-task.json');writeFileSync(task,'{"run_id":"original-run"}');const taskBefore=readFileSync(task);
 return{env,path,before,calls,clearConflict:()=>{conflict=false},assertTask:()=>assert.deepEqual(readFileSync(task),taskBefore),close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})}};
}
test('explicit recovery commits only exact original server-verified session; no business calls',async()=>{
 const f=await fixture('ok');try{await recoverHubConnection(f.env);const p=storedHubProfile(f.env)!;assert.equal(p.consumer_id,'oauth:client:original');assert.equal(p.subject,'original-buyer');assert.equal(p.access_token,'candidate');assert.equal(p.refresh_token,'rotated');assert.equal(p.identity_verification_pending,undefined);assert.equal(statSync(f.path).mode&0o777,0o600);assert.equal(existsSync(f.path+'.recovery.json'),false);assert.deepEqual(f.calls,{oauth:1,recover:1,me:1,business:0});f.assertTask()}finally{await f.close()}
});
for(const mode of ['wrong-buyer','wrong-consumer','revoked','wrong-binding','refresh-denied'])test('failed '+mode+' preserves original profile/tasks and blocks business fallback',async()=>{
 const f=await fixture(mode);try{await assert.rejects(recoverHubConnection(f.env),/connection_recovery_denied/);assert.deepEqual(readFileSync(f.path),f.before);f.assertTask();assert.equal(f.calls.business,0);assert.equal(statSync(f.path+'.recovery.json').mode&0o777,0o600);await assert.rejects(connectedHubToken(f.env),/connection_verification_pending/);assert.equal(f.calls.oauth,1)}finally{await f.close()}
});
test('lost recovery reply reuses private candidate, never rotates or submits business twice',async()=>{
 const f=await fixture('recovery-lost');try{await assert.rejects(recoverHubConnection(f.env),/outcome unknown/);assert.deepEqual(readFileSync(f.path),f.before);await recoverHubConnection(f.env);assert.deepEqual(f.calls,{oauth:1,recover:2,me:1,business:0});f.assertTask()}finally{await f.close()}
});
test('lost refresh outcome never repeats refresh or overwrites the original',async()=>{
 const f=await fixture('refresh-lost');try{await assert.rejects(recoverHubConnection(f.env),/outcome unknown/);await assert.rejects(recoverHubConnection(f.env),/outcome unknown/);assert.deepEqual(readFileSync(f.path),f.before);assert.deepEqual(f.calls,{oauth:1,recover:0,me:0,business:0});f.assertTask()}finally{await f.close()}
});

test('conflict preserves both original and rotated candidate; same candidate can retry after owner decision',async()=>{
 const f=await fixture('conflict');try{await assert.rejects(recoverHubConnection(f.env),/connection_recovery_conflict/);assert.deepEqual(readFileSync(f.path),f.before);const pending=JSON.parse(readFileSync(f.path+'.recovery.json','utf8'));assert.equal(pending.profile.refresh_token,'rotated');assert.equal(f.calls.oauth,1);f.clearConflict();await recoverHubConnection(f.env);assert.equal(f.calls.oauth,1);assert.equal(f.calls.recover,2);assert.equal(f.calls.business,0);f.assertTask()}finally{await f.close()}
});
test('expired conflict candidate rotates its saved refresh proof, never reuses consumed original refresh',async()=>{
 const f=await fixture('conflict');try{await assert.rejects(recoverHubConnection(f.env),/connection_recovery_conflict/);const path=f.path+'.recovery.json',pending=JSON.parse(readFileSync(path,'utf8'));pending.profile.expires_at=new Date(0).toISOString();writeFileSync(path,JSON.stringify(pending),{mode:0o600});f.clearConflict();await recoverHubConnection(f.env);assert.equal(f.calls.oauth,2);assert.equal(f.calls.business,0);f.assertTask()}finally{await f.close()}
});
test('browser session guard rejects an existing original before any new consent',async()=>{
 const f=await fixture('ok');try{await assert.rejects(withNewHubSession(async()=>{throw new Error('new consent must not start')},f.env),/connection_recovery_denied/);assert.deepEqual(readFileSync(f.path),f.before);assert.deepEqual(f.calls,{oauth:0,recover:0,me:0,business:0});f.assertTask()}finally{await f.close()}
});
test('issuer outage is unknown, never mistaken for revoked consent or retried refresh',async()=>{
 const f=await fixture('refresh-unavailable');try{await assert.rejects(recoverHubConnection(f.env),/connection_verification_pending/);await assert.rejects(recoverHubConnection(f.env),/outcome unknown/);assert.deepEqual(readFileSync(f.path),f.before);assert.equal(f.calls.oauth,1);assert.equal(f.calls.business,0);f.assertTask()}finally{await f.close()}
});

test('concurrent browser attempts hold the credential lock before starting a second consent',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'itpay-connect-lock-'));const env={ITPAY_STATE_DIR:dir,ITPAY_HUB_URL:'http://127.0.0.1:1',ITPAY_HUB_OAUTH_ISSUER:'http://127.0.0.1:1',ITPAY_HUB_OAUTH_CLIENT:'client'};let started=0;let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 try{
  const first=withNewHubSession(async save=>{started++;entered();await gate;save('synthetic','synthetic-refresh',300,'buyer',env.ITPAY_HUB_URL,'oauth:client:original')},env);await ready;
  const second=withNewHubSession(async()=>{started++},env);release();await first;await assert.rejects(second,/connection_recovery_denied/);assert.equal(started,1);assert.equal(storedHubProfile(env)?.consumer_id,'oauth:client:original');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
