// Installed bundle, isolated state, loopback-only synthetic ownership/ledger.
// Exercise real SDK deadlines; never use a live Hub, grant or money.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

export async function verifyHubRecoveryPackaged(packageRoot,scratch){
 const state=join(scratch,'hub-recovery-state');mkdirSync(state,{recursive:true,mode:0o700});
 let reads=0,posts=0,mode='unknown';
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method!=='GET'){posts++;res.writeHead(500);res.end('{}');return}
  reads++;
  if(mode==='unavailable'){res.writeHead(503);res.end(JSON.stringify({error:{code:'unavailable',message:'fixture outage'}}));return}
  res.end(JSON.stringify({request_id:'cli-req-packed-original',terminal:mode==='succeeded',run:{run_id:'run-original',operation_id:'op-packed',publication_id:'pub-packed',execution_state:mode,settlement_state:mode==='unknown'?'reconciling':'captured',delivery_state:'inline',...(mode==='succeeded'?{held_atoms:'0',captured_atoms:'10000',result:{fixture:true}}:{})}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_')&&!k.startsWith('MONID_'))),ITPAY_STATE_DIR:state,ITPAY_HUB_URL:base,ITPAY_HUB_KEY:'itk_synthetic_packed_recovery'};
 const scope='scope-'+createHash('sha256').update(JSON.stringify([base,'key:'+env.ITPAY_HUB_KEY])).digest('hex');
 const dir=join(state,'hub-tasks',scope);mkdirSync(dir,{recursive:true,mode:0o700});
 const path=join(dir,'packed-original.json');
 const task={request_id:'packed-original',operation_id:'op-packed',publication_id:'pub-packed',input:{},input_digest:createHash('sha256').update(['op-packed','pub-packed','{}','10000'].join('\0')).digest('hex'),max_charge_atoms:'10000',status:'unknown',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),hub_origin:base,key_prefix:env.ITPAY_HUB_KEY.slice(0,14)};
 writeFileSync(path,JSON.stringify(task),{mode:0o600});
 const invoke=args=>new Promise((done,reject)=>{const c=spawn(process.execPath,[join(packageRoot,'bin/itp.mjs'),'api',...args,'--json'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('exit',code=>done({code,value:JSON.parse(out),err}))});
 try{
  const unknown=await invoke(['call','--pending','packed-original']);assert.equal(unknown.code,0);assert.equal(unknown.value.result.captured_atoms,null);assert.equal(posts,0);
  mode='unavailable';assert.equal((await invoke(['status','packed-original'])).code,1);
  mode='succeeded';const completed=await invoke(['status','packed-original']);assert.equal(completed.code,0);assert.equal(completed.value.result.run_id,'run-original');assert.equal(completed.value.result.captured_atoms,'10000');
  await invoke(['call','--pending','packed-original']);assert.equal(posts,0);assert.equal(reads,4);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).publication_id,'pub-packed');
  const skill=readFileSync(join(packageRoot,'skills/itpay-api/SKILL.md'),'utf8');assert.ok(skill.includes('call --pending'));assert.ok(!skill.includes('api resume'));
  return {boundary:'installed bundle; synthetic original receipt, no financial acceptance',reads,posts,unknown_read_only:true,original_binding_preserved:true};
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}

export async function verifyHubConnectionRecoveryPackaged(packageRoot,scratch){
 let state=join(scratch,'original-connection-recovery');mkdirSync(state,{recursive:true,mode:0o700});
 let conflict=true;const calls={oauth:0,recovery:0,identity:0,business:0};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;res.setHeader('Content-Type','application/json');
  if(req.url==='/oauth2/token'){calls.oauth++;assert.equal(new URLSearchParams(raw).get('refresh_token'),'synthetic-original-refresh');res.end(JSON.stringify({access_token:'synthetic-recovered',refresh_token:'synthetic-rotated',token_type:'Bearer',expires_in:300}));return}
  if(req.url==='/v1/connection/recover'){calls.recovery++;assert.equal(req.headers.authorization,'Bearer synthetic-recovered');assert.deepEqual(JSON.parse(raw),{expected_buyer_id:'original-buyer',expected_consumer_id:'oauth:fixture-cli:original'});if(conflict){res.writeHead(409);res.end('{}');return}res.end(JSON.stringify({buyer_id:'original-buyer',consumer_id:'oauth:fixture-cli:original',status:'recovered'}));return}
  if(req.url==='/v1/me'){calls.identity++;res.end(JSON.stringify({buyer_id:'original-buyer',consumer_id:'oauth:fixture-cli:original'}));return}
  calls.business++;res.writeHead(500);res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const setupEnv={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_'))),ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base,ITPAY_HUB_OAUTH_CLIENT:'fixture-cli'};
 const setup=spawnSync(process.execPath,[join(packageRoot,'bin/itp.mjs'),'setup','--api-prefix',join(scratch,'legacy-api-install'),'--json'],{env:setupEnv,encoding:'utf8'});assert.equal(setup.status,0,setup.stderr);
 const selector=JSON.parse(setup.stdout).result.selector;const installation=JSON.parse(readFileSync(selector,'utf8'));state=join(installation.state_root,'hub-profiles',installation.profile_id);mkdirSync(state,{recursive:true,mode:0o700});
 const profilePath=join(state,'hub-credentials.'+createHash('sha256').update(base).digest('hex').slice(0,12)+'.json');
 const profile={base_url:base,subject:'original-buyer',consumer_id:'oauth:fixture-cli:original',client_id:'fixture-cli',token_url:base+'/oauth2/token',access_token:'synthetic-expired',refresh_token:'synthetic-original-refresh',expires_at:new Date(0).toISOString(),created_at:new Date().toISOString()};
 writeFileSync(profilePath,JSON.stringify({schema_version:'itpay.hub_credentials.v1',profiles:{default:profile}}),{mode:0o600});const before=readFileSync(profilePath);const task=join(state,'preserved-original-task.json');writeFileSync(task,'{"run_id":"original-fixture-run"}',{mode:0o600});const taskBefore=readFileSync(task);
 const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_')&&!k.startsWith('MONID_'))),ITPAY_STATE_DIR:state,ITPAY_AGENT_TYPE:'codex-desktop',ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base,ITPAY_HUB_OAUTH_CLIENT:'fixture-cli'};
 writeFileSync(profilePath+'.recovery.json',JSON.stringify({binding:{base_url:base,subject:profile.subject,consumer_id:profile.consumer_id,client_id:profile.client_id,token_url:profile.token_url},phase:'candidate',profile}),{mode:0o600});
 const invoke=()=>new Promise((done,reject)=>{const c=spawn(process.execPath,[join(packageRoot,'bin/itp.mjs'),'api','--profile',selector,'connect','--json'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('exit',code=>done({code,out,err}))});
 try{
  const first=await invoke();assert.equal(first.code,1);assert.equal(JSON.parse(first.out).error.code,'connection_recovery_conflict');assert.deepEqual(readFileSync(profilePath),before);assert.ok(existsSync(profilePath+'.recovery.json'));assert.equal(calls.oauth,1);
  conflict=false;const second=await invoke();assert.equal(second.code,0,second.err);assert.equal(JSON.parse(second.out).status,'connected');assert.equal(calls.oauth,1);assert.equal(calls.business,0);assert.equal(calls.recovery,2);assert.equal(calls.identity,1);assert.equal(existsSync(profilePath+'.recovery.json'),false);assert.equal(JSON.parse(readFileSync(profilePath,'utf8')).profiles.default.consumer_id,profile.consumer_id);assert.deepEqual(readFileSync(task),taskBefore);assert.ok(!JSON.stringify([first,second]).includes('synthetic-rotated'));
  return {boundary:'installed package, loopback synthetic OAuth and connection owner only',calls,original_tasks_unchanged:true,conflict_preserved_profile:true,rotated_candidate_reused:true,new_runs:0,dispatches:0,reservations:0,charges:0};
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
