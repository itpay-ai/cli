import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,utimesSync,cpSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';

// Equivalent historical fixtures: device.v1/v2 and UUID-only file locks are
// the published 2.1.40/41 format; the pre-file 2.0.x lock is an ownerless directory.
// Ownerless legacy locks intentionally stop: their process liveness is unprovable.
export async function verifyPackedDeviceUpgrade(packageRoot,scratch) {
 const next=join(scratch,'next-build');cpSync(packageRoot,next,{recursive:true});
 const pair=generateKeyPairSync('ed25519');
 const registration={deviceID:'adev_fixture',deviceKeyID:'akey_fixture',quotaLineageID:'qln_fixture',agentInstances:{'codex-cli':'ain_fixture'},sessions:{'codex-cli':{token:'fixture-only',expiresAt:'2099-01-01T00:00:00Z'}}};
 const script=join(scratch,'device-upgrade-worker.mjs');
 writeFileSync(script,`import {pathToFileURL} from 'node:url'; const {DeviceAuthority}=await import(pathToFileURL(process.argv[2])); const a=new DeviceAuthority({baseURL:'https://app.itpay.ai',requestedAgentType:'codex-cli',compatibilityHeaders:{},statePath:process.argv[3],privateKeyPath:process.argv[4],fetchImpl:async(input)=>{const path=new URL(String(input)).pathname;if(path==='/v1/agent-device-session-challenges')return new Response(JSON.stringify({agent_device_session_challenge_id:'ses_fixture',challenge:'fixture'}));if(path.endsWith('/verify'))return new Response(JSON.stringify({session_token:'fixture-only',expires_at:'2099-01-01T00:00:00Z'}));throw Error('unexpected enrollment or network');}}); try {await a.recoverAuthorization();await a.authorizationHeaders({method:'GET',path:'/v1/orders',body:''}); process.stdout.write('ok');} catch(e){process.stdout.write(JSON.stringify({code:e.code,cause:e.causeCode,operation:e.operation}));process.exitCode=1;}`);
 const module=root=>join(root,'dist/src/state/device_authority.js');
 const run=(root,state,key)=>execFileSync(process.execPath,[script,module(root),state,key],{encoding:'utf8',timeout:25000});
 for(const format of ['device.v1','next40','stable41']) {
  const dir=join(scratch,format);mkdirSync(dir);const state=join(dir,'identity.json'),key=join(dir,'private.pem');
  const original=format==='device.v1'?{schemaVersion:'itpay.device.v1',...registration}:{schemaVersion:'itpay.device.v2',registrations:{'https://app.itpay.ai':registration,'https://other.example.test':registration}};
  writeFileSync(state,JSON.stringify(original));writeFileSync(key,pair.privateKey.export({format:'pem',type:'pkcs8'}));const keyBefore=readFileSync(key);
  mkdirSync(state+'.lock.stale');writeFileSync(state+'.lock.stale/history','old');writeFileSync(state+'.lock.released','old');
  for(const root of [packageRoot,packageRoot,packageRoot,next]) {assert.equal(run(root,state,key),'ok');assert.deepEqual(readFileSync(key),keyBefore);const value=JSON.parse(readFileSync(state));const r=value.registrations['https://app.itpay.ai'];assert.equal(r.deviceID,registration.deviceID);assert.equal(r.quotaLineageID,registration.quotaLineageID);if(format!=='device.v1')assert.deepEqual(value.registrations['https://other.example.test'],registration);}
  assert.equal(readFileSync(state+'.lock.stale/history','utf8'),'old');assert.equal(readFileSync(state+'.lock.released','utf8'),'old');
  // Fresh processes share the on-disk protocol, never an in-memory promise.
  await Promise.all(Array.from({length:2},()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,module(next),state,key]);let out='';child.stdout.on('data',x=>out+=x);child.on('error',reject);child.on('exit',code=>code===0&&out==='ok'?resolve():reject(Error('parallel upgrade failed: '+out)));})));assert.deepEqual(readFileSync(key),keyBefore);
  for(const kind of ['directory','uuid-file','damaged-owner','exited-owner']) {
   const lock=state+'.lock'; if(kind==='directory')mkdirSync(lock);else writeFileSync(lock,kind==='uuid-file'?randomUUID():kind==='exited-owner'?'99999999:deadbeef':'broken-owner');const old=new Date(Date.now()-60000);utimesSync(lock,old,old);
   if(kind==='exited-owner')assert.equal(run(next,state,key),'ok');else {try{run(next,state,key);assert.fail('legacy must stop');}catch(e){assert.equal(e.status,1);const output=JSON.parse(e.stdout);assert.equal(output.cause,'LEGACY_LOCK_OWNER_UNKNOWN');assert.equal(output.operation,'inspect_lock');assert.equal(existsSync(lock),true);}}
   // Removing fixtures is safe here, never the user's identity or an operational lock.
   const {rmSync}=await import('node:fs');rmSync(lock,{recursive:true,force:true});assert.deepEqual(readFileSync(key),keyBefore);
  }
 }
 process.stdout.write('packed historical device upgrade/repeat/concurrency checks passed\n');
}
