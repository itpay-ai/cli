import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {HubTaskStore, hubTasksDir} from "../src/state/hub_tasks.js";
import {safeHubErrorDetails} from "../src/client/hub.js";

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ITPAY_") && !k.startsWith("MONID_")));
const receipt = (run: string, terminal = false) => ({run_id:run, operation_id:"op", publication_id:"pub", execution_state:terminal?"succeeded":"accepted", settlement_state:terminal?"captured":"reserved", delivery_state:terminal?"inline":"not_ready", terminal, pending_stage:terminal?null:"queued", next:terminal?null:{read_only:{method:"GET",path:`/v1/runs/${run}`}}, ...(terminal?{actual_charge:{amount_atoms:"10000",currency:"CNY",scale:6},result:{rate:1.12}}:{})});

async function fixture(mode: "wait" | "timeout" | "zero" | "reject" | "pending" = "wait") {
  const dir = mkdtempSync(join(tmpdir(),"itpay-case-recovery-"));
  let posts=0, continues=0, reads=0, lookups=0, charges=0, sends=0;
  let snapshotMode: "terminal" | "old" | "foreign" | "missing" = "terminal";
  let completed=false;let completion: ReturnType<typeof setTimeout> | undefined;
  const keys: string[]=[];
  const server=createServer(async(req,res)=>{
    res.setHeader("Content-Type","application/json");
    const path=req.url!;
    if(req.method==="POST") posts++;
    if(path==="/v1/operations/op/runs"){
      keys.push(String(req.headers["idempotency-key"]));
      let body="";for await(const c of req) body+=c;
      assert.equal(JSON.parse(body).expected_publication_id,"pub");
      res.writeHead(403);res.end(JSON.stringify({intent_id:"int-original",kind:"api_run",status:"open",blocking_reason:"authorization_denied",terminal:false,pending_stage:"authorization",next:{read_only:{method:"GET",path:"/v1/requests/cli-req-original"}}}));return;
    }
    if(path==="/v1/intents/int-original/continue"){
      continues++;assert.equal(req.headers["idempotency-key"],"cli-continue-original");
      if(!sends && mode!=="reject")sends++;
      if(mode==="reject") completed=true;
      else if(mode!=="pending" && !completion) completion=setTimeout(()=>{completed=true;charges=1},100);
      res.end(JSON.stringify({intent_id:"int-original",status:"succeeded",terminal:false,pending_stage:"queued",next:{read_only:{method:"GET",path:"/v1/runs/run-original"}},run:receipt("run-original")}));return;
    }
    if(path==="/v1/runs/run-original"){
      reads++;
      const saved=JSON.parse(readFileSync(join(hubTasksDir(env),"original.json"),"utf8"));
      assert.equal(saved.run_id,"run-original","run binding must be durable before the first GET");
      if(mode==="timeout"&&reads===1)return;
      const terminal=completed;
      const observed = mode === "reject" ? {...receipt("run-original",true), execution_state:"failed", settlement_state:"released", actual_charge:undefined, error:{code:"workflow_interrupted",message:"workflow ended"}, first_error:{code:"step_input_rejected",message:"step request was rejected before dispatch"}} : receipt("run-original",terminal);
      res.end(JSON.stringify(observed));return;
    }
    if(path.startsWith("/v1/requests/")){
      lookups++;
      if(snapshotMode==="missing") {res.writeHead(404);res.end(JSON.stringify({error:{code:"not_found",message:"unavailable"}}));return;}
      const id=decodeURIComponent(path.slice("/v1/requests/".length));
      const run=receipt(snapshotMode==="foreign"?"run-foreign":"run-original",snapshotMode!=="old");
      res.end(JSON.stringify({request_id:id,intent_id:"int-original",intent:{intent_id:"int-original",kind:"api_run",status:"succeeded"},run,terminal:run.terminal,pending_stage:run.pending_stage,next:run.next}));return;
    }
    if(path==="/v1/operations/metadata"){
      res.writeHead(503);res.end(JSON.stringify({error:{code:"unavailable",message:"safe public failure",details:{stage:"metadata",method:"GET",path:"/v1/operations/private-id?token=private-token",headers:{Authorization:"Bearer private-token"},raw:"private-token"}}}));return;
    }
    res.writeHead(404);res.end(JSON.stringify({error:{code:"not_found",message:"unavailable"}}));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const a=server.address();if(!a||typeof a==="string")throw Error("loopback port needed");
  const env={...cleanEnv(), ITPAY_STATE_DIR:dir, ITPAY_HUB_URL:`http://127.0.0.1:${a.port}`, ITPAY_HUB_KEY:"itk_synthetic_case", ITPAY_AGENT_TYPE:"workbuddy"};
  const invoke=(args:string[],extra:NodeJS.ProcessEnv={})=>new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{
    const child=spawn(process.execPath,["--import","tsx",resolve("src/main.ts"),"api",...args],{env:{...env,...extra},stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",x=>stdout+=x);child.stderr.on("data",x=>stderr+=x);child.on("error",reject);child.on("exit",code=>done({code,stdout,stderr}));
  });
  const start=()=>invoke(["run","op","--publication","pub","--input","{}","--max-charge","10000","--request-id","original","--json"]);
  const task=()=>JSON.parse(readFileSync(join(hubTasksDir(env),"original.json"),"utf8"));
  const close=async()=>{if(completion)clearTimeout(completion);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})};
  return {env,invoke,start,task,close,counters:()=>({posts,continues,reads,lookups,charges,sends,keys}),snapshot:(v:typeof snapshotMode)=>snapshotMode=v};
}

test("intent resume binds once, waits by GET, delivers terminal and refresh never writes",async()=>{
  const f=await fixture();try{
    const first=await f.start();assert.equal(first.code,0,first.stderr);assert.equal(f.task().blocking_reason,"authorization_denied");
    const result=await f.invoke(["resume","original","--wait","2","--json"]);assert.equal(result.code,0,result.stderr);
    const frame=JSON.parse(result.stdout);assert.equal(frame.result.terminal,true);assert.equal(frame.result.actual_charge.amount_atoms,"10000");assert.equal(frame.next,null);
    assert.equal(f.task().status,"succeeded");assert.equal(f.task().blocking_reason,undefined);assert.equal(f.task().run_id,"run-original");
    assert.deepEqual(f.counters(),{posts:2,continues:1,reads:2,lookups:0,charges:1,sends:1,keys:["cli-req-original"]});
    const before=f.counters();const refreshed=await f.invoke(["tasks","--refresh","--request-id","original","--json"]);assert.equal(refreshed.code,0,refreshed.stderr);const item=JSON.parse(refreshed.stdout).result.items[0];assert.equal(item.state_stale,false);assert.equal(item.terminal,true);
    assert.equal(f.counters().posts,before.posts);assert.equal(f.counters().charges,1);assert.equal(f.counters().sends,1);
    f.snapshot("old");await f.invoke(["tasks","--refresh","--json"]);assert.equal(f.task().status,"succeeded");assert.equal(f.task().terminal,true);assert.equal(f.task().state_stale,true,"stale observation cannot overrule an authoritative terminal");
    f.snapshot("foreign");await f.invoke(["tasks","--refresh","--json"]);assert.equal(f.task().run_id,"run-original");assert.equal(f.task().refresh_error,"binding_conflict");assert.equal(f.counters().posts,2);
    const beforeOther=f.counters();const other=await f.invoke(["tasks","--refresh","--json"],{ITPAY_HUB_KEY:"itk_other_consumer"});assert.deepEqual(JSON.parse(other.stdout).result.items,[]);assert.equal(f.counters().lookups,beforeOther.lookups);assert.equal(f.counters().posts,2);
  }finally{await f.close()}
});

test("intent wait zero returns its receipt immediately; status rejects --wait before network",async()=>{
  const f=await fixture("zero");try{
    await f.start();const resumed=await f.invoke(["resume","original","--wait","0","--json"]);assert.equal(resumed.code,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).result.terminal,false);assert.equal(f.counters().reads,0);
    const bad=await f.invoke(["run-status","run-original","--wait","1","--json"]);assert.notEqual(bad.code,0);assert.match(bad.stderr,/rejects --wait|not supported/);assert.equal(f.counters().reads,0);
    const status=await f.invoke(["run-status","run-original","--json"]);assert.equal(status.code,0,status.stderr);assert.equal(f.counters().reads,1);assert.equal(f.task().status,"succeeded");assert.equal(f.task().blocking_reason,undefined);
    assert.equal(f.counters().continues,1);assert.equal(f.counters().charges,1);
  }finally{await f.close()}
});

test("read timeout preserves the run and next resume performs only GET",async()=>{
  const f=await fixture("timeout");try{
    await f.start();const timed=await f.invoke(["resume","original","--wait","1","--json"]);assert.equal(timed.code,1,timed.stderr);const frame=JSON.parse(timed.stdout);assert.equal(frame.result.run_id,"run-original");assert.deepEqual(frame.error.details,{stage:"status",method:"GET",path:"/v1/runs/{run_id}"});assert.match(frame.next.command,/run-status run-original/);assert.equal(f.task().run_id,"run-original");
    const beforeRecovery=f.counters();assert.equal(beforeRecovery.charges,1,"synthetic owner settles independently while the read response is lost");
    const recovered=await f.invoke(["resume","original","--wait","1","--json"]);assert.equal(recovered.code,0,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).result.terminal,true);assert.equal(f.counters().continues,1);assert.equal(f.counters().charges,1);assert.equal(f.counters().sends,1);
  }finally{await f.close()}
});

test("refresh missing state is unknown without an action or funding assumption; bounded and scoped",async()=>{
  const f=await fixture();try{
    await f.start();f.snapshot("missing");const missing=await f.invoke(["tasks","--refresh","--request-id","original","--json"]);assert.equal(missing.code,0,missing.stderr);const frame=JSON.parse(missing.stdout);assert.equal(frame.result.items[0].status,"unknown");assert.equal(frame.result.items[0].state_stale,true);assert.equal(frame.result.items[0].blocking_reason,undefined);assert.equal(frame.next,null);assert.equal(frame.recovery.length,0);assert.equal(f.counters().posts,1);
    const store=new HubTaskStore(hubTasksDir(f.env));for(let i=0;i<22;i++)store.getOrCreate({request_id:`extra-${i}`,operation_id:"op",publication_id:"pub",input:{}});
    const before=f.counters().lookups;const bounded=JSON.parse((await f.invoke(["tasks","--refresh","--json"])).stdout);assert.equal(f.counters().lookups-before,20);assert.equal(bounded.result.refresh_attempted_count,20);assert.equal(bounded.result.refreshed_count,0);assert.equal(bounded.result.items.length,23);assert.equal(f.counters().posts,1);
    const local=JSON.parse((await f.invoke(["tasks","--json"])).stdout);assert.ok(local.result.items.every((x:any)=>x.state_stale===true&&x.state_source==="local"));
    const bad=await f.invoke(["resume","original","--wait","NaN","--json"]);assert.equal(bad.code,1);assert.equal(f.counters().continues,0);
  }finally{await f.close()}
});

test("safe SDK stage/method/path survives CLI error mapping without raw parameters or extra details",async()=>{
  assert.equal(safeHubErrorDetails({stage:"metadata\nBearer secret",method:"GET\nsecret",path:"https://bad/private?token=secret"}),undefined);
  const f=await fixture();try{
    const result=await f.invoke(["inspect","metadata","--json"]);assert.equal(result.code,1,result.stderr);const frame=JSON.parse(result.stdout);assert.deepEqual(frame.error.details,{stage:"metadata",method:"GET",path:"/v1/operations/{operation_id}"});assert.doesNotMatch(result.stdout,/private-id|private-token|Authorization|Bearer/);
  }finally{await f.close()}
});


test("bounded wait returns its latest pending receipt without a second write or an extra deadline GET",async()=>{
  const f=await fixture("pending");try{
    await f.start();const out=await f.invoke(["resume","original","--wait","0.05","--json"]);assert.equal(out.code,0,out.stderr);const frame=JSON.parse(out.stdout);assert.equal(frame.result.terminal,false);assert.equal(frame.result.pending_stage,"queued");assert.equal(frame.next.read_only.method,"GET");assert.equal(f.counters().reads,1);assert.equal(f.counters().continues,1);assert.equal(f.counters().charges,0);
  }finally{await f.close()}
});

test("first confirmed execution cause survives the final generic failure receipt",async()=>{
  const f=await fixture("reject");try{
    await f.start();const out=await f.invoke(["resume","original","--wait","1","--json"]);assert.equal(out.code,0,out.stderr);const frame=JSON.parse(out.stdout);assert.equal(frame.result.terminal,true);assert.equal(frame.result.settlement_state,"released");assert.equal(frame.result.error.code,"workflow_interrupted");assert.equal(frame.result.first_error.code,"step_input_rejected");assert.equal(frame.result.actual_charge,null);assert.equal(f.counters().sends,0);assert.equal(f.counters().charges,0);assert.equal(f.counters().continues,1);
  }finally{await f.close()}
});
