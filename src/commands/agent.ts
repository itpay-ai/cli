import {prepareAgentConnection,connectAgent,bindAgentServices,saveAgentConnection} from "../state/agent_connection.js";
import {hubCredentialsPath,hubCredentialKind,importHubKey} from "../state/hub_credentials.js";
import {describeHubIdentity} from "./hub.js";
import { HubClient, loadHubConfig } from "../client/hub.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { canonicalAgentType, declaredAgentType } from "../state/agent_type.js";
import { prepareHubInstallation, selectHubInstallation, shellQuote } from "../state/hub_installation.js";
import { connectHubDevice, hubDeviceStatus } from "../state/hub_device.js";
import { saveAgentTask, recordAgentAuthorization } from "../state/agent_task.js";
import { hubOAuthConfig } from "../state/hub_oauth.js";
import { loadConfig, newBackendClient, resolveBackendURL } from "../state/config.js";
import { agentAuth } from "../state/account_auth.js";
import { isInstallAgentType } from "./install.js";
import { writeCommandEnvelope } from "./guidance.js";

// Explicit runtime identity wins. Never infer a host from an old device or HOME path.
export function actualAgentType(env: NodeJS.ProcessEnv = process.env): string {
 const explicit = declaredAgentType({},process.argv);
 if (explicit) {if(isInstallAgentType(explicit))return explicit;throw new Error('unsupported actual --agent-type');}
 const signals = [env.CODEX_THREAD_ID ? "codex-desktop" : undefined, env.CLAUDECODE ? "claude-code-desktop" : undefined,
  env.MUSE_SESSION_ID ? "muse" : undefined, env.DOT_SESSION_ID ? "dot" : undefined, env.WORKBUDDY_SESSION_ID ? "workbuddy" : undefined].filter(Boolean);
 if (signals.length === 1) return signals[0]!;
 if(signals.length===0 && env.ITPAY_AGENT_TYPE){const configured=canonicalAgentType(env.ITPAY_AGENT_TYPE);if(configured&&isInstallAgentType(configured))return configured;}
 throw new Error("host_context_required: Agent must supply its own actual --agent-type; do not ask the user to choose an identity");
}

export function agentRoot(type: string, env: NodeJS.ProcessEnv = process.env): string {
 const origin = resolveBackendURL(env);
 const endpoint = createHash("sha256").update(origin).digest("hex").slice(0,16);
 return resolve(env.ITPAY_AGENT_HOME ?? join(env.HOME || homedir(), ".local", "share", "itpay", "agents"), endpoint, type);
}

export function registerAgentCommand(program: Command): void {
 program.command("agent").description("Prepare only the requested service, preserve the task and wait for its original authorization")
 .option("--task <text>","original user task, or @private-file; omit to resume")
 .option("--surface <surface>","api or services, selected by the Agent from the task")
 .option("--reconnect","explicit user request to reconnect the same Agent and account")
 .option("--new-task","start an explicitly new intent; keep prior task receipt")
 .option("--request <id>","original local API request to read after reconnecting")
 .option("--wait <seconds>","wait after emitting the link, 0..120 seconds","120")
 .option("--buffered","return the link first; execute next immediately in a second host tool call")
 .option("--json","emit JSON progress frames and final status")
 .action(async options=>{
  let continuation:string|undefined;
  try{
   const type=actualAgentType();process.env.ITPAY_AGENT_TYPE=canonicalAgentType(type);
   const root=agentRoot(type);const wait=Number(options.wait);
   if(!Number.isInteger(wait)||wait<0||wait>120)throw new Error("wait must be 0..120");
   const text=options.task?.startsWith('@')?readFileSync(options.task.slice(1),'utf8'):options.task as string|undefined;
   const task=saveAgentTask(root,text,options.surface,options.request,Boolean(options.newTask));
   const executable=resolve(process.argv[1]!);
   const publicEnv=`ITPAY_AGENT_EXECUTABLE=${shellQuote(executable)} ITPAY_HUB_OAUTH_ISSUER=${shellQuote(new URL(hubOAuthConfig().tokenURL).origin)} ITPAY_BACKEND_URL=${shellQuote(resolveBackendURL())} ITPAY_HUB_URL=${shellQuote(hubOAuthConfig().resource)} ${process.env.ITPAY_AGENT_HOME ? 'ITPAY_AGENT_HOME='+shellQuote(process.env.ITPAY_AGENT_HOME)+' ' : ''}`;
   const again=`${publicEnv}${shellQuote(process.execPath)} ${shellQuote(executable)} --agent-type ${type} agent --wait 120 --json`;
   continuation=again;
   const emit=(phase:string,details:Record<string,unknown>,next:string|null,instruction:string)=>writeCommandEnvelope({status:phase,result:{...details,task,agent_type:type},instruction,next:next?{command:next,reason:phase==='pending'?'立即继续等待原授权，无需用户回复':'继续原任务'}:null,recovery:[]},{jsonOutput:Boolean(options.json)});
   if(task.authorization_terminal&&!options.reconnect){emit(task.authorization_terminal,{},null,'本人已拒绝或取消；不自动重开授权。明确的新任务才使用--new-task。');return;}
   if(task.surface==='api'){
    const selected=loadHubConfig();
    const installation=prepareHubInstallation(join(root,'api'));selectHubInstallation(installation.selector);
    if(selected.apiKey && !process.env.ITPAY_HUB_KEY){
     const installed=loadHubConfig();
     if(selected.baseURL!==installed.baseURL || task.request_id && installed.apiKey!==selected.apiKey)throw new Error('credential_conflict: keep the original request credential; do not migrate it to another Key');
     importHubKey(selected.apiKey,installed.baseURL);
    }
    if(hubCredentialKind()==='api_key'){
     const me=await new HubClient(loadHubConfig()).me();
     const next=`${publicEnv}${shellQuote(process.execPath)} ${shellQuote(executable)} api --profile ${shellQuote(installation.selector)} ${task.request_id?'status '+task.request_id:'list'} --json`;
     emit('connected',{selector:installation.selector,identity:describeHubIdentity(me,'api_key')},next,'使用所选 API Key，无需 OAuth。继续同一私密环境或此安装已导入的 Key；原请求仍受原凭据范围保护。');return;
    }
   }
   const common=prepareAgentConnection(root,resolveBackendURL(),type);
   if(common){
    let view=await connectAgent(root,common,Boolean(options.reconnect));
    if(options.reconnect)recordAgentAuthorization(root,undefined);
    if(view.status==='pending'){
     emit('pending',{authorization:view},again,'展示此官方链接；本人确认一次后自动继续原任务。立即执行next等待。');
     if(options.buffered||wait===0)return;
     const deadline=Date.now()+wait*1000;
     while(view.status==='pending'&&Date.now()<deadline){await sleep(Math.min(2000,deadline-Date.now()));view=await connectAgent(root,common);}
    }
    if(view.status!=='active'){
     if(view.status==='denied')recordAgentAuthorization(root,'denied');
     emit(view.status,{authorization:view},view.status==='pending'||view.status==='expired'?again:null,'保留原任务与连接；拒绝或撤销后停止，不自动重开。');return;
    }
   }
   if(task.surface==='api'){
    const installation=prepareHubInstallation(join(root,'api'));selectHubInstallation(installation.selector);
    if(common)saveAgentConnection(hubCredentialsPath()+".agent-connection.json",{root,state:common});
    const current=hubDeviceStatus();
    const next=task.request_id?`${publicEnv}${shellQuote(process.execPath)} ${shellQuote(executable)} api --profile ${shellQuote(installation.selector)} status ${task.request_id} --json`:`${publicEnv}${shellQuote(process.execPath)} ${shellQuote(executable)} api --profile ${shellQuote(installation.selector)} list --json`;
    if(current.phase==='connected'){
     try { const me=await new HubClient(loadHubConfig()).me();if(common&&me.buyer_id!==new URL(hubOAuthConfig().tokenURL).origin+'|'+common.buyer_id)throw new Error('original Agent API account changed');emit('connected',{selector:installation.selector},next,'连接已保存；继续已保存任务。已有request只读原单，不再次call。');return; }
     catch(error){if(!(error instanceof Error && error.message.startsWith('authorization_required:')))throw error;}
    }
    let result=await connectHubDevice(undefined,0,task.request_id);
    if(result.phase==='pending'){
     emit('pending',{...result,...(common&&!result.approval_required?{url:undefined}:{}),selector:installation.selector},again,common&&!result.approval_required?'正在核验并保存 API 连接，继续等待原句柄。':'现在展示此官方链接；用户点完无需回话。pending不是已连接；立即按next等待。');
     if(options.buffered||wait===0)return;
     result=await connectHubDevice(result.handle,wait);
    }
    if(result.phase==='denied'||result.phase==='cancelled')recordAgentAuthorization(root,result.phase);
    emit(result.phase,{...result,...(common&&result.phase==='pending'&&!result.approval_required?{url:undefined}:{}),selector:installation.selector},result.phase==='connected'?next:result.phase==='pending'?again:null,result.phase==='connected'?'已核验并保存连接，继续原任务。':'保留同一任务和等待句柄；pending不代表授权成功，下轮任意回复从agent继续。');return;
   }
   process.env.ITPAY_STATE_DIR=join(root,'services');
   const config=loadConfig();const backend=newBackendClient(config);
   if(common)await bindAgentServices(root,common);
   let result=await agentAuth('status',config.baseURL,backend) as Record<string,unknown>;
   if(['login_required','auth_pending','auth_expired','auth_session_missing'].includes(String(result.status))) result=await agentAuth('login',config.baseURL,backend) as Record<string,unknown>;
   const done=()=>result.status==='authenticated';
   const servicesNext=`${publicEnv}ITPAY_STATE_DIR=${shellQuote(process.env.ITPAY_STATE_DIR!)} ${shellQuote(process.execPath)} ${shellQuote(executable)} --agent-type ${type} next --json`;
   const emitServices=()=>{
    if(result.status==='auth_denied'||result.status==='auth_cancelled')recordAgentAuthorization(root,result.status==='auth_denied'?'denied':'cancelled');
    emit(done()?'connected':String(result.status),{authorization:result,state_directory:process.env.ITPAY_STATE_DIR},done()?servicesNext:result.status==='auth_pending'?again:null,done()?'账号已连接；读Services Skill继续保存的原任务。':'展示原官方登录入口并立即等待，不要求用户回来报告完成。');};
   emitServices();if(done()||options.buffered||wait===0||result.status!=='auth_pending')return;
   const deadline=Date.now()+wait*1000;
   do{await sleep(Math.min(2000,Math.max(0,deadline-Date.now())));result=await agentAuth('status',config.baseURL,backend) as Record<string,unknown>;}while(result.status==='auth_pending'&&Date.now()<deadline);
   emitServices();
  }catch(error){
   if(continuation&&error&&typeof error==='object'&&'code' in error&&error.code==='agent_connection_pending'){
    writeCommandEnvelope({status:'pending',result:{stage:'credential_preparation'},instruction:'原连接仍在准备中；保留任务、密钥和原请求，按next继续，不重新请本人确认。',next:{command:continuation,reason:'继续原连接',poll_after_ms:5000},recovery:[]},{jsonOutput:Boolean(options.json)});return;
   }
   writeCommandEnvelope({status:'error',error:{code:'agent_prepare_failed',message:error instanceof Error?error.message:'Agent preparation failed'},instruction:(process.env.ITPAY_HUB_KEY||hubCredentialKind()==='api_key')?'所选 API Key 未就绪；到官方 /me/keys 核对有效性、范围与预算，再安全 stdin 导入。不要发起 OAuth 或更换原单身份。':'保留已保存任务和原连接，核对具体失败；不换身份或重发业务。',next:null,recovery:[]},{jsonOutput:Boolean(options.json)});process.exitCode=1;}
 });
}
