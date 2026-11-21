import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {prepareHubInstallation,selectHubInstallation} from "../src/state/hub_installation.js";
import {HubTaskStore} from "../src/state/hub_tasks.js";
import {shelfCall,shelfStatus} from "../src/commands/shelf.js";

test("original request recovery never dispatches unknown or foreign receipts and preserves first error",async()=>{
 const home=mkdtempSync(join(tmpdir(),"itpay-shelf-recovery-"));
 const names=["ITPAY_STATE_DIR","ITPAY_HUB_URL","ITPAY_HUB_KEY","ITPAY_HUB_TOKEN"];
 const before=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 let mode="unknown",key="",posts=0,reads=0;
 const server=createServer((req,res)=>{
  res.setHeader("Content-Type","application/json");
  if(req.method!=="GET"){posts++;res.writeHead(500);res.end('{}');return;}
  reads++;
  if(mode==="unavailable"){res.writeHead(503);res.end(JSON.stringify({error:{code:"unavailable",message:"fixture outage"}}));return;}
  if(mode==="absent"){res.writeHead(404);res.end(JSON.stringify({error:{code:"not_found",message:"no receipt"}}));return;}
  if(mode==="key-choice"){res.end(JSON.stringify({request_id:key,terminal:false,intent:{intent_id:"intent-key",kind:"metered_api",status:"open",blocking_reason:"credential_unavailable"},required_action:{type:"credential_choice",web_action:{target:"https://official.invalid/me/intents/intent-key/key"}}}));return;}
  if(mode.startsWith("changed")){res.end(JSON.stringify({request_id:key,terminal:true,intent:{intent_id:"intent-price",kind:"api_run",status:"cancelled",blocking_reason:"publication_changed"},price_change:{current_price:{currency:"CNY",scale:6,amount_atoms:"20000"},...(mode==="changed"?{captured_atoms:"0",held_atoms:"0"}:{})}}));return;}
  res.end(JSON.stringify({request_id:key,terminal:mode==="failed",run:{run_id:"run-original",operation_id:mode==="foreign"?"op-other":"op-original",publication_id:"pub-original",execution_state:mode==="failed"?"failed":"unknown",settlement_state:mode==="failed"?"released":"reconciling",delivery_state:"none",...(mode==="failed"?{held_atoms:"0",captured_atoms:"0",first_error:{code:"upstream_failed",message:"original failure"}}:{})}}));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const addr=server.address();assert.ok(addr&&typeof addr!=="string");
 process.env.ITPAY_STATE_DIR=home;process.env.ITPAY_HUB_URL=`http://127.0.0.1:${addr.port}`;process.env.ITPAY_HUB_KEY="synthetic-recovery-key";delete process.env.ITPAY_HUB_TOKEN;
 const store=new HubTaskStore();
 const task=store.getOrCreate({operation_id:"op-original",publication_id:"pub-original",input:{q:"frozen"},max_charge_atoms:"10000",credential_id:"credential-original",source_credentials:{source:{credential_id:"credential-versioned",expected_version:"v-original"}}}).task;
 key=store.idempotencyKey(task.request_id);
 const output=process.stdout.write;let raw="";
 process.stdout.write=((chunk:unknown)=>{if(typeof chunk!=="string")return output.call(process.stdout,chunk as Uint8Array);raw+=chunk;return true;}) as typeof process.stdout.write;
 try{
  await shelfCall(undefined,{pending:task.request_id,json:true});
  assert.equal(posts,0);assert.equal(reads,1);assert.equal(JSON.parse(raw).result.captured_atoms,null);
  raw="";mode="failed";await shelfStatus(task.request_id,true);
  const failed=JSON.parse(raw);assert.equal(failed.result.first_error.code,"upstream_failed");assert.match(failed.instruction,/未扣 credit/);
  mode="foreign";await assert.rejects(shelfStatus(task.request_id,true),/binding changed/);
  mode="unavailable";await assert.rejects(shelfStatus(task.request_id,true));
  mode="absent";await assert.rejects(shelfCall(undefined,{pending:task.request_id,json:true}));
  const priced=store.getOrCreate({operation_id:"op-original",publication_id:"pub-original",input:{q:"price"},max_charge_atoms:"10000"}).task;
  key=store.idempotencyKey(priced.request_id);mode="changed";raw="";await shelfStatus(priced.request_id,true);
  const receipt=JSON.parse(raw);assert.equal(receipt.handoff,undefined);assert.equal(receipt.result.current_price.currency,"CNY");assert.equal(receipt.result.current_price.amount_atoms,"20000");assert.equal(receipt.result.captured_atoms,"0");assert.match(receipt.instruction,/0.02 credit/);
  mode="changed-unverified";raw="";await shelfStatus(priced.request_id,true);
  assert.equal(JSON.parse(raw).result.captured_atoms,null);assert.doesNotMatch(JSON.parse(raw).instruction,/本次未扣 credit/);
  assert.equal(posts,0,"unknown and unavailable receipts must never cause a new admission");
  const choice=store.getOrCreate({operation_id:"op-original",publication_id:"pub-original",input:{q:"key"}}).task;
  key=store.idempotencyKey(choice.request_id);mode="key-choice";raw="";
  await shelfStatus(choice.request_id,true,0);
  const waiting=JSON.parse(raw);assert.equal(waiting.status,"credential_unavailable");assert.match(waiting.instruction,/等待原选择完成/);
  assert.equal(waiting.handoff.url,"https://official.invalid/me/intents/intent-key/key");assert.equal(waiting.result.captured_atoms,null);assert.equal(posts,0);
  const saved=store.get(task.request_id)!;
  assert.deepEqual(saved.input,{q:"frozen"});assert.equal(saved.publication_id,"pub-original");
  assert.equal(saved.credential_id,"credential-original");assert.equal(saved.source_credentials?.source?.expected_version,"v-original");
 }finally{
  process.stdout.write=output;
  for(const n of names){if(before[n]===undefined)delete process.env[n];else process.env[n]=before[n]}
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true});
 }
});

for(const mode of ["normal","busy","stop"])test("verified failed-zero owner recovery retains both receipts: "+mode,async()=>{
 const busy=mode==="busy";
 const home=mkdtempSync(join(tmpdir(),"itpay-linked-recovery-"));
 const names=["ITPAY_STATE_DIR","ITPAY_HUB_URL","ITPAY_HUB_KEY","ITPAY_HUB_TOKEN"],before=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 let key="",phase="failed",posts=0;
 const failed={run_id:"failed-root",operation_id:"op-original",publication_id:"pub-original",execution_state:"failed",settlement_state:"free",delivery_state:"not_ready",captured_atoms:"0",held_atoms:"0",first_error:{code:"upstream_error",message:"original rejected Key"}};
 const server=createServer((req,res)=>{
  res.setHeader("Content-Type","application/json");
  if(req.method==="POST"){
   assert.equal(req.url,"/v1/intents/int-recovery/continue");posts++;phase="succeeded";if(busy){res.writeHead(409);res.end(JSON.stringify({error:{code:"continuation_in_progress",message:"original continuation is already processing"}}))}else res.end('{}');return;
  }
  assert.equal(req.url,"/v1/requests/"+key);
  if(phase==="failed"){res.end(JSON.stringify({request_id:key,run:failed,terminal:true,pending_stage:null,next:null}));return;}
  res.end(JSON.stringify({request_id:key,intent_id:"int-recovery",intent:{intent_id:"int-recovery",kind:"metered_api",status:phase==="succeeded"?"completed":phase==="stopped"?"cancelled":"open",...(phase==="choice"?{blocking_reason:"credential_unavailable"}:{})},credential_recovery:{intent_id:"int-recovery",decision_id:phase==="choice"||phase==="stopped"?"0":"1234567890123456789",previous_run_ids:[failed.run_id],zero_effect_verified:true},previous_runs:[failed],terminal:phase==="succeeded"||phase==="stopped",pending_stage:phase==="choice"?"confirmation":null,next:null,...(phase==="choice"?{required_action:{target:"https://official.invalid/me/intents/int-recovery/key"}}:{}),...(phase==="succeeded"?{run:{...failed,run_id:"linked-root",execution_state:"succeeded",result:{answer:"retained result"}}}:{})}));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const addr=server.address();assert.ok(addr&&typeof addr!=="string");
 process.env.ITPAY_STATE_DIR=home;process.env.ITPAY_HUB_URL=`http://127.0.0.1:${addr.port}`;process.env.ITPAY_HUB_KEY="synthetic-linked-key";delete process.env.ITPAY_HUB_TOKEN;
 const installation=prepareHubInstallation(join(home,"installation"),join(process.cwd(),"src/main.ts"),null);selectHubInstallation(installation.selector);
 const store=new HubTaskStore(),task=store.getOrCreate({operation_id:"op-original",publication_id:"pub-original",input:{q:"frozen"},credential_id:"old-key"}).task;key=store.idempotencyKey(task.request_id);
 const output=process.stdout.write;let raw="";process.stdout.write=((chunk:unknown)=>{if(typeof chunk!=="string")return output.call(process.stdout,chunk as Uint8Array);raw+=chunk;return true}) as typeof process.stdout.write;
 try{
  await shelfStatus(task.request_id,true);assert.equal(store.get(task.request_id)?.terminal,true);
  phase="choice";raw="";await shelfStatus(task.request_id,true);const choice=JSON.parse(raw);assert.equal(choice.status,"credential_unavailable");assert.equal(choice.result.previous_runs[0].run_id,failed.run_id);assert.equal(posts,0);assert.equal(store.get(task.request_id)?.run_id,undefined);
  if(mode==="stop"){
   phase="stopped";raw="";await shelfStatus(task.request_id,true);const stopped=JSON.parse(raw);assert.equal(stopped.status,"stopped");assert.equal(stopped.result.captured_atoms,"0");assert.equal(stopped.result.held_atoms,"0");assert.equal(stopped.next,null);assert.match(stopped.instruction,/已停止.*未扣 credit/);assert.equal(posts,0);
   phase="ready";await assert.rejects(shelfStatus(task.request_id,true),/binding/);assert.equal(posts,0);return;
  }
  phase="ready";raw="";await shelfStatus(task.request_id,true,120);assert.match(JSON.parse(raw).next.command,new RegExp(`call --pending ${task.request_id}`));assert.equal(posts,0);
  raw="";await shelfCall(undefined,{pending:task.request_id,json:true});const result=JSON.parse(raw);assert.equal(result.status,"succeeded");assert.equal(result.result.run_id,"linked-root");assert.equal(result.result.previous_runs[0].run_id,failed.run_id);assert.equal(posts,1);
  raw="";await shelfStatus(task.request_id,true);assert.equal(posts,1);const saved=store.get(task.request_id)!;assert.equal(saved.input_digest,task.input_digest);assert.deepEqual(saved.input,task.input);assert.equal(saved.credential_id,"old-key");assert.deepEqual(saved.credential_recovery?.previous_run_ids,[failed.run_id]);
 }finally{process.stdout.write=output;for(const n of names){if(before[n]===undefined)delete process.env[n];else process.env[n]=before[n]}server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true})}
});
