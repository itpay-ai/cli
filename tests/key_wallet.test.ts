import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
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
  if(['itk_rejected','itk_diagnostics_rejected'].includes(String(req.headers['x-itpay-key']))){res.writeHead(401);res.end('{"error":{"code":"unauthenticated","message":"key rejected"}}');return;}
  if(req.url==='/v1/discover'){res.end(JSON.stringify({items:[{operation_id:'free-op'}]}));return;}
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
  const balance=await cli(['api','wallet']);assert.equal(balance.value.result.available_atoms,'9990000');assert.equal(balance.value.result.identity.account_hint,'…AAAAAA');
  const healthy=await cli(['api','doctor']);assert.equal(healthy.code,0);assert.equal(healthy.value.status,'ok');
  const rejected=await cli(['api','doctor'],{ITPAY_HUB_KEY:'itk_diagnostics_rejected'});assert.equal(rejected.code,1);assert.equal(rejected.value.status,'degraded');assert.equal(rejected.value.result.authenticated,false);assert.equal(oauth,0);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(state,{recursive:true,force:true})}
});

test('link-only host prepares and reuses one amount top-up and completes its same checkout',async()=>{
 const state=mkdtempSync(join(tmpdir(),'wallet-topup-'));let paid=false;const keys=new Set<string>();let origin='';
 const receipt=()=>({topup_id:'top_same',status:paid?'credited':'payment_pending',amount:'30.00',currency:'CNY',account_hint:'…walletA',expires_at:'2099-01-01T00:00:00Z',page_url:origin+'/card',checkout_url:origin+'/checkout',image:origin+'/card.png'});
 const server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'fixture-walletA',key_id:'key-a'}));return}
  if(req.url==='/v1/me/topups'&&req.method==='POST'){let raw='';for await(const b of req)raw+=b;assert.equal(JSON.parse(raw).amount_cny,'30');keys.add(String(req.headers['idempotency-key']));res.end(JSON.stringify(receipt()));return}
  if(req.url==='/v1/me/topups/top_same'){res.end(JSON.stringify(receipt()));return}
  if(req.url==='/checkout'){res.setHeader('Content-Type','text/html');res.end('<form method="post" action="/confirm">Confirm simulated payment</form>');return}
  if(req.url==='/confirm'&&req.method==='POST'){paid=true;res.end('{"status":"confirmed"}');return}
  res.writeHead(404);res.end('{}');
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();assert.ok(addr&&typeof addr!=='string');origin='http://127.0.0.1:'+addr.port;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_'))),ITPAY_STATE_DIR:state,ITPAY_HUB_URL:origin,ITPAY_HUB_KEY:'itk_synthetic_topup'};
 const cli=(args:string[])=>new Promise<any>((resolve,reject)=>{const c=spawn(process.execPath,['--import','tsx','src/main.ts','api','wallet',...args,'--json'],{cwd:root,env});let raw='',err='';c.stdout.on('data',b=>raw+=b);c.stderr.on('data',b=>err+=b);c.on('close',code=>{try{assert.equal(code,0,err+raw);resolve(JSON.parse(raw))}catch(e){reject(e)}});c.on('error',reject)});
 try{const first=await cli(['--topup','30','--no-open']);assert.equal(first.result.browser.status,'unavailable');assert.equal(first.result.checkout_url,origin+'/checkout');const repeat=await cli(['--topup','30','--no-open']);assert.equal(repeat.result.topup_id,first.result.topup_id);assert.equal(keys.size,1);const page=await fetch(first.result.checkout_url);assert.match(await page.text(),/Confirm simulated/);await fetch(origin+'/confirm',{method:'POST'});const done=await cli(['--topup-status','top_same','--no-open']);assert.equal(done.status,'credited');assert.match(done.instruction,/已到账/);assert.equal(done.next,null)}
 finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(state,{recursive:true,force:true})}
});

async function walletRefundRecovery(previewRace:boolean,usd=false){
 let previewOccupied=false;const state=mkdtempSync(join(tmpdir(),'wallet-refund-'));let latest='top-a',lost=true,writes=0;
 const refunds=new Map<string,{top:string,id:string}>();let fixtureEnv:NodeJS.ProcessEnv={};
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'issuer|buyer_AAAAAA',consumer_id:'oauth:fixture:original'}));return;}
  const u=new URL(req.url!,'http://fixture');
  if(u.pathname==='/v1/me/wallet/refund'&&req.method==='GET'){
   const key=u.searchParams.get('request_key'),original=key?refunds.get(key):undefined;
   res.end(JSON.stringify({status:key?(original?'unknown':'unconfirmed'):'eligible',topup_id:original?.top||latest,refund_id:original?.id||'',amount_minor_text:usd?'150':'100',currency:usd?'USD':'CNY',credit_atoms:'1000000',cny_equivalent:'1.000000',used_atoms:'0',occupied_atoms:original||previewOccupied?'1000000':'0',reason:original||previewOccupied?'original_credit_occupied':'',account_hint:'…AAAAAA',payment_account_hint:'',payment_provider:'fakepass',wallet_url:'http://fixture/me/usage',next_step:'read_original_request'}));return;
  }
  if(u.pathname==='/v1/me/wallet/refund'&&req.method==='POST'){
   writes++;const key=String(req.headers['idempotency-key']);let body='';for await(const part of req)body+=part;
   const input=JSON.parse(body);assert.deepEqual(Object.keys(input).sort(),["confirmed","expected_topup_id"]);assert.equal(input.confirmed,true);
   const {readFileSync}=await import('node:fs');const {hubTasksDir}=await import('../src/state/hub_tasks.js');
   const saved=JSON.parse(readFileSync(join(hubTasksDir(fixtureEnv),'.refunds',key+'.json'),'utf8'));
   assert.equal(saved.sent,true,'request must be durable before network');assert.equal(input.expected_topup_id,saved.topup_id);
   if(input.expected_topup_id!==latest){res.writeHead(409);res.end(JSON.stringify({error:{code:'refund_preview_changed',message:'original changed'}}));return;}
   const original={top:latest,id:'refund-'+latest};refunds.set(key,original);
   if(lost){lost=false;req.socket.destroy();return;}
   res.end(JSON.stringify({status:'pending',topup_id:original.top,refund_id:original.id,credit_atoms:'1000000',cny_equivalent:'1.000000',used_atoms:'0',occupied_atoms:'1000000',reason:'original_credit_occupied',account_hint:'…AAAAAA',wallet_url:'http://fixture/me/usage'}));return;
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
 const base='http://127.0.0.1:'+a.port;
 fixtureEnv={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_'))),ITPAY_HUB_URL:base,ITPAY_STATE_DIR:state,ITPAY_HUB_OAUTH_CLIENT:'fixture'};
 storeHubSession('synthetic-oauth-refund',undefined,3600,'issuer|buyer_AAAAAA',base,fixtureEnv,'oauth:fixture:original');
 const cli=async(args:string[],overrides:Record<string,string>={})=>new Promise<any>((resolve,reject)=>{
  const p=spawn(process.execPath,process.env.ITPAY_REFUND_TEST_CLI?[process.env.ITPAY_REFUND_TEST_CLI,'api','wallet',...args,'--json']:['--import','tsx','src/main.ts','api','wallet',...args,'--json'],{cwd:root,env:{...fixtureEnv,...overrides}});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('close',()=>{try{assert.ok(!out.includes('synthetic-oauth-refund'));resolve(JSON.parse(out))}catch(e){reject(Error(String(e)+' '+out+' '+err))}});
 });
 try{
  previewOccupied=true;const occupiedPreview=await cli(['--refund-latest']);assert.match(occupiedPreview.instruction,/原任务/);previewOccupied=false;
  const preview=await cli(['--refund-latest']);assert.equal(writes,0);assert.equal(preview.status,'eligible');assert.match(preview.instruction,usd?/原款 USD 1.50/:/原款 CNY 1.00/);const key=preview.result.request_id;assert.match(key,/^cli-refund-/);
  const confirmed=['--refund-latest','--refund-request',key,'--confirm'];
  if(previewRace){
   latest='top-b';
   const stale=await cli(confirmed);assert.equal(stale.status,'preview_changed');assert.equal(writes,1);assert.equal(refunds.size,0);
   const repeated=await cli(confirmed);assert.equal(repeated.status,'preview_changed');assert.equal(writes,1);assert.equal(refunds.size,0);
   const freshPreview=await cli(['--refund-latest']);assert.equal(freshPreview.result.topup_id,'top-b');lost=false;
   const fresh=await cli(['--refund-latest','--refund-request',freshPreview.result.request_id,'--confirm']);assert.equal(fresh.status,'pending');assert.doesNotMatch(fresh.instruction,/核对原任务/);assert.match(fresh.instruction,/退款冻结/);assert.equal(fresh.result.topup_id,'top-b');assert.equal(writes,2);assert.equal(refunds.size,1);return;
  }
  const first=await cli(confirmed);assert.equal(first.status,'unconfirmed');assert.equal(writes,1);
  latest='top-b';
  const retry=await cli(confirmed);assert.equal(writes,1);assert.equal(retry.result.topup_id,'top-a');assert.equal(retry.result.refund_id,'refund-top-a');assert.doesNotMatch(retry.instruction,/核对原任务/);assert.match(retry.instruction,/退款冻结/);
  const status=await cli(['--refund-status',key]);assert.equal(status.result.refund_id,'refund-top-a');assert.equal(writes,1);
  await cli(['--refund-latest','--refund-request','explicit-new-b']);assert.equal(writes,1);
  const fresh=await cli(['--refund-latest','--refund-request','explicit-new-b','--confirm']);assert.equal(writes,2);assert.equal(fresh.result.topup_id,'top-b');
  await cli(['--refund-latest','--confirm']);assert.equal(writes,2);
  const denied=await cli(['--refund-latest'],{ITPAY_HUB_KEY:'itk_refund_denied'});assert.equal(denied.status,'error');assert.equal(writes,2);
  await cli(['--refund-status',key],{ITPAY_HUB_OAUTH_CLIENT:'other-profile'});assert.equal(writes,2);
  const foreign=await cli(confirmed,{ITPAY_HUB_OAUTH_CLIENT:'other-profile'});assert.equal(foreign.status,'error');assert.equal(writes,2);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(state,{recursive:true,force:true})}
}
test('wallet refund persists before POST and repeated confirmation after newer credit only reads the original',()=>walletRefundRecovery(false));
test('wallet refund USD preview states frozen original cash without converting credit',()=>walletRefundRecovery(false,true));
test('wallet refund rejects stale preview before first acceptance and requires fresh explicit confirmation',()=>walletRefundRecovery(true));

test('wallet refund preserves definitive rejection and nonzero exit without resubmitting; uncertain HTTP remains original-key read only',async()=>{
 const state=mkdtempSync(join(tmpdir(),'wallet-refund-errors-'));let writes=0,reads=0,code=403;let contractMismatch=false;const accepted=new Set<string>();
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'issuer|buyer_AAAAAA',consumer_id:'oauth:fixture:original'}));return;}
  const u=new URL(req.url!,'http://fixture');
  if(u.pathname==='/v1/me/wallet/refund'&&req.method==='GET'){
   reads++;const key=u.searchParams.get('request_key');res.end(JSON.stringify(key?accepted.has(key)?{status:'pending',topup_id:'top-original',refund_id:'original-refund'}:{status:'unconfirmed',request_recorded:false}:{status:'eligible',topup_id:'top-original',account_hint:'…AAAAAA'}));return;
  }
  if(u.pathname==='/v1/me/wallet/refund'&&req.method==='POST'){
   writes++;for await(const _part of req){/* consume synthetic request */}
   if(contractMismatch){accepted.add(String(req.headers['idempotency-key']));res.setHeader('X-ItPay-Hub-Contract','synthetic-different-revision');res.end(JSON.stringify({status:'pending',topup_id:'top-original',refund_id:'original-refund'}));return;}
   res.writeHead(code);res.end(JSON.stringify({error:{code:code===403?'original_connection_required':code===400?'invalid_input':'temporarily_unavailable',message:code===403?'recheck the original connection; no replacement refund':'original request cannot be confirmed'}}));return;
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');const base='http://127.0.0.1:'+a.port;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_'))),ITPAY_HUB_URL:base,ITPAY_STATE_DIR:state,ITPAY_HUB_OAUTH_CLIENT:'fixture'};
 storeHubSession('synthetic-refund-rejection',undefined,3600,'issuer|buyer_AAAAAA',base,env,'oauth:fixture:original');
 const cli=(args:string[])=>new Promise<{exit:number|null;value:any}>((resolve,reject)=>{
  const p=spawn(process.execPath,process.env.ITPAY_REFUND_TEST_CLI?[process.env.ITPAY_REFUND_TEST_CLI,'api','wallet',...args,'--json']:['--import','tsx','src/main.ts','api','wallet',...args,'--json'],{cwd:root,env});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('close',exit=>{try{assert.ok(!stdout.includes('synthetic-refund-rejection'));resolve({exit,value:JSON.parse(stdout)})}catch(e){reject(Error(String(e)+' '+stdout+' '+stderr))}});
 });
 try{
  for(const status of [403,400,500,408,'contract-mismatch'] as const){
   contractMismatch=status==='contract-mismatch';code=typeof status==='number'?status:200;const preview=await cli(['--refund-latest']),key=preview.value.result.request_id;const confirm=['--refund-latest','--refund-request',key,'--confirm'];const before=writes;
   const first=await cli(confirm);assert.equal(writes,before+1);
   if(status===403||status===400){
    assert.notEqual(first.exit,0);assert.equal(first.value.status,'error');assert.match(JSON.stringify(first.value),new RegExp(status===403?'original_connection_required':'invalid_input'));
    const repeat=await cli(confirm);assert.notEqual(repeat.exit,0);assert.equal(writes,before+1);
    const oldReads=reads;const observed=await cli(['--refund-status',key]);assert.notEqual(observed.exit,0);assert.equal(reads,oldReads+1);assert.equal(writes,before+1);assert.match(JSON.stringify(observed.value),new RegExp(status===403?'original_connection_required':'invalid_input'));
   }else{
    assert.equal(first.exit,0);assert.equal(first.value.status,contractMismatch?'pending':'unconfirmed');const repeated=await cli(confirm);assert.equal(repeated.value.status,contractMismatch?'pending':'unconfirmed');if(contractMismatch)assert.equal(repeated.value.result.refund_id,'original-refund');assert.equal(writes,before+1);
   }
  }
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(state,{recursive:true,force:true})}
});

test('wallet top-up uses original payment status after refunds, creates a distinct explicit purchase and keeps old status read only',async()=>{
 const state=mkdtempSync(join(tmpdir(),'wallet-topup-refund-'));let origin='',posts=0,failOriginalRead=false;
 const orders=new Map<string,{id:string;status:string;payment_status?:string}>(),keys=new Map<string,string>();
 const view=(order:{id:string;status:string;payment_status?:string})=>({topup_id:order.id,status:order.status,...order.payment_status?{payment_status:order.payment_status}:{},amount:'1.00',page_url:origin+'/old-card',checkout_url:origin+'/old-checkout',image:origin+'/old.png',collection_action:{target:origin+'/old-checkout'},presentation_hint:'open the payment checkout',expires_at:'2099-01-01T00:00:00Z'});
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'fixture-walletA',key_id:'key-a'}));return;}
  if(req.url==='/v1/me/topups'&&req.method==='POST'){
   posts++;for await(const _chunk of req){/* synthetic body */}
   const key=String(req.headers['idempotency-key']);let id=keys.get(key);
   if(!id){id='top-'+(orders.size+1);orders.set(id,{id,status:'payment_pending',payment_status:'payment_pending'});keys.set(key,id);}
   res.end(JSON.stringify(view(orders.get(id)!)));return;
  }
  if(req.url?.startsWith('/v1/me/topups/')){
   if(failOriginalRead){res.writeHead(503);res.end('{"error":{"code":"read_unavailable","message":"keep original"}}');return;}
   const id=req.url.split('/').at(-1)!,order=orders.get(id);if(order){res.end(JSON.stringify(view(order)));return;}
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_'))),ITPAY_STATE_DIR:state,ITPAY_HUB_URL:origin,ITPAY_HUB_KEY:'itk_synthetic_topup_projection'};
 const cli=(args:string[])=>new Promise<{exit:number|null;value:any}>((resolve,reject)=>{
  const p=spawn(process.execPath,process.env.ITPAY_REFUND_TEST_CLI?[process.env.ITPAY_REFUND_TEST_CLI,'api','wallet',...args,'--no-open','--json']:['--import','tsx','src/main.ts','api','wallet',...args,'--no-open','--json'],{cwd:root,env});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('close',exit=>{try{resolve({exit,value:JSON.parse(stdout)})}catch(e){reject(Error(String(e)+' '+stdout+' '+stderr))}});
 });
 const buy=()=>cli(['--topup','1']),read=(id:string)=>cli(['--topup-status',id]);
 try{
  const first=await buy();assert.equal(first.exit,0);const a=first.value.result.topup_id;
  const pending=await buy();assert.equal(pending.value.result.topup_id,a);assert.equal(keys.size,1,'valid unpaid original must be reused');
  orders.set(a,{id:a,status:'refund_unknown',payment_status:'credited'});
  const beforeRead=posts;const original=await read(a);assert.equal(posts,beforeRead);assert.equal(original.value.status,'refund_unknown');if(original.value.next)assert.match(original.value.next.command,/--topup-status/);assert.doesNotMatch(original.value.instruction,/可扫码|本人付款后|打开同单收银台/);for(const field of ['page_url','checkout_url','image','collection_action','presentation_hint'])assert.equal(original.value.result[field],undefined);
  const second=await buy();const b=second.value.result.topup_id;assert.notEqual(b,a);assert.equal(keys.size,2);
  // The server can have completed/refunded B even while its local receipt is pending.
  orders.set(b,{id:b,status:'refunded',payment_status:'credited'});
  const third=await buy();const c=third.value.result.topup_id;assert.notEqual(c,b);assert.equal(keys.size,3);
  const beforeOldReads=posts;const old=await read(b);assert.equal(old.value.status,'refunded');assert.equal(old.value.next,null);assert.doesNotMatch(old.value.instruction,/可扫码|本人付款后|打开同单收银台/);assert.equal(posts,beforeOldReads);
  // Legacy projected receipts without payment_status still mean the purchase ended.
  orders.set(c,{id:c,status:'refunded'});const fourth=await buy();assert.notEqual(fourth.value.result.topup_id,c);assert.equal(keys.size,4);
  failOriginalRead=true;const beforeFailure=posts;const unavailable=await buy();assert.notEqual(unavailable.exit,0);assert.equal(posts,beforeFailure);assert.equal(keys.size,4,'an unknown original read must not replace the purchase');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(state,{recursive:true,force:true})}
});


test('explicit expired purchase persists one renewal key across unknown, restart and read-only old status',async()=>{
 const state=mkdtempSync(join(tmpdir(),'wallet-expired-renewal-'));let origin='',posts=0,unknown=true,originalStatus='expired';
 const keys:string[]=[];
 const view=(id:string,status:string)=>({topup_id:id,status,payment_status:status,amount:'1.00',expires_at:status==='payment_pending'?'2099-01-01T00:00:00Z':'2000-01-01T00:00:00Z',page_url:origin+'/cashier'});
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'fixture-walletA',key_id:'key-a'}));return;}
  if(req.method==='POST'){
   posts++;for await(const _chunk of req){} keys.push(String(req.headers['idempotency-key']));
   if(posts===1){res.end(JSON.stringify(view('top-old','payment_pending')));return;}
   if(unknown){res.writeHead(503);res.end('{"error":{"code":"original_payment_unconfirmed","message":"keep original"}}');return;}
   originalStatus='closed_unpaid';res.end(JSON.stringify(view('top-new','payment_pending')));return;
  }
  if(req.url==='/v1/me/topups/top-old'){res.end(JSON.stringify(view('top-old',originalStatus)));return;}
  if(req.url==='/v1/me/topups/top-new'){res.end(JSON.stringify(view('top-new','payment_pending')));return;}
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_'))),ITPAY_STATE_DIR:state,ITPAY_HUB_URL:origin,ITPAY_HUB_KEY:'itk_synthetic_expired'};
 const cli=(args:string[])=>new Promise<{exit:number|null;value:any}>((resolve,reject)=>{
  const p=spawn(process.execPath,['--import','tsx','src/main.ts','api','wallet',...args,'--no-open','--json'],{cwd:root,env});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('close',exit=>{try{resolve({exit,value:JSON.parse(stdout)})}catch(e){reject(Error(String(e)+' '+stdout+' '+stderr))}});
 });
 try{
  assert.equal((await cli(['--topup','1'])).value.result.topup_id,'top-old');
  assert.notEqual((await cli(['--topup','1'])).exit,0);assert.notEqual(keys[0],keys[1]);
  const before=posts;assert.equal((await cli(['--topup-status','top-old'])).value.status,'expired');assert.equal(posts,before);
  assert.notEqual((await cli(['--topup','1'])).exit,0);assert.equal(keys[2],keys[1]);
  // A lost new-purchase response may leave the original already fenced.
  originalStatus='closed_unpaid';unknown=false;
  assert.equal((await cli(['--topup','1'])).value.result.topup_id,'top-new');assert.equal(keys[3],keys[1]);
  const after=posts;assert.equal((await cli(['--topup-status','top-old'])).value.status,'closed_unpaid');assert.equal(posts,after);
  assert.equal((await cli(['--topup','1'])).value.result.topup_id,'top-new');assert.equal(keys[4],keys[1]);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(state,{recursive:true,force:true})}
});


test('USD credit purchase preserves currency and one key after lost response, shows frozen cash, and retains CNY originals',async()=>{
 const state=mkdtempSync(join(tmpdir(),'wallet-usd-'));let origin='',lost=true,posts=0,reads=0;
 const keys=new Map<string,string>();const orders=new Map<string,any>();
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'fixture-walletA',key_id:'key-a'}));return;}
  if(req.url==='/v1/me/topups'&&req.method==='POST'){
   posts++;let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),key=String(req.headers['idempotency-key']);
   assert.equal(body.amount_cny,'10');let id=keys.get(key);
   if(!id){id='top-'+orders.size;keys.set(key,id);orders.set(id,{topup_id:id,status:'payment_pending',amount:'10.00',payer_currency:body.payer_currency,payer_minor_amount:body.payer_currency==='USD'?'139':'1000',environment:'test',expires_at:'2099-01-01T00:00:00Z',page_url:origin+'/cashier'});}
   assert.equal(orders.get(id).payer_currency,body.payer_currency);
   if(body.payer_currency==='USD'&&lost){lost=false;res.destroy();return;}
   res.end(JSON.stringify(orders.get(id)));return;
  }
  if(req.url?.startsWith('/v1/me/topups/')){reads++;res.end(JSON.stringify(orders.get(req.url.split('/').at(-1)!)));return;}
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');origin='http://127.0.0.1:'+a.port;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_'))),ITPAY_STATE_DIR:state,ITPAY_HUB_URL:origin,ITPAY_HUB_KEY:'itk_synthetic_usd'};
 const cli=(args:string[])=>new Promise<{exit:number|null;value:any}>((resolve,reject)=>{
  const p=spawn(process.execPath,['--import','tsx','src/main.ts','api','wallet',...args,'--json','--no-open'],{cwd:root,env});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('close',exit=>{try{resolve({exit,value:JSON.parse(stdout)})}catch(e){reject(Error(String(e)+' '+stdout+' '+stderr))}});
 });
 try{
  const cny=await cli(['--topup','10']);assert.equal(cny.exit,0);assert.match(cny.value.instruction,/CNY 10.00/);
  const usd=['--topup','10','--payer-currency','USD'];assert.notEqual((await cli(usd)).exit,0);
  const retry=await cli(usd);assert.equal(retry.exit,0);assert.equal(keys.size,2);assert.match(retry.value.instruction,/10.00 credit（实际支付 USD 1.39；测试模式）/);assert.doesNotMatch(retry.value.instruction,/实际支付 CNY/);
  assert.equal((await cli(usd)).value.result.topup_id,retry.value.result.topup_id);assert.equal(keys.size,2);
  const before=posts;assert.equal((await cli(['--topup-status',cny.value.result.topup_id])).value.result.payer_currency,'CNY');assert.equal(posts,before);assert.ok(reads>0);
  for(const args of [['--payer-currency','USD'],['--topup','10','--payer-currency','EUR'],['--topup-status',retry.value.result.topup_id,'--payer-currency','USD'],['--refund-latest','--payer-currency','USD']])assert.notEqual((await cli(args)).exit,0);
  assert.equal(posts,before);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(state,{recursive:true,force:true})}
});


test('browser original topup reads the existing owner refund route without local adoption, writes or topup reconciliation',async()=>{
 const state=mkdtempSync(join(tmpdir(),'wallet-owner-original-'));let reads=0,other=0,mode='succeeded';
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'issuer|buyer_BBBBBB'}));return;}
  if(req.method==='GET'&&req.url==='/v1/me/wallet/refund?topup_id=top-browser'){
   reads++;if(mode==='foreign'){res.writeHead(404);res.end(JSON.stringify({error:{code:'not_found',message:'original refund not found'}}));return;}
   if(mode==='unavailable'){res.writeHead(503);res.end(JSON.stringify({error:{code:'refund_read_unavailable',message:'read original'}}));return;}
   res.end(JSON.stringify({topup_id:mode==='mismatch'?'top-other':'top-browser',status:mode,refund_id:'refund-browser',amount_minor:100,currency:'CNY',cny_equivalent:'1.000000',account_hint:'…BBBBBB',payment_provider:'alipay'}));return;
  }
  other++;res.writeHead(405);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_'))),ITPAY_STATE_DIR:state,ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_CLIENT:'fixture'};
 storeHubSession('synthetic-browser-owner',undefined,3600,'issuer|buyer_BBBBBB',base,env,'oauth:fixture:b');
 const cli=(overrides:Record<string,string>={})=>new Promise<{exit:number|null;value:any}>((resolve,reject)=>{
  const args=process.env.ITPAY_REFUND_TEST_CLI?[process.env.ITPAY_REFUND_TEST_CLI]:['--import','tsx','src/main.ts'];
  const p=spawn(process.execPath,[...args,'api','wallet','--topup-status','top-browser','--json'],{cwd:root,env:{...env,...overrides}});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('close',exit=>{try{resolve({exit,value:JSON.parse(out)})}catch(e){reject(Error(String(e)+' '+out+' '+err))}});
 });
 try{
  const original=await cli();assert.equal(original.exit,0);assert.equal(original.value.status,'succeeded');assert.equal(original.value.result.topup_id,'top-browser');assert.equal(original.value.result.request_id,undefined);assert.match(original.value.instruction,/原路退款/);assert.match(original.value.instruction,/CNY 1.00/);assert.equal(original.value.next,null);
  mode='unknown';const unknown=await cli();assert.equal(unknown.exit,0);assert.equal(unknown.value.status,'unknown');assert.match(unknown.value.instruction,/只查询原请求/);if(unknown.value.next){assert.match(unknown.value.next.command,/--topup-status top-browser/);assert.doesNotMatch(unknown.value.next.command,/--confirm|--refund-latest/);}
  for(const rejected of ['foreign','unavailable','mismatch']){mode=rejected;assert.notEqual((await cli()).exit,0);}
  const before=reads;assert.notEqual((await cli({ITPAY_HUB_KEY:'itk_synthetic_restricted'})).exit,0);assert.equal(reads,before,'Key must not fall back to owner credentials');
  assert.equal(other,0,'no POST, topup read/reconcile, supplier or refund submission');
  const {hubTasksDir}=await import('../src/state/hub_tasks.js');assert.equal(existsSync(join(hubTasksDir(env),'.funding')),false);assert.equal(existsSync(join(hubTasksDir(env),'.refunds')),false);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(state,{recursive:true,force:true});}
});
