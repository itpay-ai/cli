import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const moduleURL = new URL("../src/state/device_key.ts", import.meta.url).href;
function worker(root: string, phase: string): string {
 const path = join(root, `worker-${phase}.mjs`);
 writeFileSync(path, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
 const target=process.argv[2];const phase=process.argv[3];
 function stop(point){if(phase===point){process.send({barrier:point});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}
 for(const name of ['writeFileSync','linkSync','unlinkSync']){const original=fs[name];fs[name]=function(...args){const result=original.apply(this,args);if(String(args[0]).startsWith(target+'.'))stop(name);return result;};}syncBuiltinESMExports();
 const {createDeviceKey,deviceKeyThumbprint}=await import(${JSON.stringify(moduleURL)});
 process.send({ready:true});process.on('message',()=>{const key=createDeviceKey(target,false);process.send({thumbprint:deviceKeyThumbprint(key)});process.disconnect();});`);
 return path;
}
async function message(child: ReturnType<typeof fork>): Promise<{ready?: boolean; barrier?: string; thumbprint?: string}> {
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{finish();reject(new Error("worker barrier timeout"));},5000);
  const receive=(value:{ready?: boolean; barrier?: string; thumbprint?: string})=>{finish();resolve(value);};
  const exit=()=>{finish();reject(new Error("worker exited before barrier"));};
  const finish=()=>{clearTimeout(timer);child.off("message",receive);child.off("exit",exit);};
  child.once("message",receive);child.once("exit",exit);
 });
}
test("eight processes publish exactly one canonical key without overwriting it",async()=>{
 const root=mkdtempSync(join(tmpdir(),"itpay-key-process-"));
 const path=join(root,"private.pem");
 const script=worker(root,"normal");
 const children=Array.from({length:8},()=>fork(script,[path,"normal"],{execArgv:["--import","tsx"],stdio:["ignore","ignore","ignore","ipc"]}));
 try {
  await Promise.all(children.map(child=>message(child)));
  const outputs=children.map(child=>message(child));
  for(const child of children)child.send({go:true});
  const values=await Promise.all(outputs);
  for(const value of values)assert.match(value.thumbprint??"",/^[0-9a-f]{64}$/);
  assert.equal(new Set(values.map(value=>value.thumbprint)).size,1);
  const bytes=readFileSync(path);
  assert.match(bytes.toString(),/BEGIN PRIVATE KEY/);
  const {readDeviceKey,deviceKeyThumbprint}=await import("../src/state/device_key.js");
  assert.equal(deviceKeyThumbprint(readDeviceKey(path)!),values[0]?.thumbprint);
 }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
});
for(const phase of ["writeFileSync","linkSync","unlinkSync"]){
 test(`canonical key survives interrupted ${phase} without partial publication`,async()=>{
  const root=mkdtempSync(join(tmpdir(),"itpay-key-crash-"));
  const path=join(root,"private.pem");
  const child=fork(worker(root,phase),[path,phase],{execArgv:["--import","tsx"],stdio:["ignore","ignore","ignore","ipc"]});
  try{
   await message(child);const reached=message(child);child.send({go:true});
   assert.equal((await reached).barrier,phase);
   const before=existsSync(path)?readFileSync(path):undefined;
   const exit=once(child,"exit");child.kill("SIGKILL");await exit;
   const {createDeviceKey}=await import("../src/state/device_key.js");
   createDeviceKey(path,false);
   if(before)assert.deepEqual(readFileSync(path),before);
   assert.match(readFileSync(path,"utf8"),/BEGIN PRIVATE KEY/);
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
 });
}

test("cross-process cache writes preserve contexts and reject a late pre-recovery generation",async()=>{
 const {DeviceSessionCache}=await import("../src/state/device_session_cache.js");
 const root=mkdtempSync(join(tmpdir(),"itpay-cache-process-"));
 const script=join(root,"cache-worker.mjs");
 const cacheModule=new URL("../src/state/device_session_cache.ts",import.meta.url).href;
 writeFileSync(script,`import {DeviceSessionCache} from ${JSON.stringify(cacheModule)};const context=JSON.parse(process.argv[3]);const cache=new DeviceSessionCache(process.argv[2],context);const generation=cache.generation(true);process.send({ready:true});process.on('message',()=>{cache.write({deviceID:'fixture-device',deviceKeyID:'fixture-key',quotaLineageID:'fixture-lineage',agentInstances:{[context.agentType]:'fixture-instance'},sessions:{[context.agentType]:{token:context.backend,expiresAt:'2099-01-01T00:00:00Z'}}},generation);process.send({written:true});process.disconnect();});`);
 const contexts=[{backend:"https://dev.itpay.ai",agentType:"workbuddy",keyThumbprint:"fixture-key"},{backend:"https://app.itpay.ai",agentType:"codex-cli",keyThumbprint:"fixture-key"}];
 const directory=join(root,"sessions");
 const children=Array.from({length:8},(_,i)=>fork(script,[directory,JSON.stringify(contexts[i%2])],{execArgv:["--import","tsx"],stdio:["ignore","ignore","ignore","ipc"]}));
 try{
  await Promise.all(children.map(child=>message(child)));
  const responses=children.map(child=>message(child));for(const child of children)child.send({write:true});await Promise.all(responses);
  for(const context of contexts){const cache=new DeviceSessionCache(directory,context);assert.equal(cache.read()?.sessions[context.agentType]?.token,context.backend);}
  const dev=new DeviceSessionCache(directory,contexts[0]!);
  const late=fork(script,[directory,JSON.stringify(contexts[0])],{execArgv:["--import","tsx"],stdio:["ignore","ignore","ignore","ipc"]});children.push(late);
  await message(late); // generation was captured by the writer before recovery.
  dev.invalidate();dev.invalidate();
  const written=message(late);late.send({write:true});await written;
  assert.equal(dev.read(),undefined,"old generation cannot become usable after two recoveries");
  const prod=new DeviceSessionCache(directory,contexts[1]!);
  assert.equal(prod.read()?.sessions[contexts[1]!.agentType]?.token,contexts[1]!.backend);
 }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
});
