import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {hubCredentialsPath,storeHubSession} from "../src/state/hub_credentials.js";
import {prepareHubInstallation,selectHubInstallation} from "../src/state/hub_installation.js";
import {HubTaskStore} from "../src/state/hub_tasks.js";
import {shelfCall,shelfStatus} from "../src/commands/shelf.js";

test("original undersized Device consent prepares one intent and never retries generic unknown",async()=>{
 const root=mkdtempSync(join(tmpdir(),"itpay-paid-consent-"));
 const names=["ITPAY_STATE_DIR","ITPAY_HUB_URL","ITPAY_HUB_KEY","ITPAY_HUB_TOKEN","ITPAY_HUB_OAUTH_ISSUER","ITPAY_HUB_OAUTH_CLIENT","ITPAY_HUB_OAUTH_SCOPE"];
 const previous=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 let mode="proof",requestKey="",admitted=false,posts=0;let submitted:unknown;
 const server=createServer(async(req,res)=>{
  res.setHeader("Content-Type","application/json");
  if(req.url==="/v1/me"){res.end(JSON.stringify({buyer_id:"buyer",consumer_id:"oauth:cli:original",device_approval_id:"device-original",authorization_id:"authorization-original"}));return;}
  if(req.method!=="GET"){
   posts++;assert.match(req.url??"",/^\/v1\/operations\/op-paid\/runs$/,"no continuation before new Device consent");assert.equal(req.headers["idempotency-key"],requestKey);
   let body="";for await(const part of req)body+=part;submitted=JSON.parse(body);admitted=true;
   res.writeHead(403);res.end(JSON.stringify({intent_id:"intent-original",kind:"metered_api",blocking_reason:"authorization_denied",status:"open"}));return;
  }
  if(admitted){res.end(JSON.stringify({request_id:requestKey,terminal:false,intent:{intent_id:"intent-original",kind:"metered_api",status:"open",blocking_reason:"authorization_denied"},required_action:{kind:"none",target:""}}));return;}
  res.writeHead(404);res.end(JSON.stringify({error:{code:"not_found",message:"unknown request",...(mode==="generic"?{}:{details:{request_admission:"not_admitted",request_id:mode==="foreign-request"?"cli-req-req_"+"0".repeat(32):requestKey,device_approval_id:mode==="foreign-device"?"device-other":"device-original",device_consent_limit_atoms:mode==="covered"?"70000":mode==="invalid-limit"?"-1":"10000"}})}}));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address();assert.ok(address&&typeof address!=="string");
 process.env.ITPAY_STATE_DIR=root;process.env.ITPAY_HUB_URL=`http://127.0.0.1:${address.port}`;delete process.env.ITPAY_HUB_KEY;delete process.env.ITPAY_HUB_TOKEN;
 const installation=prepareHubInstallation(join(root,"installation"),join(process.cwd(),"src/main.ts"),null);selectHubInstallation(installation.selector);mkdirSync(process.env.ITPAY_STATE_DIR!,{recursive:true});
 storeHubSession("synthetic-access",undefined,3600,"buyer",process.env.ITPAY_HUB_URL,process.env,"oauth:cli:original");
 const path=hubCredentialsPath();const credentials=JSON.parse(readFileSync(path,"utf8"));credentials.profiles.default.device_approval_id="device-original";credentials.profiles.default.authorization_id="authorization-original";writeFileSync(path,JSON.stringify(credentials),{mode:0o600});
 const store=new HubTaskStore();const task=store.getOrCreate({operation_id:"op-paid",publication_id:"pub-original",input:{query:"frozen"},max_charge_atoms:"70000",credential_mode:"platform"}).task;
 store.update(task.request_id,{status:"unknown"});requestKey=store.idempotencyKey(task.request_id);
 const output=process.stdout.write;let text="";process.stdout.write=((part:unknown)=>{text+=String(part);return true}) as typeof process.stdout.write;
 try{
  for(mode of ["generic","foreign-request","foreign-device","covered","invalid-limit"]){await assert.rejects(shelfStatus(task.request_id,true));await assert.rejects(shelfCall(undefined,{pending:task.request_id,json:true}));assert.equal(posts,0);}
  mode="proof";text="";await shelfStatus(task.request_id,true);const absent=JSON.parse(text);assert.equal(absent.status,"not_admitted");assert.match(absent.next.command,new RegExp(`call --pending ${task.request_id}`));assert.equal(posts,0,"status is always read-only");
  text="";await shelfCall(undefined,{pending:task.request_id,json:true});const blocked=JSON.parse(text);assert.equal(posts,1);assert.equal(blocked.result.intent_id,"intent-original");assert.match(blocked.next.command,new RegExp(`connect --request ${task.request_id}`));assert.equal(blocked.handoff,undefined);
  assert.deepEqual(submitted,{expected_publication_id:"pub-original",input:{query:"frozen"},credential_mode:"platform",max_charge:{currency:"CNY",scale:6,amount_atoms:"70000"}});
  const saved=store.get(task.request_id)!;assert.equal(saved.intent_id,"intent-original");assert.equal(saved.credential_mode,"platform");assert.deepEqual(saved.input,{query:"frozen"});
 }finally{process.stdout.write=output;for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name]}server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
