import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HubTaskStore} from "../src/state/hub_tasks.js";
import {prepareHubInstallation,selectHubInstallation} from "../src/state/hub_installation.js";
import {shelfStatus} from "../src/commands/shelf.js";

test("status wait yields only a ready original Continue and never submits work",async()=>{
 const root=mkdtempSync(join(tmpdir(),"itpay-ready-continue-"));
 const names=["ITPAY_STATE_DIR","ITPAY_HUB_URL","ITPAY_HUB_KEY","ITPAY_HUB_TOKEN"];
 const before=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 let mode="ready",key="",reads=0,posts=0;
 const server=createServer((req,res)=>{
  res.setHeader("Content-Type","application/json");
  if(req.method!=="GET"){posts++;res.writeHead(500);res.end("{}");return;}
  reads++;
  const terminal=mode!=="ready"&&mode!=="unknown"&&reads>1;
  const intent={intent_id:"intent-"+mode,kind:"metered_api",status:terminal?"cancelled":"open",...(mode==="authorization"?{blocking_reason:"authorization_denied"}:mode==="key-choice"?{blocking_reason:"credential_unavailable"}:{})};
  const run={run_id:"run-"+mode,operation_id:"op-original",publication_id:"pub-original",execution_state:mode==="unknown"?"unknown":terminal?"succeeded":"in_flight",settlement_state:mode==="unknown"?"reconciling":terminal?"free":"held",delivery_state:"none"};
  res.end(JSON.stringify({request_id:key,terminal,...(mode==="in-flight"||mode==="unknown"?{run}:{intent}),...(mode==="key-choice"?{required_action:{target:"https://official.invalid/key"}}:{})}));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const address=server.address();assert.ok(address&&typeof address!=="string");
 process.env.ITPAY_STATE_DIR=root;process.env.ITPAY_HUB_URL=`http://127.0.0.1:${address.port}`;process.env.ITPAY_HUB_KEY="synthetic-ready-key";delete process.env.ITPAY_HUB_TOKEN;
 const installation=prepareHubInstallation(join(root,"installation"),join(process.cwd(),"src/main.ts"),null);selectHubInstallation(installation.selector);
 const output=process.stdout.write;let text="";
 process.stdout.write=((chunk:unknown)=>{if(typeof chunk!=="string")return output.call(process.stdout,chunk as Uint8Array);text+=chunk;return true}) as typeof process.stdout.write;
 try{
  const store=new HubTaskStore();
  for(mode of ["ready","authorization","key-choice","in-flight","unknown"]){
   const task=store.getOrCreate({operation_id:"op-original",publication_id:"pub-original",input:{mode}}).task;
   key=store.idempotencyKey(task.request_id);reads=0;text="";
   const started=Date.now();await shelfStatus(task.request_id,true,mode==="ready"||mode==="unknown"?120:1);
   const value=JSON.parse(text);
   if(mode==="ready"){
    assert.ok(Date.now()-started<3000,"ready Continue must not spend the 120-second read budget");
    assert.equal(reads,1);assert.equal(value.status,"pending");assert.match(value.instruction,/尚未执行/);assert.match(value.next.command,new RegExp(`call --pending ${task.request_id}`));
    assert.equal(store.get(task.request_id)?.terminal,false);
   }else if(mode==="unknown"){
    assert.equal(reads,1);assert.doesNotMatch(value.next?.command??"",/call/);
   }else assert.equal(reads,2,"blocked/ordinary status still waits for the original receipt");
   assert.equal(posts,0,"status never calls Continue or submits a supplier request");
  }
 }finally{
  process.stdout.write=output;
  for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name]}
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});
 }
});
