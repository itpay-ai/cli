import test from 'node:test';
import assert from 'node:assert/strict';
import {Command} from 'commander';
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
 for(const cmd of ['connect','discover','inspect','run','resume','tasks','wallet','admin']) assert.ok(api.commands.some(c=>c.name()===cmd),cmd);
 for(const group of ['api','hub','services']) {
  const p=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','src/main.ts',group,'--help'],{cwd:root,encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/Usage:/);
  if(group!=='services'){assert.match(p.stdout,/discover/);assert.doesNotMatch(p.stdout,/service_execution_id|rail-booking/)}
  else assert.match(p.stdout,/purchase/);
 }
});

// Exercise the actual registered API boundary, not a second CLI implementation.
// Every endpoint is loopback and all payment/identity facts are synthetic.

test('registered API commands keep original requests, safe errors and Services identity across processes',async()=>{
 const home=mkdtempSync(join(tmpdir(),'itpay-api-command-contract-'));
 const sentinel=join(home,'services-identity-sentinel');writeFileSync(sentinel,'unchanged');
 const money={currency:'CNY',scale:6,amount_atoms:'1000000'};
 const descriptor={operation_id:'op-fixture',api_id:'api-fixture',display_name:'Fixture',kind:'metered_api',effect_class:'read_only',status:'published',current_publication_id:'pub-fixture',price_card:{mode:'free',amount_atoms:'0',unit:'call'},input_schema:{type:'object',properties:{}}};
 const run={run_id:'run-original',execution_state:'succeeded',settlement_state:'settled',actual_charge:money};
 let deny=false;const writes:Array<{url:string;key:string|undefined;body:unknown}>=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;
  res.setHeader('Content-Type','application/json');
  if(deny){res.writeHead(403);res.end(JSON.stringify({error:{code:'forbidden',message:'Fixture scope denied'}}));return;}
  if(req.method==='POST')writes.push({url:req.url??'',key:req.headers['idempotency-key'] as string|undefined,body:raw?JSON.parse(raw):null});
  const path=(req.url??'').split('?')[0];
  if(path==='/v1/discover'){res.end(JSON.stringify({items:[{...descriptor,publication_id:'pub-fixture'}],snapshot_id:'saved'}));return;}
  if(path==='/v1/operations/op-fixture'){res.end(JSON.stringify(descriptor));return;}
  if(path==='/v1/me'){res.end(JSON.stringify({buyer_id:'synthetic-buyer',consumer_id:'oauth:itpay-cli-local'}));return;}
  if(path==='/v1/me/wallet'){res.end(JSON.stringify({available:money,held:money}));return;}
  if(path==='/v1/me/usage'){res.end(JSON.stringify({gross_atoms:'0',refunded_atoms:'0',net_atoms:'0',held_atoms:'0'}));return;}
  if(path==='/v1/me/wallet/transactions'){res.end(JSON.stringify({items:[]}));return;}
  if(path==='/v1/topup-skus'){res.end(JSON.stringify({items:[{sku_id:'fixture-sku',display:'Fixture',credit:money}]}));return;}
  if(path==='/v1/me/topups'||path==='/v1/me/topups/top-original'){res.end(JSON.stringify({topup_id:'top-original',status:'payment_pending',payer_currency:'CNY',payer_minor_amount:'100'}));return;}
  if(path==='/v1/operations/op-fixture/runs'||path==='/v1/runs/run-original'){res.end(JSON.stringify(run));return;}
  if(path==='/v1/intents/intent-original/continue'){res.end(JSON.stringify({intent_id:'intent-original',status:'succeeded',run}));return;}
  res.writeHead(404);res.end(JSON.stringify({error:{code:'not_found',message:'Unknown fixture route '+path}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();if(!address||typeof address==='string')throw Error('fixture listener required');
 const base='http://127.0.0.1:'+address.port;
 const invoke=(args:string[],stdin='')=>new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,['--import','tsx','src/main.ts','api',...args,'--json'],{cwd:root,env:{...process.env,HOME:home,ITPAY_STATE_DIR:home,ITPAY_HUB_URL:base,ITPAY_HUB_KEY:'itk_synthetic_contract',ITPAY_HUB_TOKEN:''},stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.end(stdin);
 });
 try{
  const happy=[['discover'],['inspect','op-fixture'],['wallet'],['usage'],['transactions'],['topups'],['topup','fixture-sku','--channel','wechat','--mode','native'],['topup-status','top-original'],['doctor'],['run','op-fixture','--publication','pub-fixture','--input','{}','--request-id','logical-original'],['resume','logical-original'],['run-status','run-original'],['continue','intent-original'],['tasks'],['credentials','import']];
  for(const args of happy){const p=await invoke(args,args[0]==='credentials'?'itk_synthetic_import_key':'');assert.equal(p.code,0,args.join(' ')+': '+p.out+p.err);assert.ok(JSON.parse(p.out));assert.ok(!p.out.includes('itk_synthetic_contract'));}
  const admission=writes.filter(x=>x.url==='/v1/operations/op-fixture/runs');assert.equal(admission.length,1);assert.ok(admission[0]!.key);assert.deepEqual(admission[0]!.body,{expected_publication_id:'pub-fixture',input:{}});
  const topup=writes.find(x=>x.url==='/v1/me/topups');assert.ok(topup?.key);assert.deepEqual(topup?.body,{sku_id:'fixture-sku',payer_currency:'CNY',channel:'wechat',mode:'native'});
  deny=true;
  for(const args of [['discover'],['inspect','op-fixture'],['wallet'],['usage'],['transactions'],['topups'],['topup','fixture-sku'],['topup-status','top-original'],['continue','intent-original'],['run-status','run-original'],['run','op-fixture','--publication','pub-fixture','--input','{}','--request-id','denied-original'],['resume','missing-original'],['credentials','import']]){
   const p=await invoke(args,args[0]==='credentials'?'bad key':'');assert.equal(p.code,1,args.join(' ')+': '+p.out+p.err);const envelope=JSON.parse(p.out);assert.equal(envelope.status,'error');assert.ok(envelope.error.code);assert.ok(!p.out.includes('itk_synthetic_contract'));
  }
  assert.equal(readFileSync(sentinel,'utf8'),'unchanged');
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true});}
});

async function deviceFixture(identityStatus = 200, handle = "synthetic-handle-001", refreshStatus?: number) {
 const home=mkdtempSync(join(tmpdir(),"itpay-device-contract-"));
 const binding={buyer_id:"fixture-buyer",consumer_id:"oauth:fixture-public-cli:original",device_approval_id:"approval",authorization_id:"generation"};
 let ready=false,resource="",starts=0,exchanges=0,probes=0;
 let originalConsumer: string | undefined;
 const server=createServer(async(req,res)=>{
  res.setHeader("Content-Type","application/json");
  if(req.url==="/v1/oauth/device/start") {
   starts++;
   let raw="";for await(const part of req)raw+=part;
   const body=JSON.parse(raw);
   assert.equal(body.client_id,"fixture-public-cli");
   assert.equal(body.resource,resource);
   originalConsumer=body.original_consumer_id;
   res.end(JSON.stringify({handle,device_code:"synthetic-device-code",poll_proof:"synthetic-poll-proof",
    verification_uri_complete:resource+"/verify",expires_in:120,interval:1}));
   return;
  }
  if(req.url===`/v1/oauth/device/${handle}/status`) {
   assert.equal(req.headers.authorization,"Bearer synthetic-poll-proof");
   res.end(JSON.stringify(ready?{phase:"ready_to_exchange",...binding}:{phase:"pending"}));
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
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("ITPAY_"))),
  HOME:home,ITPAY_STATE_DIR:home,ITPAY_HUB_URL:resource,ITPAY_HUB_OAUTH_ISSUER:resource,ITPAY_HUB_OAUTH_CLIENT:"fixture-public-cli"};
 function cli(args:string[]):Promise<{code:number|null;value:any;output:string}> {
  return new Promise((resolve,reject)=>{
   const boundary = args.indexOf("--");
   const argv = boundary < 0 ? [...args, "--json"] : [...args.slice(0, boundary), "--json", ...args.slice(boundary)];
   const child=spawn(process.execPath,["--import","tsx","src/main.ts",...argv],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
   let output="";
   child.stdout.on("data",part=>output+=part);
   child.on("error",reject);
   const deadline=setTimeout(()=>{child.kill("SIGTERM");reject(new Error("Device command timed out"))},15_000);
   child.on("close",code=>{clearTimeout(deadline);try{resolve({code,value:JSON.parse(output),output})}catch(err){reject(err)}});
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
 return {env,resource,handle,binding,cli,setup,close,approve:()=>{ready=true},
  calls:()=>({starts,exchanges,probes,originalConsumer})};
}

test("Device connect exchanges only after approval and verifies before saving",async()=>{
 const f=await deviceFixture(200, "-synthetic-handle-001");
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
  assert.deepEqual(f.calls(),{starts:1,exchanges:1,probes:1,originalConsumer:undefined});
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
  assert.deepEqual(f.calls(),{starts:1,exchanges:0,probes:0,originalConsumer:f.binding.consumer_id});
 } finally {await f.close()}
});

test("first Device connect with an unavailable identity probe saves no credentials and never repeats the exchange",async()=>{
 const f=await deviceFixture(503);
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
   for(const action of [["resume",task.request_id,"--read-first"],["tasks","--refresh","--request-id",task.request_id]]) {
    const result=await f.cli(["api","--profile",selector,...action]);
    if(refreshStatus===400) {
     assert.equal(result.value.error.code,"authorization_required");
     assert.match(result.value.next.command,/connect --request original-request/);
     assert.ok(result.value.next.command.includes(selector));
    } else {
     assert.equal(result.value.status,"listed");
     assert.equal(result.value.next,null);
    }
    assert.equal(store.get(task.request_id)?.intent_id,"original-intent");
    assert.deepEqual(store.get(task.request_id)?.input,{q:"original"});
   }
   assert.equal(f.calls().starts,0);
   assert.equal(readFileSync(path,"utf8"),JSON.stringify(credentials));
  } finally {await f.close()}
 });
}
