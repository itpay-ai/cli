import test from 'node:test';
import {shellArgument} from '../src/services/shared/envelope.js';
import assert from 'node:assert/strict';
import {Command} from 'commander';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {hubCredentialsPath,storeHubSession} from '../src/state/hub_credentials.js';
import {HubTaskStore,hubTasksDir} from '../src/state/hub_tasks.js';
import {registerAPICommands} from '../src/commands/api_commands.js';
import {spawnSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
test('api and hub are one registration object, with original Services entry intact',()=>{
 const program=new Command();registerAPICommands(program);
 assert.equal(program.commands.length,1);
 const api=program.commands[0]!;assert.equal(api.name(),'api');assert.deepEqual(api.aliases(),['hub']);
 for(const cmd of ['connect','categories','list','show','call','status','wallet','admin']) assert.ok(api.commands.some(c=>c.name()===cmd),cmd);
 for(const group of ['api','hub','services']) {
  const p=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','src/main.ts',group,'--help'],{cwd:root,encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/Usage:/);
  if(group!=='services'){assert.match(p.stdout,/categories/);assert.doesNotMatch(p.stdout,/service_execution_id|rail-booking/)}
  else assert.match(p.stdout,/purchase/);
 }
});

// Exercise the actual registered API boundary, not a second CLI implementation.
// Every endpoint is loopback and all payment/identity facts are synthetic.

async function deviceFixture(identityStatus = 200, handle = "synthetic-handle-001", refreshStatus?: number, unified=true, approvalRequired=false) {
 const home=mkdtempSync(join(tmpdir(),"itpay-device-contract-"));
 const binding={buyer_id:"fixture-buyer",consumer_id:"oauth:fixture-public-cli:original",device_approval_id:"approval",authorization_id:"generation"};
 let exchangeReady=true;
 let denied=false,ready=false,resource="",starts=0,exchanges=0,probes=0,commonStarts=0;let commonKey:ReturnType<typeof createPublicKey>|undefined;
 let originalConsumer: string | undefined;
 const server=createServer(async(req,res)=>{
  res.setHeader("Content-Type","application/json");
  if(req.url==="/v1/agent-connections/start") {
   if(!unified){res.writeHead(404);res.end("{}");return;}
   commonStarts++;
   let raw="";for await(const part of req)raw+=part;
   const body=JSON.parse(raw);const key=createPublicKey({key:{kty:"OKP",crv:"Ed25519",x:body.public_key},format:"jwk"});
   if(commonKey)assert.deepEqual(key.export({format:"jwk"}),commonKey.export({format:"jwk"}));commonKey=key;
   const message=["itpay-agent-connection/v1","POST",req.url,createHash("sha256").update(raw).digest("hex"),req.headers["x-itpay-connection-time"],req.headers["x-itpay-connection-nonce"]].join("\n");
   assert.ok(verify(null,Buffer.from(message),key,Buffer.from(String(req.headers["x-itpay-connection-proof"]),"base64url")));
   res.end(JSON.stringify({connection_id:"acn_fixture",agent_type:"muse",enabled_surfaces:ready?["services","api"]:["api"],buyer_id:ready?"fixture-buyer":"",status:denied?"denied":ready?"active":"pending",...((ready||denied)?{}:{url:resource+"/agent/connect/acn_fixture?start_token=synthetic-link"})}));return;
  }
  if(req.url==="/v1/agent-connections/acn_fixture/hub"){
   starts++;assert.ok(ready);binding.buyer_id=resource+"|fixture-buyer";
   res.end(JSON.stringify({handle,device_code:"synthetic-device-code",poll_proof:"synthetic-poll-proof",verification_uri_complete:resource+"/verify",expires_in:120,interval:1,...(approvalRequired?{approval_required:true}:{})}));return;
  }
  if(req.url?.startsWith("/v1/agent-device")||req.url?.startsWith("/v1/agent-connections/acn_fixture/services"))throw new Error("API path touched Services");
  if(req.url==="/v1/oauth/device/start") {
   starts++;
   let raw="";for await(const part of req)raw+=part;
   const body=JSON.parse(raw);
   assert.equal(body.client_id,"fixture-public-cli");
   assert.equal(body.resource,resource);
   originalConsumer=body.original_consumer_id;
   res.end(JSON.stringify({handle,device_code:"synthetic-device-code",poll_proof:"synthetic-poll-proof",
    verification_uri_complete:resource+"/verify",expires_in:120,interval:1,...(approvalRequired?{approval_required:true}:{})}));
   return;
  }
  if(req.url===`/v1/oauth/device/${handle}/status`) {
   assert.equal(req.headers.authorization,"Bearer synthetic-poll-proof");
   res.end(JSON.stringify(ready&&exchangeReady?{phase:"ready_to_exchange",...binding}:{phase:"pending"}));
   return;
  }
  if(req.url==="/oauth2/token") {
   let raw="";for await(const part of req)raw+=part;
   const form=new URLSearchParams(raw);
   if(form.get("grant_type")==="refresh_token" && refreshStatus) {
    res.writeHead(refreshStatus);
    res.end(JSON.stringify({error:refreshStatus===400?"invalid_grant":"temporarily_unavailable"}));
    return;
   }
   exchanges++;
   assert.equal(form.get("grant_type"),"urn:ietf:params:oauth:grant-type:device_code");
   assert.equal(form.get("device_code"),"synthetic-device-code");
   assert.equal(form.get("resource"),resource);
   res.end(JSON.stringify({access_token:"synthetic-device-access",refresh_token:"synthetic-refresh",token_type:"Bearer",expires_in:300}));
   return;
  }
  if(req.url==="/v1/me") {
   probes++;
   assert.equal(req.headers.authorization,"Bearer synthetic-device-access");
   assert.equal(req.headers["x-itpay-oauth-resource"],resource);
   res.writeHead(identityStatus);
   res.end(JSON.stringify(identityStatus===200?binding:{}));
   return;
  }
  res.writeHead(404);res.end("{}");
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();
 assert.ok(address&&typeof address!=="string");
 resource="http://127.0.0.1:"+address.port;
 const env:NodeJS.ProcessEnv={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("ITPAY_")&&!["CODEX_THREAD_ID","CLAUDECODE","MUSE_SESSION_ID","DOT_SESSION_ID","WORKBUDDY_SESSION_ID"].includes(key))),
  HOME:home,NODE_OPTIONS:"--import "+join(root,"node_modules/tsx/dist/loader.mjs"),ITPAY_AGENT_TYPE:"muse",ITPAY_CLI_DEV:"1",ITPAY_STATE_DIR:home,ITPAY_BACKEND_URL:resource,ITPAY_HUB_URL:resource,ITPAY_HUB_OAUTH_ISSUER:resource,ITPAY_HUB_OAUTH_CLIENT:"fixture-public-cli"};
 writeFileSync(join(home,'itpay'),'#!/bin/sh\nexec '+shellArgument(process.execPath)+' --import tsx '+shellArgument(join(root,'src/main.ts'))+' "$@"\n',{mode:0o700});
 env.PATH=home+':'+(process.env.PATH??'');
 function cli(args:string[]):Promise<{code:number|null;value:any;output:string}> {
  return new Promise((resolve,reject)=>{
   const boundary = args.indexOf("--");
   const argv = boundary < 0 ? [...args, "--json"] : [...args.slice(0, boundary), "--json", ...args.slice(boundary)];
   const child=spawn(process.execPath,["--import","tsx","src/main.ts",...argv],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
   let output="";
   child.stdout.on("data",part=>output+=part);
   child.on("error",reject);
   const deadline=setTimeout(()=>{child.kill("SIGTERM");reject(new Error("Device command timed out"))},15_000);
   child.on("close",code=>{clearTimeout(deadline);try{resolve({code,value:JSON.parse(output.split(/\n(?=\{)/).at(-1)!),output})}catch(err){reject(err)}});
  });
 }
 async function setup() {
  const result=await cli(["setup","--api-prefix",join(home,"installation")]);
  assert.equal(result.code,0);
  const selector=result.value.result.selector as string;
  const profileID=result.value.result.profile_id as string;
  return {selector,state:join(home,"installation","state","hub-profiles",profileID)};
 }
 async function close() {
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  rmSync(home,{recursive:true});
 }
 return {env,resource,handle,binding,cli,setup,close,approve:()=>{ready=true},deny:()=>{denied=true},
  holdExchange:()=>{exchangeReady=false},releaseExchange:()=>{exchangeReady=true},
  calls:()=>({starts,exchanges,probes,originalConsumer,commonStarts})};
}

test("Device connect exchanges only after approval and verifies before saving",async()=>{
 const f=await deviceFixture(200, "-synthetic-handle-001",undefined,false);
 try {
  const {selector,state}=await f.setup();
  const api=["api","--profile",selector,"connect"];
  const pending=await f.cli(api);
  assert.equal(pending.value.status,"pending");
  assert.match(pending.value.next.command,/--profile.*connect continue --wait 120 --json -- -synthetic-handle-001/);
  assert.doesNotMatch(pending.output,/synthetic-device-code|synthetic-poll-proof/);
  assert.equal((await f.cli([...api,"continue","--wait","0","--",f.handle])).value.status,"pending");
  assert.equal(f.calls().exchanges,0);
  f.approve();
  const connected=await f.cli([...api,"continue","--wait","5","--",f.handle]);
  assert.equal(connected.value.status,"connected");
  assert.deepEqual(connected.value.result.binding,{buyer_id:f.binding.buyer_id,consumer_id:f.binding.consumer_id});
  assert.doesNotMatch(connected.output,/synthetic-device-access|synthetic-refresh/);
  const credential=hubCredentialsPath({...f.env,ITPAY_STATE_DIR:state});
  assert.equal(JSON.parse(readFileSync(credential,"utf8")).profiles.default.authorization_id,"generation");
  assert.deepEqual(f.calls(),{starts:1,exchanges:1,probes:1,originalConsumer:undefined,commonStarts:0});
 } finally {await f.close()}
});

test("Device renewal starts with the original consumer and leaves its credentials unchanged while pending",async()=>{
 const f=await deviceFixture();
 try {
  const {selector,state}=await f.setup();
  const env={...f.env,ITPAY_STATE_DIR:state};
  storeHubSession("original-access","original-refresh",300,f.binding.buyer_id,f.resource,env,f.binding.consumer_id);
  const path=hubCredentialsPath(env);
  const before=readFileSync(path);
  const pending=await f.cli(["api","--profile",selector,"connect"]);
  assert.equal(pending.value.status,"pending");
  assert.deepEqual(readFileSync(path),before);
  assert.deepEqual(f.calls(),{starts:1,exchanges:0,probes:0,originalConsumer:f.binding.consumer_id,commonStarts:0});
 } finally {await f.close()}
});

test("first Device connect with an unavailable identity probe saves no credentials and never repeats the exchange",async()=>{
 const f=await deviceFixture(503,"synthetic-handle-001",undefined,false);
 try {
  const {selector,state}=await f.setup();
  const api=["api","--profile",selector,"connect"];
  await f.cli(api);
  f.approve();
  const first=await f.cli([...api,"continue","--wait","5","--",f.handle]);
  assert.equal(first.code,1);
  assert.equal(first.value.error.code,"connection_verification_pending");
  assert.equal(existsSync(hubCredentialsPath({...f.env,ITPAY_STATE_DIR:state})),false);
  const resumed=await f.cli([...api,"continue","--wait","5","--",f.handle]);
  assert.equal(resumed.value.status,"exchange_unknown");
  assert.equal(f.calls().exchanges,1);
  assert.equal(f.calls().probes,1);
 } finally {await f.close()}
});

for (const refreshStatus of [400,503]) {
 test(`original task reads preserve Device recovery semantics for refresh ${refreshStatus}`,async()=>{
  const f=await deviceFixture(200,"synthetic-handle-001",refreshStatus);
  try {
   const {selector,state}=await f.setup();
   const env={...f.env,ITPAY_STATE_DIR:state};
   storeHubSession("original-access","original-refresh",300,f.binding.buyer_id,f.resource,env,f.binding.consumer_id);
   const path=hubCredentialsPath(env);
   const credentials=JSON.parse(readFileSync(path,"utf8"));
   credentials.profiles.default.refresh_after="2000-01-01T00:00:00.000Z";
   writeFileSync(path,JSON.stringify(credentials));
   const store=new HubTaskStore(hubTasksDir(env));
   const {task}=store.getOrCreate({request_id:"original-request",operation_id:"op",publication_id:"pub",input:{q:"original"}});
   store.update(task.request_id,{status:"blocked",intent_id:"original-intent"});
   for(const action of [["status",task.request_id]]) {
    const result=await f.cli(["api","--profile",selector,...action]);
    if(refreshStatus===400) {
     assert.equal(result.value.error.code,"authorization_required");
     assert.match(result.value.next.command,/connect --request original-request/);
     assert.ok(result.value.next.command.includes(selector));
    } else {
     assert.equal(result.value.status,"error");
     assert.match(result.value.next.command,/status original-request/);
     assert.doesNotMatch(result.value.next.command,/connect/);
    }
    assert.equal(store.get(task.request_id)?.intent_id,"original-intent");
    assert.deepEqual(store.get(task.request_id)?.input,{q:"original"});
   }
   assert.equal(f.calls().starts,0);
   assert.equal(readFileSync(path,"utf8"),JSON.stringify(credentials));
  } finally {await f.close()}
 });
}

test("task-driven entry emits a link first, reuses pending across turns and connects once",async()=>{
 const f=await deviceFixture();
 try{
  const args=["--agent-type","muse","agent"];
  const first=await f.cli([...args,"--surface","api","--task","find free earthquake data","--buffered"]);
  assert.equal(first.code,0);assert.equal(first.value.status,"pending");assert.equal(first.value.result.task.text,"find free earthquake data");
  assert.match(first.value.next.command,/agent --wait 120 --json/);
  assert.equal(first.value.result.agent_type,"muse");
  assert.doesNotMatch(first.output,/synthetic-device-code|synthetic-poll-proof/);
  const paused=await f.cli([...args,"--wait","0"]);assert.equal(paused.value.status,"pending");
  assert.equal(paused.value.result.task.id,first.value.result.task.id);assert.equal(f.calls().starts,0);assert.equal(f.calls().commonStarts,2);
  f.approve();const final=await f.cli([...args,"--wait","5"]);
  assert.equal(final.value.status,"connected",final.output);assert.match(final.value.next.command,/api --profile .* list --json/);
  const again=await f.cli(args);assert.equal(again.value.status,"connected");
  assert.equal(f.calls().starts,1);assert.equal(f.calls().exchanges,1);
 }finally{await f.close();}
});


test("denied unified API connection remains terminal across turns without starting OAuth",async()=>{
 const f=await deviceFixture();
 try{
  const args=["--agent-type","muse","agent"];
  const first=await f.cli([...args,"--surface","api","--task","read free data","--buffered"]);
  assert.equal(first.value.status,"pending");f.deny();
  const denied=await f.cli([...args,"--wait","0"]);assert.equal(denied.value.status,"denied");assert.equal(denied.value.next,null);
  const reads=f.calls().commonStarts;
  const again=await f.cli(args);assert.equal(again.value.status,"denied");assert.equal(again.value.result.task.id,first.value.result.task.id);
  assert.equal(f.calls().commonStarts,reads);assert.equal(f.calls().starts,0);assert.equal(f.calls().exchanges,0);
 }finally{await f.close();}
});

test("fresh setup connect uses one account page and finishes without a second consent",async()=>{
 const f=await deviceFixture();try{
  const {selector}=await f.setup();
  const args=["--agent-type","muse","api","--profile",selector,"connect"];
  const pending=await f.cli([...args,"--wait","0"]);assert.equal(pending.value.status,"pending");
  assert.match(pending.output,/agent\/connect/);assert.equal(f.calls().starts,0);
  assert.ok(pending.value.next.command.includes(selector));
  f.approve();
  const ready=await new Promise<{value:any;code:number|null}>((resolve,reject)=>{
   const child=spawn('/bin/sh',['-c',pending.value.next.command],{cwd:root,env:f.env});let output='';child.stdout.on('data',v=>output+=v);child.on('error',reject);child.on('close',code=>{try{resolve({code,value:JSON.parse(output.split(/\n(?=\{)/).at(-1)!)})}catch(e){reject(e)}});
  });
  assert.equal(ready.value.status,"connected");assert.match(ready.value.instruction,/当前账号/);
  assert.equal(f.calls().starts,1);assert.equal(f.calls().exchanges,1);
 }finally{await f.close()}
});

test("unified credential preparation continuation retains the same API profile",async()=>{
 const f=await deviceFixture();try{
  const {selector}=await f.setup();f.approve();f.holdExchange();
  const args=["--agent-type","muse","api","--profile",selector,"connect"];
  const pending=await f.cli([...args,"--wait","0"]);assert.equal(pending.value.status,"pending");assert.ok(pending.value.result.handle);assert.ok(pending.value.next.command.includes(selector));
  f.releaseExchange();const result=await f.cli([...args,"--wait","5"]);assert.equal(result.value.status,"connected");assert.equal(f.calls().starts,1);assert.equal(f.calls().exchanges,1);
 }finally{await f.close()}
});


test("existing canonical task survives an explicit legacy Services state directory",async()=>{
 const f=await deviceFixture();
 try{
  const {agentRoot}=await import("../src/commands/agent.js");
  const {prepareAgentConnection}=await import("../src/state/agent_connection.js");
  const {saveAgentTask}=await import("../src/state/agent_task.js");
  const canonical=agentRoot("muse",f.env);
  prepareAgentConnection(canonical,f.resource,"muse",{prepared:true});
  const task=saveAgentTask(canonical,"original canonical API task","api",undefined);
  const key=readFileSync(join(canonical,"services/device/device-private.pem"));
  const resumed=await f.cli(["agent","--wait","0"]);
  assert.equal(resumed.value.status,"pending",resumed.output);
  assert.equal(resumed.value.result.task.id,task.id);
  assert.deepEqual(readFileSync(join(canonical,"services/device/device-private.pem")),key);
  assert.equal(existsSync(join(f.env.ITPAY_STATE_DIR!,"connections")),false);
 }finally{await f.close();}
});

test("legacy API consent keeps its approval URL and requirement in buffered progress",async()=>{
 const f=await deviceFixture(200,"synthetic-handle-001",undefined,false,true);
 try{
  const {agentRoot}=await import("../src/commands/agent.js");
  const {saveAgentTask}=await import("../src/state/agent_task.js");
  const canonical=agentRoot("muse",f.env);
  const setup=await f.cli(["setup","--api-prefix",join(canonical,"api")]);
  const profile=JSON.parse(readFileSync(setup.value.result.selector,"utf8"));
  rmSync(hubCredentialsPath({...f.env,ITPAY_STATE_DIR:join(profile.state_root,"hub-profiles",profile.profile_id)})+".agent-connection.json");
  saveAgentTask(canonical,"original legacy API task","api",undefined);
  const pending=await f.cli(["agent","--buffered"]);
  assert.equal(pending.value.status,"pending",pending.output);
  assert.equal(pending.value.result.url,f.resource+"/verify");
  assert.equal(pending.value.result.approval_required,true);
  assert.equal(f.calls().commonStarts,0);
 }finally{await f.close();}
});

test("approved connection still shows an explicitly required Device approval",async()=>{
 const f=await deviceFixture(200,"synthetic-handle-001",undefined,true,true);
 try{
  f.approve();
  const pending=await f.cli(["agent","--surface","api","--task","continue original consent-bound API task","--buffered"]);
  assert.equal(pending.value.status,"pending",pending.output);
  assert.equal(pending.value.result.url,f.resource+"/verify");
  assert.equal(pending.value.result.approval_required,true);
  assert.equal(f.calls().exchanges,0);
  assert.equal(pending.value.result.task.text,"continue original consent-bound API task");
 }finally{await f.close();}
});
