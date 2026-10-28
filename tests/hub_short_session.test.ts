import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectedHubToken,storeHubSession} from '../src/state/hub_credentials.js';
import {HubClient,loadHubConfig} from '../src/client/hub.js';

async function fixture(initialSeconds:number){
 const dir=mkdtempSync(join(tmpdir(),'itpay-short-session-'));let refreshes=0;const requests:{token:string|undefined;key:string|undefined;body:string}[]=[];
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/oauth2/token'){for await(const _ of req){};refreshes++;res.end(JSON.stringify({access_token:'new-'+refreshes,refresh_token:'rotated-'+refreshes,expires_in:5,token_type:'Bearer'}));return}
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'buyer',consumer_id:'consumer'}));return}
  if(req.url==='/v1/operations/op/runs'){
   let body='';for await(const chunk of req)body+=chunk;
   requests.push({token:req.headers.authorization,key:req.headers['idempotency-key'] as string|undefined,body});
   if(req.headers.authorization==='Bearer old'){res.writeHead(401);res.end(JSON.stringify({error:{code:'unauthenticated',message:'expired at issuer'}}));return}
   res.end(JSON.stringify({run_id:'one-original-run',execution_state:'succeeded'}));return
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('listener required');
 const baseURL='http://127.0.0.1:'+address.port;const env={...process.env,ITPAY_STATE_DIR:dir,ITPAY_HUB_URL:baseURL,ITPAY_HUB_OAUTH_ISSUER:baseURL,ITPAY_HUB_OAUTH_CLIENT:'itpay-cli-local'};
 storeHubSession('old','refresh-old',initialSeconds,'buyer',baseURL,env,'consumer');
 return{env,requests,refreshes:()=>refreshes,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true})}};
}

test('ten callers share a newly refreshed five-second token instead of rotating it ten times',async()=>{
 const f=await fixture(-1);try{const tokens=await Promise.all(Array.from({length:10},()=>connectedHubToken(f.env)));assert.equal(f.refreshes(),1);assert.deepEqual(new Set(tokens),new Set(['new-1']))}finally{await f.close()}
});

test('issuer 401 refreshes once and preserves the original paid request body and idempotency key',async()=>{
 const f=await fixture(3600);try{const client=new HubClient(loadHubConfig(f.env));const result=await client.run('op',{expected_publication_id:'pub-original',input:{query:'original'},source_credentials:{api:{credential_id:'uck_original',expected_version:'cred_original'}}},'logical-request');assert.equal('run_id' in result ? result.run_id : undefined,'one-original-run');assert.equal(f.refreshes(),1);assert.equal(f.requests.length,2);assert.equal(f.requests[0]?.key,'logical-request');assert.equal(f.requests[1]?.key,'logical-request');assert.equal(f.requests[0]?.body,f.requests[1]?.body)}finally{await f.close()}
});
