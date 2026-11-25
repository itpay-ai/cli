import {importHubKey} from "../src/state/hub_credentials.js";
import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {saveAgentTask,attachAgentRequest} from "../src/state/agent_task.js";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("..",import.meta.url));
test("six command shelf freezes shown facts and status never redispatches",async()=>{
 const home=mkdtempSync(join(tmpdir(),"itpay-shelf-"));
 const sentinel=join(home,"services-identity");writeFileSync(sentinel,"unchanged");
 const posts:Array<{path:string;key:string;body:any}>=[];
 let shows=0,requestKey="",waitingReads=0,statusReads=0,unknownNext=false;
 let runOverride:Record<string,unknown>={},terminalOverride:boolean|undefined,recoveryOverride=false,statusError=false;
 let rejectAdmission=false,admissionUnavailable=false,statusMissing=false;
 let beforeRequestReply:(()=>void)|undefined;
 const descriptor={operation_id:"op-fixture",api_id:"api-fixture",kind:"metered_api",display_name:"Fixture",
  summary:"Read a synthetic fixture",effect_class:"read_only",status:"published",execution_ready:true,
  shelf:"test",current_publication_id:"pub-shown",shown_event_id:"123",price_card:{price_version_id:"pv-shown",mode:"per_call",amount_atoms:"10000",unit:"page"},
  input_schema:{type:"object",properties:{q:{type:"string"}},required:["q"]},example_input:{q:"example"},result_retention_days:7};
 const run={run_id:"run-original",operation_id:"op-fixture",publication_id:"pub-shown",execution_state:"succeeded",
  settlement_state:"captured",delivery_state:"inline",captured_atoms:"10000",held_atoms:"0",result:{value:"original"}};
 const server=createServer(async(req,res)=>{
  res.setHeader("Content-Type","application/json");
  const path=(req.url??"").split("?")[0]!;
  if(path==="/v1/catalog/categories"){res.end(JSON.stringify({items:[{id:"data",slug:"Data",name:"数据",count:1},{id:"empty",slug:"Other",name:"其他",count:0}]}));return;}
  if(path==="/v1/catalog/operations"){res.end(JSON.stringify({items:[{operation_id:"op-fixture",display_name:"Fixture",summary:"Read a synthetic fixture",shelf:"test",unit_price:{mode:"per_call",amount_atoms:"10000",unit:"page"}},{operation_id:"op-public",display_name:"Public",summary:"Published product",shelf:"public"},{operation_id:"op-legacy",display_name:"Legacy",summary:"Older response"}],next_cursor:""}));return;}
  if(path==="/v1/catalog/operations/op-legacy"){res.end(JSON.stringify({...descriptor,operation_id:"op-legacy",shelf:undefined,current_publication_id:"pub-legacy",price_card:{mode:"free"}}));return;}
  if(path==="/v1/catalog/operations/op-fixture"){shows++;res.end(JSON.stringify(descriptor));return;}
  if(path==="/v1/operations/op-fixture/runs"){
   let raw="";for await(const part of req)raw+=part;
   requestKey=String(req.headers["idempotency-key"]);
   posts.push({path,key:requestKey,body:JSON.parse(raw)});
   if(admissionUnavailable){res.writeHead(503);res.end(JSON.stringify({error:{code:"admission_unavailable",message:"outcome not yet known"}}));return;}
   if(rejectAdmission){res.writeHead(400);res.end(JSON.stringify({error:{code:"invalid_input",message:"rejected before admission"}}));return;}
   res.end(JSON.stringify(run));return;
  }
  if(path.startsWith("/v1/requests/")){
   statusReads++;
   if(statusMissing){res.writeHead(404);res.end(JSON.stringify({error:{code:"not_found",message:"unknown request"}}));return;}
   if(statusError){res.writeHead(503);res.end(JSON.stringify({error:{code:"read_unavailable",message:"retain original"}}));return;}
   const hook=beforeRequestReply;beforeRequestReply=undefined;hook?.();
   const unknown=unknownNext;unknownNext=false;
   const pending=waitingReads-->0;
   res.end(JSON.stringify({request_id:requestKey,run:unknown?{...run,execution_state:"unknown",settlement_state:"reconciling"}:pending?{...run,execution_state:"in_flight",settlement_state:"held"}:{...run,...runOverride},terminal:terminalOverride??(!unknown&&!pending),...(recoveryOverride?{credential_recovery:{zero_effect_verified:true,intent_id:"intent-recovery"}}:{}),pending_stage:null,next:null}));return;
  }
  if(path==="/v1/me"){res.end(JSON.stringify({buyer_id:"fixture",key_id:"key-fixture",consumer_id:""}));return;}
  if(path==="/v1/me/wallet"){res.end(JSON.stringify({available:{currency:"CNY",scale:6,amount_atoms:"990000"},held:{currency:"CNY",scale:6,amount_atoms:"0"},topup_url:"https://official.invalid/me/wallet"}));return;}
  res.writeHead(404);res.end(JSON.stringify({error:{code:"not_found",message:"unexpected route"}}));
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();assert.ok(address&&typeof address!=="string");
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("ITPAY_"))),HOME:home,
  ITPAY_HUB_URL:"http://127.0.0.1:"+address.port,ITPAY_HUB_KEY:"itk_synthetic_shelf"};
 async function cli(args:string[]){
  return await new Promise<{code:number|null;value:any;err:string}>((resolve,reject)=>{
   const child=spawn(process.execPath,["--import","tsx","src/main.ts",...args,"--json"],{cwd:root,env});
   let raw="",err="";child.stdout.on("data",p=>raw+=p);child.stderr.on("data",p=>err+=p);
   child.on("error",reject);child.on("close",code=>{try{resolve({code,value:JSON.parse(raw),err})}catch(e){reject(e)}});
  });
 }
 try {
  const setup=await cli(["setup","--api-prefix",join(home,"installation")]);
  const selector=setup.value.result.selector;
  const profile=JSON.parse(readFileSync(selector,"utf8"));
  const agentRoot=dirname(dirname(selector));
  saveAgentTask(agentRoot,"query actual and different values","api",undefined);
  importHubKey("itk_synthetic_shelf",env.ITPAY_HUB_URL,{...env,ITPAY_STATE_DIR:join(profile.state_root,"hub-profiles",profile.profile_id)});
  const prefix=["api","--profile",selector];
  const categories=await cli([...prefix,"categories"]);assert.equal(categories.value.result.items[1].count,0);
  const list=await cli([...prefix,"list","--category","Data"]);assert.equal(list.value.result.items[0].price,"0.01 credit/页");assert.equal(list.value.result.items[0].shelf,"test");assert.equal(list.value.result.items[1].shelf,"public");assert.ok(!("shelf" in list.value.result.items[2]));
  const missing=await cli([...prefix,"call","op-fixture","--input",'{"q":"actual"}']);
  assert.equal(missing.value.error.code,"show_required");assert.equal(posts.length,0);
  const shown=await cli([...prefix,"show","op-fixture"]);assert.equal(shown.value.status,"shown");assert.equal(shown.value.result.price,"0.01 credit/页");
  assert.equal(shown.value.result.shelf,"test");
  assert.equal(shown.value.result.current_publication_id,"pub-shown");
  assert.equal(shown.value.result.price_version_id,"pv-shown");
  const legacy=await cli([...prefix,"show","op-legacy"]);
  assert.equal(legacy.value.status,"shown");
  assert.equal(legacy.value.result.current_publication_id,"pub-legacy");
  assert.ok(!("shelf" in legacy.value.result));
  assert.ok(!("price_version_id" in legacy.value.result));
  const called=await cli([...prefix,"call","op-fixture","--input",'{"q":"actual"}']);
  assert.equal(called.value.status,"succeeded");
  assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,undefined,"terminal paid receipt releases active pointer");
  assert.equal(called.value.result.captured_atoms,"10000");
  const id=called.value.result.request_id;
  assert.equal(called.value.next,null,"terminal success has no redundant next step");
  await cli([...prefix,"status",id]);await cli([...prefix,"status",id]);
  await cli([...prefix,"call","--pending",id]);
  const beforeReads=statusReads;
  waitingReads=1;
  const waited=await cli([...prefix,"status",id,"--wait","1"]);
  assert.equal(waited.value.status,"succeeded");assert.equal(statusReads,beforeReads+2);
  attachAgentRequest(selector,id);
  unknownNext=true;
  const beforeUnknown=statusReads,started=Date.now();
  const uncertain=await cli([...prefix,"status",id,"--wait","120"]);
  assert.equal(uncertain.value.status,"pending");assert.ok(uncertain.value.next.command.includes(selector));assert.match(uncertain.value.next.command,new RegExp("status "+id));assert.equal(statusReads,beforeUnknown+1);assert.ok(Date.now()-started<10000);
  assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,id);
  runOverride={execution_state:"unknown",settlement_state:"reconciling"};terminalOverride=false;
  const blocked=await cli([...prefix,"call","op-fixture","--input",'{"q":"different"}']);
  assert.notEqual(blocked.code,0);assert.match(blocked.value.error.message,/task_conflict/);assert.equal(posts.length,1);assert.equal(blocked.value.error.code,"task_conflict");assert.equal(blocked.value.result.request_id,id);assert.ok(blocked.value.next.command.includes(selector));assert.match(blocked.value.next.command,new RegExp("status "+id));assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,id);
  for(const value of ["-1","121","1.5","invalid"]){
   const beforeInvalid=statusReads;
   const invalid=await cli([...prefix,"status",id,"--wait",value]);
   assert.notEqual(invalid.code,0);assert.equal(statusReads,beforeInvalid);
  }
  assert.equal(posts.length,1);assert.equal(shows,1);
  assert.deepEqual(posts[0]!.body,{expected_publication_id:"pub-shown",shown_event_id:"123",input:{q:"actual"},max_charge:{currency:"CNY",scale:6,amount_atoms:"10000"}});
  runOverride={};terminalOverride=undefined;
  await cli([...prefix,"status",id]);
  const again=await cli([...prefix,"call","op-fixture","--input",'{"q":"different"}']);
  assert.notEqual(again.value.result.request_id,id);assert.equal(posts.length,2);assert.equal(shows,1);
  assert.equal(posts[1]!.body.shown_event_id,"123");assert.notEqual(posts[1]!.key,posts[0]!.key);
  const platform=await cli([...prefix,"call","op-fixture","--input",'{"q":"platform"}',"--credential-mode","platform"]);
  assert.equal(platform.value.status,"succeeded");assert.equal(posts.length,3);assert.equal(posts[2]!.body.credential_mode,"platform");
  const changedMode=await cli([...prefix,"call","--pending",platform.value.result.request_id,"--credential-mode","platform"]);
  assert.notEqual(changedMode.code,0);assert.equal(posts.length,3);
  const invalidMode=await cli([...prefix,"call","op-fixture","--input","{}","--credential-mode","invalid"]);
  assert.notEqual(invalidMode.code,0);assert.equal(posts.length,3);
  assert.equal((await cli([...prefix,"wallet"])).value.result.topup_url,"https://official.invalid/me/wallet");
  assert.equal(readFileSync(sentinel,"utf8"),"unchanged");
  // Only canonical settled zero-charge failure/cancellation releases an old
  // pointer. Status stays GET-only, retains the original receipt and cannot
  // replace a concurrently attached different original.
  const last=platform.value.result.request_id;
  for(const state of [
   {execution_state:"unknown",settlement_state:"reconciling",captured_atoms:"0",held_atoms:"0"},
   {execution_state:"in_flight",settlement_state:"held",captured_atoms:"0",held_atoms:"10000"},
   {execution_state:"failed",settlement_state:"captured",captured_atoms:"10000",held_atoms:"0"},
   {execution_state:"failed",settlement_state:"released",captured_atoms:"1",held_atoms:"0"},
   {execution_state:"failed",settlement_state:"released",captured_atoms:"0",held_atoms:"1"},
   {execution_state:"failed",settlement_state:"reserved",captured_atoms:"0",held_atoms:"0"},
   {execution_state:"failed",settlement_state:"released",captured_atoms:null,held_atoms:"0"},
   {execution_state:"failed",settlement_state:"released",captured_atoms:"0",held_atoms:null},
  ]){
   attachAgentRequest(selector,last);runOverride=state;
   const before:number=posts.length;await cli([...prefix,"status",last]);assert.equal(posts.length,before);assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,last);
  }
  runOverride={execution_state:"failed",settlement_state:"released",captured_atoms:"0",held_atoms:"0"};terminalOverride=false;
  await cli([...prefix,"status",last]);assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,last);terminalOverride=undefined;
  for(const execution of ["failed","cancelled"]){
   attachAgentRequest(selector,last);runOverride={execution_state:execution,settlement_state:"released",captured_atoms:"0",held_atoms:"0"};
   const before:number=posts.length;const read=await cli([...prefix,"status",last]);assert.equal(read.code,0);assert.equal(posts.length,before);assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,undefined);assert.equal(read.value.result.request_id,last);
  }
  // Simulate an older installation that has not re-read its settled failure:
  // the explicit new call reconciles the original once, never re-posts it.
  attachAgentRequest(selector,last);
  const beforeNew:number=posts.length,readsBeforeNew:number=statusReads;const nextQuery=await cli([...prefix,"call","op-fixture","--input",'{"q":"after safe failure"}']);assert.equal(nextQuery.code,0);assert.notEqual(nextQuery.value.result.request_id,last);assert.equal(posts.length,beforeNew+1);assert.notEqual(posts.at(-1)!.key,posts[2]!.key);assert.equal(posts.at(-1)!.body.input.q,"after safe failure");assert.equal(statusReads,readsBeforeNew+2,"one old canonical GET and one new receipt GET");
  const current=nextQuery.value.result.request_id;attachAgentRequest(selector,current);
  statusError=true;const beforeUnavailable:number=posts.length,readsBeforeUnavailable:number=statusReads;const unavailable=await cli([...prefix,"call","op-fixture","--input",'{"q":"read unavailable"}']);assert.notEqual(unavailable.code,0);assert.equal(unavailable.value.result.request_id,current);assert.equal(posts.length,beforeUnavailable);assert.equal(statusReads,readsBeforeUnavailable+1);assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,current);statusError=false;
  beforeRequestReply=()=>{attachAgentRequest(selector,current,true);attachAgentRequest(selector,last)};
  const beforeRace:number=posts.length;const raced=await cli([...prefix,"call","op-fixture","--input",'{"q":"concurrent new pointer"}']);assert.notEqual(raced.code,0);assert.equal(raced.value.error.code,"task_conflict");assert.equal(raced.value.result.request_id,last);assert.equal(raced.value.result.operation_id,"op-fixture");assert.equal(posts.length,beforeRace);assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,last,"late original read must not clear or replace peer pointer");
  attachAgentRequest(selector,last,true);attachAgentRequest(selector,current);recoveryOverride=true;
  await cli([...prefix,"status",current]);assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,current);
  attachAgentRequest(selector,current,true);recoveryOverride=false;
  rejectAdmission=true;
  const rejected=await cli([...prefix,"call","op-fixture","--input",'{"q":"rejected"}']);
  assert.equal(rejected.value.error.code,"invalid_input");assert.equal(rejected.value.result.operation_id,"op-fixture");
  assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,undefined);
  rejectAdmission=false;admissionUnavailable=true;
  const noReceipt=await cli([...prefix,"call","op-fixture","--input",'{"q":"unknown before receipt"}']);
  assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,noReceipt.value.result.request_id);
  admissionUnavailable=false;statusMissing=true;
  const beforeMissing=posts.length;
  const confirmedAbsent=await cli([...prefix,"status",noReceipt.value.result.request_id]);
  assert.equal(confirmedAbsent.value.error.code,"not_found");
  assert.equal(posts.length,beforeMissing);
  assert.equal(JSON.parse(readFileSync(join(agentRoot,"task.json"),"utf8")).request_id,undefined);
  statusMissing=false;
  for(const old of ["discover","inspect","run","resume","tasks","continue","run-status","original-receipt","usage","transactions","topups","topup","topup-status","recover-connection"]){
   const p=await new Promise<number|null>(resolve=>{const child=spawn(process.execPath,["--import","tsx","src/main.ts",...prefix,old],{cwd:root,env,stdio:"ignore"});child.on("close",resolve)});
   assert.notEqual(p,0,old+" remains registered");
  }
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  rmSync(home,{recursive:true,force:true});
 }
});
