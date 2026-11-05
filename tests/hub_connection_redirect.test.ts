import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoverHubConnection,storeHubSession,hubCredentialsPath} from '../src/state/hub_credentials.js';

for(const stage of ['token','recover']) for(const status of [307,308]) test(`${stage} ${status} never forwards original credentials to a second origin`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'itpay-recovery-redirect-'));let secondRequests=0,oauth=0,recovery=0,identity=0,business=0;
 const second=createServer(async(req,res)=>{secondRequests++;for await(const _ of req){}res.setHeader('Content-Type','application/json');res.end('{}')});
 await new Promise<void>(r=>second.listen(0,'127.0.0.1',r));const secondAddress=second.address();assert.ok(secondAddress&&typeof secondAddress!=='string');const destination=`http://127.0.0.1:${secondAddress.port}/must-not-receive`;
 const first=createServer(async(req,res)=>{
  for await(const _ of req){}res.setHeader('Content-Type','application/json');
  if(req.url==='/oauth2/token'){oauth++;if(stage==='token'){res.writeHead(status,{Location:destination});res.end();return}res.end(JSON.stringify({access_token:'synthetic-candidate',refresh_token:'synthetic-rotated',expires_in:300,token_type:'Bearer'}));return}
  if(req.url==='/v1/connection/recover'){recovery++;res.writeHead(status,{Location:destination});res.end();return}
  if(req.url==='/v1/me'){identity++;res.end('{}');return}
  business++;res.writeHead(500);res.end('{}');
 });
 await new Promise<void>(r=>first.listen(0,'127.0.0.1',r));const address=first.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_')&&!k.startsWith('MONID_'))),ITPAY_STATE_DIR:dir,ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base,ITPAY_HUB_OAUTH_CLIENT:'fixture-client'};
 storeHubSession('synthetic-expired','synthetic-original-refresh',-1,'original-buyer',base,env,'oauth:fixture-client:original');
 const profile=hubCredentialsPath(env),before=readFileSync(profile),task=join(dir,'original-task.json');writeFileSync(task,'{"run_id":"original-run"}');const taskBefore=readFileSync(task);
 try{
  await assert.rejects(recoverHubConnection(env),/connection_(verification_pending|recovery_denied)/);
  assert.equal(secondRequests,0,'redirect destination must receive no request or credential body');
  assert.deepEqual(readFileSync(profile),before);assert.deepEqual(readFileSync(task),taskBefore);
  assert.equal(oauth,1);assert.equal(recovery,stage==='recover'?1:0);assert.equal(identity,0);assert.equal(business,0);
  assert.ok(existsSync(profile+'.recovery.json'),'retain private recovery state without replacing the original');
 }finally{first.closeAllConnections();second.closeAllConnections();await Promise.all([new Promise<void>(r=>first.close(()=>r())),new Promise<void>(r=>second.close(()=>r()))]);rmSync(dir,{recursive:true,force:true})}
});
