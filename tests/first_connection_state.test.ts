import {createHash} from 'node:crypto';
import {existsSync,writeFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareAgentConnection,servicesConnectionRoot,saveAgentConnection} from '../src/state/agent_connection.js';

test('Services connection metadata isolates Backends without replacing the shared device key',()=>{
 const original=mkdtempSync(join(tmpdir(),'itpay-scoped-consent-'));
 try {
  const a='https://backend-a.example.test',b='https://backend-b.example.test';
  const rootA=servicesConnectionRoot(original,a);
  const stateA=prepareAgentConnection(rootA,a,'muse',{surface:'services',prepared:true,services_directory:original})!;
  stateA.connection_id='acn_original_a';stateA.buyer_id='buyer_a';saveAgentConnection(join(rootA,'connection.json'),stateA);
  const key=readFileSync(join(original,'device','device-private.pem'),'utf8');
  const rootB=servicesConnectionRoot(original,b);assert.notEqual(rootA,rootB);
  const stateB=prepareAgentConnection(rootB,b,'muse',{surface:'services',prepared:true,services_directory:original})!;
  assert.equal(stateB.services_directory,original);assert.equal(stateB.connection_id,undefined);
  assert.equal(readFileSync(join(original,'device','device-private.pem'),'utf8'),key);
  assert.equal(prepareAgentConnection(rootA,a,'muse')!.connection_id,'acn_original_a');
  assert.equal(prepareAgentConnection(rootA,a,'muse')!.buyer_id,'buyer_a');
  // The first deployed wrapper saved at the shared root. Keep it in place for A.
  saveAgentConnection(join(original,'connection.json'),stateA);
  assert.equal(servicesConnectionRoot(original,a),original);
  assert.equal(servicesConnectionRoot(original,b),rootB);
  assert.equal(prepareAgentConnection(original,a,'muse')!.connection_id,'acn_original_a');
 }finally{rmSync(original,{recursive:true,force:true})}
});

test("fresh custom API selector points at the original private connection, not a second key",async()=>{
 const {prepareHubInstallation}=await import("../src/state/hub_installation.js");
 const {hubCredentialsPath}=await import("../src/state/hub_credentials.js");
 const {stateDir}=await import("../src/state/config.js");
 const {readConnectionBroker}=await import("../src/state/agent_connection.js");
 const home=mkdtempSync(join(tmpdir(),"itpay-muse-root-"));
 const prior={...process.env};
 try{
  Object.assign(process.env,{HOME:home,ITPAY_AGENT_TYPE:"muse",ITPAY_BACKEND_URL:"https://dev.itpay.ai",ITPAY_HUB_URL:"https://dev.itpay.ai"});
  delete process.env.ITPAY_STATE_DIR;
  const directory=stateDir(),root=servicesConnectionRoot(directory,"https://dev.itpay.ai","muse");
  const original=prepareAgentConnection(root,"https://dev.itpay.ai","muse",{surface:"services",services_directory:directory})!;
  original.connection_id="acn_original";original.buyer_id="original_buyer";saveAgentConnection(join(root,"connection.json"),original);
  const {mkdirSync}=await import("node:fs");
  mkdirSync(join(home,".itpay-v3","shown"),{recursive:true});
  assert.equal(stateDir(),directory,"public show cache is not an old identity");
  const key=readFileSync(join(directory,"device/device-private.pem"));
  const installed=prepareHubInstallation(join(home,"custom-api"),"/official/itp.mjs");
  const profile=JSON.parse(readFileSync(installed.selector,"utf8"));
  const path=hubCredentialsPath({...process.env,ITPAY_STATE_DIR:join(profile.state_root,"hub-profiles",profile.profile_id)})+".agent-connection.json";
  assert.equal(readConnectionBroker(path)?.root,root);
  assert.equal(readConnectionBroker(path)?.state.connection_id,"acn_original");
  assert.equal(existsSync(join(home,"custom-api","connection.json")),false);
  assert.equal(existsSync(join(home,"custom-api","services","device")),false);
  assert.deepEqual(readFileSync(join(directory,"device/device-private.pem")),key);
  original.connection_id="acn_conflicting";saveAgentConnection(join(root,"connection.json"),original);
  assert.throws(()=>readConnectionBroker(path),/broker identity changed/);
  writeFileSync(join(home,".itpay-v3","protected-legacy"),"preserve");
  const {agentRoot}=await import("../src/state/config.js");
  const separate={...process.env,ITPAY_AGENT_HOME:join(home,"other-agent")};
  assert.equal(stateDir(separate),join(agentRoot("muse",separate),"services"));
  assert.equal(readFileSync(join(home,".itpay-v3","protected-legacy"),"utf8"),"preserve");
 }finally{process.env=prior;rmSync(home,{recursive:true,force:true});}
});

test("unapproved Services binding makes no network call and preserves the original state",async()=>{
 const {bindAgentServices}=await import("../src/state/agent_connection.js");
 const root=mkdtempSync(join(tmpdir(),"itpay-no-binding-")),fetcher=globalThis.fetch;
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error("must not send unapproved binding");};
 try{
  const state=prepareAgentConnection(root,"https://dev.itpay.ai","muse")!;
  const before=readFileSync(join(root,"connection.json"));
  await assert.rejects(()=>bindAgentServices(root,state),/original Agent approval is required/);
  assert.equal(calls,0);assert.deepEqual(readFileSync(join(root,"connection.json")),before);
 }finally{globalThis.fetch=fetcher;rmSync(root,{recursive:true,force:true});}
});

test("legacy accepted task without a key cannot create a substitute connection",async()=>{
 const {taskJournalPath}=await import("../src/state/config.js");
 const directory=mkdtempSync(join(tmpdir(),"itpay-original-task-")),backend="https://dev.itpay.ai";
 const original=taskJournalPath({...process.env,ITPAY_STATE_DIR:directory,ITPAY_BACKEND_URL:backend});
 writeFileSync(original,JSON.stringify({request_id:"original_unknown",status:"unknown"}),{mode:0o600});
 try{
  const root=servicesConnectionRoot(directory,backend);
  assert.equal(prepareAgentConnection(root,backend,"muse",{surface:"services",services_directory:directory}),undefined);
  assert.equal(existsSync(join(root,"connection.json")),false);
  assert.equal(existsSync(join(directory,"device","device-private.pem")),false);
  assert.equal(JSON.parse(readFileSync(original,"utf8")).request_id,"original_unknown");
 }finally{rmSync(directory,{recursive:true,force:true});}
});

// Installed-package acceptance against the isolated matching Backend fixture.
// Without that explicit fixture, the normal unit suite makes no network calls.
for(const scenario of ["services-default","services-unchecked","api-first","legacy-services","old-canonical-services"]){
 test("installed Muse native consent: "+scenario,{skip:!process.env.ITPAY_MUSE_FIXTURE_URL},async()=>{
  const {spawn}=await import("node:child_process");
  const {createPublicKey}=await import("node:crypto");
  const {chromium}=await import(process.env.ITPAY_PLAYWRIGHT_MODULE!);
  const {saveAgentTask}=await import("../src/state/agent_task.js");
  const base=process.env.ITPAY_MUSE_FIXTURE_URL!;
  assert.equal(new URL(base).hostname,"127.0.0.1");
  const home=mkdtempSync(join(tmpdir(),"itpay-muse-package-"));
  const browser=await chromium.launch({executablePath:process.env.ITPAY_BROWSER_EXECUTABLE??"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
  const page=await browser.newPage();
  await page.context().addCookies([{name:"itpay_buyer_session",value:"synthetic-only",url:base}]);
  const env:NodeJS.ProcessEnv={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith("ITPAY_")&&!["HOME","NODE_OPTIONS","CODEX_THREAD_ID","CLAUDECODE","MUSE_SESSION_ID","DOT_SESSION_ID","WORKBUDDY_SESSION_ID"].includes(k))),
   HOME:home,ITPAY_AGENT_TYPE:"muse",ITPAY_CLI_DEV:"1",ITPAY_BACKEND_URL:base,ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base,ITPAY_HUB_OAUTH_CLIENT:"itpay-cli"};
  const executable=process.env.ITPAY_MUSE_CLI_EXECUTABLE!;
  const frames=(raw:string)=>raw.split(/\n(?=\{)/).flatMap(part=>{try{return [JSON.parse(part)]}catch{return []}});
  const trace=()=>fetch(base+"/_fixture/state").then(r=>r.json()) as Promise<any>;
  const steps:any[]=[];
  const cli=async(args:string[],approve?:boolean,expected=0)=>{
   let raw="",errors="",handled=false,submitted:Promise<void>=Promise.resolve();
   const child=spawn(process.execPath,[executable,...args],{env,cwd:home});
   child.stderr.on("data",p=>errors+=p);
   child.stdout.on("data",p=>{
    raw+=p;
    const pending=frames(raw).find(f=>f.status==="pending"&&f.result?.authorization?.url);
    if(pending&&!handled&&approve!==undefined){
     handled=true;
     assert.equal(pending.result.authorization.enabled_surfaces,undefined,"pending is not final consent");
     submitted=(async()=>{
      await page.goto(pending.result.authorization.url);
      const optional=page.locator("[name=enable_other]");
      if(await optional.count()){assert.equal(await optional.isChecked(),true);if(!approve)await optional.uncheck();}
      await page.getByRole("button",{name:"确认连接",exact:true}).click();
      await page.locator("[data-testid=agent-connection-complete]").waitFor();
      await page.waitForLoadState("load");
     })();
    }
   });
   const code=await new Promise<number|null>((resolve,reject)=>{child.on("error",reject);child.on("close",resolve)});
   await submitted;
   const value=frames(raw).at(-1);
   assert.equal(code,expected,errors+" "+raw);
   steps.push({args,status:value.status,surfaces:value.result?.surfaces,next:value.next?.command});
   return {...value,_progress:frames(raw)};
  };
  try{
   await fetch(base+"/_fixture/clear",{method:"POST"});
   if(scenario==="old-canonical-services"){
    const {agentRoot}=await import("../src/state/config.js");
    const canonical=agentRoot("muse",env);
    env.ITPAY_STATE_DIR=join(home,"different-legacy-state");
    prepareAgentConnection(canonical,base,"muse",{surface:"services",prepared:true});
    const task=saveAgentTask(canonical,"original canonical Services task","services",undefined);
    const key=readFileSync(join(canonical,"services/device/device-private.pem"));
    const connected=await cli(["agent","--wait","120","--json"],true);
    assert.equal(connected.status,"connected");
    assert.equal(connected.result.task.id,task.id);
    assert.deepEqual(readFileSync(join(canonical,"services/device/device-private.pem")),key);
    assert.equal(existsSync(join(env.ITPAY_STATE_DIR,"device")),false);
    assert.equal((await trace()).connections.length,1);
    return;
   }
   if(scenario==="legacy-services"){
    const {createDeviceKey}=await import("../src/state/device_key.js");
    const {agentRoot}=await import("../src/state/config.js");
    const canonical=agentRoot("muse",env),directory=join(canonical,"services");
    env.ITPAY_STATE_DIR=join(home,"different-legacy-state");
    createDeviceKey(join(directory,"device/device-private.pem"),false);
    const key=readFileSync(join(directory,"device/device-private.pem"));
    const task=saveAgentTask(canonical,"original legacy Services task","services",undefined);
    const pending=await cli(["agent","--wait","3","--json"]);
    assert.equal(pending.status,"auth_pending");
    assert.equal(pending.result.task.id,task.id);
    assert.ok(pending._progress.some((frame:any)=>frame.result?.authorization?.handoff?.url===base+"/auth?start_token=synthetic"));
    assert.equal(existsSync(join(canonical,"connection.json")),false);
    assert.equal(existsSync(join(env.ITPAY_STATE_DIR,"device")),false);
    await fetch(base+"/_fixture/deny-legacy",{method:"POST"});
    const denied=await cli(["agent","--wait","0","--json"]);
    assert.equal(denied.status,"auth_denied");
    const stopped=await cli(["agent","--wait","0","--json"]);
    assert.equal(stopped.status,"denied");
    assert.equal((await trace()).legacy_starts,1);
    const reconnect=await cli(["agent","--reconnect","--wait","0","--json"]);
    assert.equal(reconnect.status,"auth_pending");
    assert.equal(JSON.parse(readFileSync(join(canonical,"task.json"),"utf8")).authorization_terminal,undefined);
    assert.deepEqual(readFileSync(join(directory,"device/device-private.pem")),key);
    assert.equal((await trace()).legacy_starts,2);
    assert.equal((await trace()).connections.length,0);
    return;
   }
   let selector:string,serviceRoot:string,originalTask:any,originalKey:string;
   if(scenario==="api-first"){
    const setup=await cli(["setup","--api-prefix",join(home,"custom-api"),"--json"]);selector=setup.result.selector;
    const done=await cli(["api","--profile",selector,"connect","--wait","120","--json"],true);
    assert.equal(done.status,"connected");
    assert.deepEqual(done.result.surfaces,{services:"enabled",api:"enabled"});
    const broker=JSON.parse(readFileSync(join((JSON.parse(readFileSync(selector,"utf8"))).state_root,"hub-profiles",setup.result.profile_id,
     "hub-credentials."+createHashForFixture(base)+".json.agent-connection.json"),"utf8"));
    serviceRoot=broker.root;originalKey=readFileSync(join(serviceRoot,"services/device/device-private.pem"),"utf8");
    const login=await cli(["auth","login","--json"]);
    assert.equal(login.status,"authenticated");
   }else{
    const setup=await cli(["setup","--json"]);serviceRoot=join(setup.result.state_directory,"..");
    originalTask=saveAgentTask(serviceRoot,"retain this original Services task","services",undefined);
    const done=await cli(["auth","login","--json"],scenario!=="services-unchecked");
    assert.equal(done.status,"connected");
    assert.equal(done.result.surfaces.services,"enabled");
    assert.equal(done.result.surfaces.api,scenario==="services-unchecked"?"consent_required":"enabled");
    if(scenario==="services-unchecked")assert.match(done.instruction,/API 未开通：你在确认页取消了勾选。以后用到 API 时，会在这条连接上请你补充确认。/);
    assert.match(done.next.command,/next --json$/);
    originalKey=readFileSync(join(setup.result.state_directory,"device/device-private.pem"),"utf8");
    const first=await trace();assert.equal(first.submits.length,1);
    await cli(["api","list","--json"]);
    await cli(["api","show","op_fixture","--json"]);
    const notConnected=await cli(["api","call","op_fixture","--input","{}","--json"],undefined,1);
    assert.equal(notConnected.error.code,"authorization_required");
    const setupAPI=await cli(["setup","--api-prefix",join(home,"custom-api"),"--json"]);selector=setupAPI.result.selector;
    const connected=await cli(["api","--profile",selector,"connect","--wait","120","--json"],scenario==="services-unchecked"?true:undefined);
    assert.equal(connected.status,"connected");
    assert.deepEqual(JSON.parse(readFileSync(join(serviceRoot,"task.json"),"utf8")),originalTask);
   }
   const snapshot=await trace();
   assert.equal(snapshot.connections.length,1);
   assert.deepEqual([...snapshot.connections[0].enabled_surfaces].sort(),["api","services"]);
   assert.equal(snapshot.submits.length,scenario==="services-unchecked"?2:1);
   assert.equal(snapshot.same_key_all_connections,true);
   assert.deepEqual(snapshot.hub_calls,[snapshot.connections[0].connection_id]);
   const metadata=JSON.parse(readFileSync(join(serviceRoot!,"connection.json"),"utf8"));
   assert.equal(metadata.connection_id,snapshot.connections[0].connection_id);
   const key=createPublicKey(readFileSync(join(metadata.services_directory??join(serviceRoot!,"services"),"device","device-private.pem"),"utf8"));
   assert.equal(key.asymmetricKeyType,"ed25519");
   assert.equal(readFileSync(join(metadata.services_directory??join(serviceRoot!,"services"),"device","device-private.pem"),"utf8"),originalKey!);
   const noShown=await cli(["api","--profile",selector!,"call","op_fixture","--input","{}","--json"],undefined,1);
   assert.equal(noShown.error.code,"show_required");
   await cli(["api","--profile",selector!,"show","op_fixture","--json"]);
   const called=await cli(["api","--profile",selector!,"call","op_fixture","--input","{}","--json"]);
   assert.equal(called.status,"succeeded");
   const before=await trace();
   await cli(["api","--profile",selector!,"connect","--wait","0","--json"]);
   assert.equal((await trace()).submits.length,before.submits.length);
   if(process.env.ITPAY_MUSE_RESULT_PATH){
    const prior=existsSync(process.env.ITPAY_MUSE_RESULT_PATH)?JSON.parse(readFileSync(process.env.ITPAY_MUSE_RESULT_PATH,"utf8")):[];
    const {writeFileSync}=await import("node:fs");
    writeFileSync(process.env.ITPAY_MUSE_RESULT_PATH,JSON.stringify([...prior,{scenario,version:JSON.parse(readFileSync(join(executable,"..","..","package.json"),"utf8")).version,steps,connection_count:1,key_type:"ed25519",consent_posts:snapshot.submits.length,original_task_preserved:!originalTask||JSON.parse(readFileSync(join(serviceRoot!,"task.json"),"utf8")).id===originalTask.id}],null,2),{mode:0o600});
   }
  }finally{await browser.close();rmSync(home,{recursive:true,force:true});}
 });
}
function createHashForFixture(origin:string):string{
 return createHash("sha256").update(origin).digest("hex").slice(0,12);
}
