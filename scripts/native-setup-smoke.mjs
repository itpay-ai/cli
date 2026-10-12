import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {mkdirSync,realpathSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const exec=promisify(execFile);

// Exercise actual npm entrances and compiled setup; only synthetic local accounts.
export async function verifyNativeSetup(tarball,scratch,previousTarball) {
 let status='login_required';const paths=[];
 const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://fixture').pathname;paths.push(path);
  let body;
  if(path==='/v1/agent-device-enrollments')body={agent_device_enrollment_id:'enr_fixture',challenge:'fixture'};
  else if(path==='/v1/agent-device-enrollments/enr_fixture/verify')body={agent_device_id:'adev_fixture',agent_device_key_id:'akey_fixture',quota_lineage_id:'qln_fixture',agent_instance_id:'ain_fixture',agent_type:'workbuddy'};
  else if(path==='/v1/agent-device-session-challenges')body={agent_device_session_challenge_id:'ses_fixture',challenge:'fixture'};
  else if(path==='/v1/agent-device-session-challenges/ses_fixture/verify')body={session_token:'synthetic-session',expires_at:'2099-01-01T00:00:00Z'};
  else if(path==='/v1/agent-device-account-bindings')body={status};
  else {res.writeHead(404);res.end('{}');return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;const proof=[];
 try {
  for(const global of [false,true]) {
   const root=join(scratch,global?'global tools & space':'managed tools & space');mkdirSync(root);
   const home=join(root,'home');mkdirSync(home);
   const env={...process.env,HOME:home,ITPAY_STATE_DIR:join(home,'.itpay-v3'),ITPAY_BACKEND_URL:base,ITPAY_CLI_DEV:'1',npm_config_cache:join(root,'npm-cache')};
   const args=['install','--prefix',root,...(global?['--global']:[]),'--offline','--ignore-scripts','--no-audit','--no-fund'];
   const packageRoot=join(root,...(global&&process.platform!=='win32'?['lib']:[]),'node_modules','@itpay','cli');
   const entry=join(packageRoot,'bin','itp.mjs');
   const invoke=(argv)=>exec(process.execPath,[entry,...argv],{env,timeout:30000});
   let oldKey; let upgradeRequestStart; let conflictProof;
   if(previousTarball){
    await exec('npm',[...args,previousTarball],{env,timeout:90000});
    await invoke(['auth','status','--agent-type','workbuddy','--json']);
    oldKey=readFileSync(join(env.ITPAY_STATE_DIR,'device','device-private.pem'));
    // Reproduce the concrete npm retirement collision, without user installation cleanup.
    const suffix=createHash('sha1').update(packageRoot).digest('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,8);
    const retirement=join(packageRoot,'..',`.cli-${suffix}`);mkdirSync(retirement);writeFileSync(join(retirement,'retained-fixture'),'old fixture');
    try {await exec('npm',[...args,tarball],{env,timeout:90000});assert.fail('retirement conflict must fail');}
    catch(error){assert(Number.isInteger(error.code) && error.code !== 0);assert.match(error.stderr,/ENOTEMPTY/);assert.deepEqual(readFileSync(join(env.ITPAY_STATE_DIR,'device','device-private.pem')),oldKey);conflictProof={code:'ENOTEMPTY',exit:error.code};}
    rmSync(retirement,{recursive:true}); // Only this test's explicit synthetic fixture.
    upgradeRequestStart=paths.length;
   }
   const installStart=performance.now();await exec('npm',[...args,tarball],{env,timeout:90000});
   const installationMs=Math.round(performance.now()-installStart);
   const setupStart=performance.now();const output=await invoke(['setup','--agent-type','workbuddy','--json']);
   const setupMs=Math.round(performance.now()-setupStart);const value=JSON.parse(output.stdout);
   assert.equal(value.status,'setup_ready');assert.equal(value.result.account_status,'login_required');assert.equal(value.next,null);
   assert.equal(output.stderr,'');if(previousTarball)assert.deepEqual(paths.slice(upgradeRequestStart),['/v1/agent-device-account-bindings']);assert.equal(value.result.skill_path,realpathSync(join(packageRoot,'skills','itpay','SKILL.md')));
   assert.equal(readFileSync(value.result.skill_path,'utf8'),readFileSync(join(packageRoot,'skills','itpay','SKILL.md'),'utf8'));
   const key=readFileSync(join(env.ITPAY_STATE_DIR,'device','device-private.pem'));if(oldKey)assert.deepEqual(key,oldKey);
   const requestsBefore=paths.length;
   status='authenticated';const plain=await invoke(['setup','--agent-type','workbuddy']);assert.match(plain.stdout,/已有账号授权/);
   const again=JSON.parse((await invoke(['setup','--agent-type','workbuddy','--json'])).stdout);
   assert.equal(again.result.account_status,'authenticated');assert.deepEqual(readFileSync(join(env.ITPAY_STATE_DIR,'device','device-private.pem')),key);
   assert.deepEqual(paths.slice(requestsBefore),['/v1/agent-device-account-bindings','/v1/agent-device-account-bindings']);status='login_required';
   const beforeInvalid=paths.length;
   for(const argv of [['setup','--json'],['setup','--agent-type','unsupported','--json']])await assert.rejects(()=>invoke(argv),e=>e.code===1&&JSON.parse(e.stdout).status==='error');
   assert.equal(paths.length,beforeInvalid);
   const skill=readFileSync(value.result.skill_path);rmSync(value.result.skill_path);
   await assert.rejects(()=>invoke(['setup','--agent-type','workbuddy','--json']),e=>e.code===1&&JSON.parse(e.stdout).error.code==='packaged_skill_unavailable');
   assert.equal(paths.length,beforeInvalid);writeFileSync(value.result.skill_path,skill);
   proof.push({mode:global?'global':'managed-prefix',version:value.result.cli_version,installationMs,setupMs,upgrade:!!previousTarball,...(conflictProof?{conflictProof}:{}),json:output.stdout,plain:plain.stdout});
  }
  assert(paths.every(p=>/^\/v1\/agent-device/.test(p)),'setup must not call login/business/liveness');
  return proof;
 } finally {await new Promise(resolve=>server.close(resolve));}
}
