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
 const descriptor={operation_id:"op-fixture",api_id:"api-fixture",kind:"metered_api",display_name:"Fixture",
  summary:"Read a synthetic fixture",effect_class:"read_only",status:"published",execution_ready:true,
  current_publication_id:"pub-shown",shown_event_id:"123",price_card:{mode:"per_call",amount_atoms:"10000",unit:"page"},
  input_schema:{type:"object",properties:{q:{type:"string"}},required:["q"]},example_input:{q:"example"},result_retention_days:7};
 const run={run_id:"run-original",operation_id:"op-fixture",publication_id:"pub-shown",execution_state:"succeeded",
  settlement_state:"captured",delivery_state:"inline",captured_atoms:"10000",held_atoms:"0",result:{value:"original"}};
 const server=createServer(async(req,res)=>{
  res.setHeader("Content-Type","application/json");
  const path=(req.url??"").split("?")[0]!;
  if(path==="/v1/catalog/categories"){res.end(JSON.stringify({items:[{id:"data",slug:"Data",name:"数据",count:1},{id:"empty",slug:"Other",name:"其他",count:0}]}));return;}
  if(path==="/v1/catalog/operations"){res.end(JSON.stringify({items:[{operation_id:"op-fixture",display_name:"Fixture",summary:"Read a synthetic fixture",unit_price:{mode:"per_call",amount_atoms:"10000",unit:"page"}}],next_cursor:""}));return;}
  if(path==="/v1/catalog/operations/op-fixture"){shows++;res.end(JSON.stringify(descriptor));return;}
  if(path==="/v1/operations/op-fixture/runs"){
   let raw="";for await(const part of req)raw+=part;
   requestKey=String(req.headers["idempotency-key"]);
   posts.push({path,key:requestKey,body:JSON.parse(raw)});
   res.end(JSON.stringify(run));return;
  }
  if(path.startsWith("/v1/requests/")){
   statusReads++;
   const unknown=unknownNext;unknownNext=false;
   const pending=waitingReads-->0;
   res.end(JSON.stringify({request_id:requestKey,run:unknown?{...run,execution_state:"unknown",settlement_state:"reconciling"}:pending?{...run,execution_state:"in_flight",settlement_state:"held"}:run,terminal:!unknown&&!pending,pending_stage:null,next:null}));return;
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
  const list=await cli([...prefix,"list","--category","Data"]);assert.equal(list.value.result.items[0].price,"0.01 credit/页");assert.deepEqual(Object.keys(list.value.result.items[0]).sort(),["id","name","price","purpose"]);
  const missing=await cli([...prefix,"call","op-fixture","--input",'{"q":"actual"}']);
  assert.equal(missing.value.error.code,"show_required");assert.equal(posts.length,0);
  const shown=await cli([...prefix,"show","op-fixture"]);assert.equal(shown.value.status,"shown");assert.equal(shown.value.result.price,"0.01 credit/页");
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
  const blocked=await cli([...prefix,"call","op-fixture","--input",'{"q":"different"}']);
  assert.notEqual(blocked.code,0);assert.match(blocked.value.error.message,/task_conflict/);assert.equal(posts.length,1);
  for(const value of ["-1","121","1.5","invalid"]){
   const beforeInvalid=statusReads;
   const invalid=await cli([...prefix,"status",id,"--wait",value]);
   assert.notEqual(invalid.code,0);assert.equal(statusReads,beforeInvalid);
  }
  assert.equal(posts.length,1);assert.equal(shows,1);
  assert.deepEqual(posts[0]!.body,{expected_publication_id:"pub-shown",shown_event_id:"123",input:{q:"actual"},max_charge:{currency:"CNY",scale:6,amount_atoms:"10000"}});
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
  for(const old of ["discover","inspect","run","resume","tasks","continue","run-status","original-receipt","usage","transactions","topups","topup","topup-status","recover-connection"]){
   const p=await new Promise<number|null>(resolve=>{const child=spawn(process.execPath,["--import","tsx","src/main.ts",...prefix,old],{cwd:root,env,stdio:"ignore"});child.on("close",resolve)});
   assert.notEqual(p,0,old+" remains registered");
  }
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  rmSync(home,{recursive:true,force:true});
 }
});
