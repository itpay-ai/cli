import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,existsSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readOriginalHubReceipt,storeHubSession,hubCredentialsPath,connectedHubToken} from '../src/state/hub_credentials.js';
for(const mode of ['ok','denied','wrong-reply','lost-get','lost-refresh','redirect'])test('original receipt '+mode+' preserves profile and never activates or spends',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-only-'));let oauth=0,reads=0,business=0,deny=mode==='denied';
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;res.setHeader('Content-Type','application/json');
  if(req.url==='/oauth2/token'){oauth++;assert.equal(new URLSearchParams(body).get('refresh_token'),'original-refresh');if(mode==='lost-refresh'){req.socket.destroy();return}res.end(JSON.stringify({access_token:'candidate',refresh_token:'rotated',token_type:'Bearer',expires_in:300}));return}
  if(req.url==='/v1/requests/original%3Akey'){reads++;assert.equal(req.method,'GET');assert.equal(req.headers['x-itpay-receipt-only'],'1');assert.equal(req.headers['x-itpay-expected-consumer'],'oauth:client:original');assert.equal(req.headers['x-itpay-expected-buyer'],'issuer|buyer');assert.equal(req.headers.authorization,'Bearer candidate');
   if(mode==='redirect'){res.writeHead(307,{Location:'/must-not-follow'});res.end();return}
   if(mode==='lost-get'&&reads===1){req.socket.destroy();return}if(deny){res.writeHead(403);res.end('{}');return}res.end(JSON.stringify({request_id:mode==='wrong-reply'?'other':'original:key',read_only:true,run:{run_id:'original-run',actual_charge:{amount_atoms:'12345'}}}));return}
  business++;res.writeHead(500);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();assert.ok(addr&&typeof addr!=='string');const base='http://127.0.0.1:'+addr.port;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_')&&!k.startsWith('MONID_'))),ITPAY_STATE_DIR:dir,ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base,ITPAY_HUB_OAUTH_CLIENT:'client'};
 storeHubSession('expired','original-refresh',-1,'issuer|buyer',base,env,'oauth:client:original');const path=hubCredentialsPath(env),before=readFileSync(path);const task=join(dir,'task.json');writeFileSync(task,'original-task');
 try{
  if(mode==='ok'){const r=await readOriginalHubReceipt('original:key',env) as {run:{run_id:string}};assert.equal(r.run.run_id,'original-run');await readOriginalHubReceipt('original:key',env);assert.equal(reads,2)}
  else {await assert.rejects(readOriginalHubReceipt('original:key',env));if(mode==='lost-get'){await readOriginalHubReceipt('original:key',env);assert.equal(reads,2)}if(mode==='denied'){deny=false;await readOriginalHubReceipt('original:key',env)}}
  if(mode==='lost-refresh')await assert.rejects(readOriginalHubReceipt('original:key',env),/outcome unknown/);
  assert.equal(oauth,1);assert.equal(business,0);assert.deepEqual(readFileSync(path),before);assert.equal(readFileSync(task,'utf8'),'original-task');assert.ok(existsSync(path+'.recovery.json'));assert.equal(statSync(path+'.recovery.json').mode&0o777,0o600);await assert.rejects(connectedHubToken(env),/connection_verification_pending/);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})}
});
