// Installed bundle, isolated state, loopback-only synthetic ownership/ledger.
// Exercise real SDK deadlines; never use a live Hub, grant or money.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

export async function verifyHubRecoveryPackaged(packageRoot,scratch){
 const state=join(scratch,'hub-recovery-state');mkdirSync(state,{recursive:true,mode:0o700});
 const entry=join(packageRoot,'bin/itp.mjs');let posts=0,continues=0,reads=0,lookups=0,sends=0,charges=0;let completion;
 const rec=terminal=>({run_id:'run-packed-original',operation_id:'op-packed',publication_id:'pub-packed',execution_state:terminal?'succeeded':'accepted',settlement_state:terminal?'captured':'reserved',delivery_state:terminal?'inline':'not_ready',terminal,pending_stage:terminal?null:'queued',next:terminal?null:{read_only:{method:'GET',path:'/v1/runs/run-packed-original'}},...(terminal?{actual_charge:{amount_atoms:'10000',currency:'CNY',scale:6},result:{fixture:true}}:{})});
 const task=()=>{const scopes=readdirSync(join(state,'hub-tasks'));assert.equal(scopes.length,1);return JSON.parse(readFileSync(join(state,'hub-tasks',scopes[0],'packed-original.json'),'utf8'))};
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  assert.equal(req.headers['x-itpay-key'],'itk_synthetic_packed_recovery');
  if(req.method==='POST')posts++;
  if(req.url==='/v1/operations/op-packed/runs'){
   assert.equal(req.headers['idempotency-key'],'cli-req-packed-original');let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);assert.deepEqual(input.max_charge,{amount_atoms:'10000',currency:'CNY',scale:6});
   res.writeHead(403);res.end(JSON.stringify({intent_id:'int-packed',kind:'api_run',status:'open',blocking_reason:'authorization_denied',terminal:false,pending_stage:'authorization',next:{read_only:{method:'GET',path:'/v1/requests/cli-req-packed-original'}}}));return;
  }
  if(req.url==='/v1/intents/int-packed/continue'){
   continues++;assert.equal(continues,1,'known run recovery must not continue twice');assert.equal(req.headers['idempotency-key'],'cli-continue-packed-original');sends++;completion=setTimeout(()=>{charges=1},100);
   res.end(JSON.stringify({intent_id:'int-packed',status:'succeeded',terminal:false,pending_stage:'queued',next:{read_only:{method:'GET',path:'/v1/runs/run-packed-original'}},run:rec(false)}));return;
  }
  if(req.url==='/v1/runs/run-packed-original'){
   reads++;assert.equal(task().run_id,'run-packed-original','installed bundle persists binding before its first wait GET');
   if(reads===1)return; // Real fixed SDK status deadline must expire.
   assert.equal(charges,1,'synthetic owner settled independently, never because of a status GET');res.end(JSON.stringify(rec(true)));return;
  }
  if(req.url==='/v1/requests/cli-req-packed-original'){
   lookups++;res.end(JSON.stringify({request_id:'cli-req-packed-original',intent_id:'int-packed',intent:{intent_id:'int-packed',kind:'api_run',status:'succeeded'},run:rec(true),terminal:true,pending_stage:null,next:null}));return;
  }
  res.writeHead(404);res.end(JSON.stringify({error:{code:'not_found',message:'synthetic missing reference'}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_')&&!k.startsWith('MONID_'))),ITPAY_STATE_DIR:state,ITPAY_AGENT_TYPE:'workbuddy',ITPAY_HUB_URL:base,ITPAY_HUB_KEY:'itk_synthetic_packed_recovery'};
 const invoke=args=>new Promise((done,reject)=>{const c=spawn(process.execPath,[entry,'api',...args],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);c.on('error',reject);c.on('exit',code=>done({code,stdout,stderr}));});
 try{
  const admission=await invoke(['run','op-packed','--publication','pub-packed','--input','{}','--max-charge','10000','--request-id','packed-original','--json']);assert.equal(admission.code,0,admission.stderr);assert.equal(JSON.parse(admission.stdout).status,'authorization_denied');
  const first=await invoke(['resume','packed-original','--wait','1','--json']);assert.equal(first.code,1,first.stderr);const failure=JSON.parse(first.stdout);assert.equal(failure.result.run_id,'run-packed-original');assert.deepEqual(failure.error.details,{stage:'status',method:'GET',path:'/v1/runs/{run_id}'});assert.equal(task().run_id,'run-packed-original');
  const resumed=await invoke(['resume','packed-original','--wait','1','--json']);assert.equal(resumed.code,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).result.terminal,true);assert.equal(task().blocking_reason,undefined);assert.equal(task().status,'succeeded');
  const before={posts,sends,charges};const refresh=await invoke(['tasks','--refresh','--request-id','packed-original','--json']);assert.equal(refresh.code,0,refresh.stderr);const item=JSON.parse(refresh.stdout).result.items[0];assert.equal(item.run_id,'run-packed-original');assert.equal(item.state_stale,false);assert.deepEqual({posts,sends,charges},before);assert.equal(lookups,1);
  const readCount=reads;const invalid=await invoke(['run-status','run-packed-original','--wait','1']);assert.notEqual(invalid.code,0);assert.match(invalid.stderr,/rejects --wait/);assert.equal(reads,readCount);
  const skill=readFileSync(join(packageRoot,'skills/itpay-api/SKILL.md'),'utf8');for(const expected of ['terminal:false','next.read_only','Explicitly export ITPAY_STATE_DIR','does not accept `--wait`','unknown resume'])assert.ok(skill.includes(expected),expected);
  assert.deepEqual({posts,continues,sends,charges},{posts:2,continues:1,sends:1,charges:1});
  return {boundary:'installed bundle; synthetic loopback API and counters, not real financial or natural-host acceptance',original_admissions:1,original_continuations:continues,provider_sends:sends,charges,read_only_refreshes:lookups,timeout_recovery:'original run preserved, later GET only',run_status_wait:'rejected before GET'};
 }finally{if(completion)clearTimeout(completion);server.closeAllConnections();await new Promise(r=>server.close(r));}
}

export async function verifyHubConnectionRecoveryPackaged(packageRoot,scratch){
 const state=join(scratch,'original-connection-recovery');mkdirSync(state,{recursive:true,mode:0o700});
 let conflict=true;const calls={oauth:0,recovery:0,identity:0,business:0};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;res.setHeader('Content-Type','application/json');
  if(req.url==='/oauth2/token'){calls.oauth++;assert.equal(new URLSearchParams(raw).get('refresh_token'),'synthetic-original-refresh');res.end(JSON.stringify({access_token:'synthetic-recovered',refresh_token:'synthetic-rotated',token_type:'Bearer',expires_in:300}));return}
  if(req.url==='/v1/connection/recover'){calls.recovery++;assert.equal(req.headers.authorization,'Bearer synthetic-recovered');assert.deepEqual(JSON.parse(raw),{expected_buyer_id:'original-buyer',expected_consumer_id:'oauth:fixture-cli:original'});if(conflict){res.writeHead(409);res.end('{}');return}res.end(JSON.stringify({buyer_id:'original-buyer',consumer_id:'oauth:fixture-cli:original',status:'recovered'}));return}
  if(req.url==='/v1/me'){calls.identity++;res.end(JSON.stringify({buyer_id:'original-buyer',consumer_id:'oauth:fixture-cli:original'}));return}
  calls.business++;res.writeHead(500);res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const profilePath=join(state,'hub-credentials.'+createHash('sha256').update(base).digest('hex').slice(0,12)+'.json');
 const profile={base_url:base,subject:'original-buyer',consumer_id:'oauth:fixture-cli:original',client_id:'fixture-cli',token_url:base+'/oauth2/token',access_token:'synthetic-expired',refresh_token:'synthetic-original-refresh',expires_at:new Date(0).toISOString(),created_at:new Date().toISOString()};
 writeFileSync(profilePath,JSON.stringify({schema_version:'itpay.hub_credentials.v1',profiles:{default:profile}}),{mode:0o600});const before=readFileSync(profilePath);const task=join(state,'preserved-original-task.json');writeFileSync(task,'{"run_id":"original-fixture-run"}',{mode:0o600});const taskBefore=readFileSync(task);
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_')&&!k.startsWith('MONID_'))),ITPAY_STATE_DIR:state,ITPAY_AGENT_TYPE:'codex-desktop',ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base,ITPAY_HUB_OAUTH_CLIENT:'fixture-cli'};
 const invoke=()=>new Promise((done,reject)=>{const c=spawn(process.execPath,[join(packageRoot,'bin/itp.mjs'),'api','recover-connection','--json'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('exit',code=>done({code,out,err}))});
 try{
  const first=await invoke();assert.equal(first.code,1);assert.equal(JSON.parse(first.out).error.code,'connection_recovery_conflict');assert.deepEqual(readFileSync(profilePath),before);assert.ok(existsSync(profilePath+'.recovery.json'));assert.equal(calls.oauth,1);
  conflict=false;const second=await invoke();assert.equal(second.code,0,second.err);assert.equal(JSON.parse(second.out).result.original_binding_preserved,true);assert.equal(calls.oauth,1);assert.equal(calls.business,0);assert.equal(calls.recovery,2);assert.equal(calls.identity,1);assert.equal(existsSync(profilePath+'.recovery.json'),false);assert.equal(JSON.parse(readFileSync(profilePath,'utf8')).profiles.default.consumer_id,profile.consumer_id);assert.deepEqual(readFileSync(task),taskBefore);assert.ok(!JSON.stringify([first,second]).includes('synthetic-rotated'));
  return {boundary:'installed package, loopback synthetic OAuth and connection owner only',calls,original_tasks_unchanged:true,conflict_preserved_profile:true,rotated_candidate_reused:true,new_runs:0,dispatches:0,reservations:0,charges:0};
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
