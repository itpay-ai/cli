import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';

// Historical identity formats remain read-only. Old locks are opaque retained
// evidence, not a protocol this candidate uses or repairs. No old/new coexistence
// or unmodified old-client recovery claim is made.
export async function verifyPackedDeviceUpgrade(packageRoot,scratch) {
 const pair=generateKeyPairSync('ed25519');
 const registration={deviceID:'adev_fixture',deviceKeyID:'akey_fixture',quotaLineageID:'qln_fixture',agentInstances:{'codex-cli':'ain_fixture'},sessions:{'codex-cli':{token:'old-session-never-imported',expiresAt:'2099-01-01T00:00:00Z'}}};
 const script=join(scratch,'device-upgrade-worker.mjs');
 writeFileSync(script,`import {pathToFileURL} from 'node:url';const {DeviceAuthority}=await import(pathToFileURL(process.argv[2]));const a=new DeviceAuthority({baseURL:'https://app.itpay.ai',requestedAgentType:'codex-cli',compatibilityHeaders:{},statePath:process.argv[3],privateKeyPath:process.argv[4],fetchImpl:async(input)=>{const path=new URL(String(input)).pathname;if(path==='/v1/agent-device-enrollments')return Response.json({agent_device_enrollment_id:'enr_fixture',challenge:'fixture'});if(path==='/v1/agent-device-enrollments/enr_fixture/verify')return Response.json(${JSON.stringify({agent_device_id:registration.deviceID,agent_device_key_id:registration.deviceKeyID,quota_lineage_id:registration.quotaLineageID,agent_instance_id:'ain_fixture',agent_type:'codex-cli'})});if(path==='/v1/agent-device-session-challenges')return Response.json({agent_device_session_challenge_id:'ses_fixture',challenge:'fixture'});if(path.endsWith('/verify'))return Response.json({session_token:'fresh-session-fixture',expires_at:'2099-01-01T00:00:00Z'});throw Error('unexpected network');}});try{await a.recoverAuthorization();const headers=await a.authorizationHeaders({method:'GET',path:'/v1/orders',body:''});if(headers.Authorization!=='ItPayDevice fresh-session-fixture')throw Error('old session imported');process.stdout.write('ok');}catch(e){process.stdout.write(JSON.stringify({code:e.code,cause:e.causeCode,operation:e.operation}));process.exitCode=1;}`);
 const module=join(packageRoot,'dist/src/state/device_authority.js');
 const run=(state,key)=>execFileSync(process.execPath,[script,module,state,key],{encoding:'utf8',timeout:25000});
 for(const format of ['device.v1','next40','stable41']) {
  const dir=join(scratch,format);mkdirSync(dir);const state=join(dir,'identity.json'),key=join(dir,'private.pem');
  const original=format==='device.v1'?{schemaVersion:'itpay.device.v1',...registration}:{schemaVersion:'itpay.device.v2',registrations:{'https://app.itpay.ai':registration,'https://other.example.test':registration}};
  writeFileSync(state,JSON.stringify(original));writeFileSync(key,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  const stateBefore=readFileSync(state),keyBefore=readFileSync(key);
  mkdirSync(state+'.lock.stale');writeFileSync(state+'.lock.stale/history','old');writeFileSync(state+'.lock.released','old');
  for(let i=0;i<4;i++){assert.equal(run(state,key),'ok');assert.deepEqual(readFileSync(key),keyBefore);assert.deepEqual(readFileSync(state),stateBefore);}
  await Promise.all(Array.from({length:2},()=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[script,module,state,key]);let out='';child.stdout.on('data',x=>out+=x);child.on('error',reject);child.on('exit',code=>code===0&&out==='ok'?resolve():reject(Error('parallel cache renewal failed: '+out)));
  })));
  assert.deepEqual(readFileSync(key),keyBefore);assert.deepEqual(readFileSync(state),stateBefore);
  assert.equal(readFileSync(state+'.lock.stale/history','utf8'),'old');assert.equal(readFileSync(state+'.lock.released','utf8'),'old');
  for(const kind of ['directory','uuid-file','damaged-owner','exited-owner']) {
   const variant=join(dir,kind);mkdirSync(variant);
   const variantState=join(variant,'identity.json'),variantKey=join(variant,'private.pem');
   writeFileSync(variantState,stateBefore);writeFileSync(variantKey,keyBefore,{mode:0o600});
   const lock=variantState+'.lock';
   if(kind==='directory')mkdirSync(lock);else writeFileSync(lock,kind==='uuid-file'?randomUUID():kind==='exited-owner'?'99999999:deadbeef':'broken-owner');
   const before=kind==='directory'?undefined:readFileSync(lock);
   assert.equal(run(variantState,variantKey),'ok');
   assert.equal(existsSync(lock),true);
   if(before)assert.deepEqual(readFileSync(lock),before);else assert(statSync(lock).isDirectory());
   assert.deepEqual(readFileSync(variantKey),keyBefore);assert.deepEqual(readFileSync(variantState),stateBefore);
  }
 }
 process.stdout.write('packed read-only historical identity, fresh-session, repeat and concurrent-cache checks passed\n');
}
