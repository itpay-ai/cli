import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
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
  const saved=store.get(task.request_id)!;
  assert.deepEqual(saved.input,{q:"frozen"});assert.equal(saved.publication_id,"pub-original");
  assert.equal(saved.credential_id,"credential-original");assert.equal(saved.source_credentials?.source?.expected_version,"v-original");
 }finally{
  process.stdout.write=output;
  for(const n of names){if(before[n]===undefined)delete process.env[n];else process.env[n]=before[n]}
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true});
 }
});
