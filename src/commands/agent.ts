import {prepareAgentConnection,connectAgent,bindAgentServices,saveAgentConnection,servicesConnectionRoot} from "../state/agent_connection.js";
import {hubCredentialsPath,importHubKey} from "../state/hub_credentials.js";
import {describeAccount,currentAccountLabel,describeHubIdentity} from "./hub.js";
import {HubClient,loadHubConfig} from "../client/hub.js";
import {existsSync,readFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import type {Command} from "commander";
import {canonicalAgentType,declaredAgentType,AgentTypeRequiredError} from "../state/agent_type.js";
import {prepareHubInstallation,selectHubInstallation,shellQuote,selectedHubInstallationPath} from "../state/hub_installation.js";
import {connectHubDevice,hubDeviceStatus} from "../state/hub_device.js";
import {saveAgentTask,recordAgentAuthorization,type SavedTask} from "../state/agent_task.js";
import {hubOAuthConfig} from "../state/hub_oauth.js";
import {agentRoot,stateDir,loadConfig,newBackendClient,resolveBackendURL} from "../state/config.js";
import {agentAuth} from "../state/account_auth.js";
import {isInstallAgentType} from "./install.js";
import {writeCommandEnvelope} from "./guidance.js";
export {agentRoot} from "../state/config.js";

// Explicit runtime identity wins. Never infer a host from an old device or HOME path.
export function actualAgentType(env: NodeJS.ProcessEnv = process.env): string {
 const explicit = declaredAgentType({},process.argv);
 if (explicit) {if(isInstallAgentType(explicit))return explicit;throw new Error('unsupported actual --agent-type');}
 const signals = [env.CODEX_THREAD_ID ? "codex-desktop" : undefined, env.CLAUDECODE ? "claude-code-desktop" : undefined,
  env.MUSE_SESSION_ID ? "muse" : undefined, env.DOT_SESSION_ID ? "dot" : undefined, env.WORKBUDDY_SESSION_ID ? "workbuddy" : undefined].filter(Boolean);
 if (signals.length === 1) return signals[0]!;
 if(signals.length===0 && env.ITPAY_AGENT_TYPE){const configured=canonicalAgentType(env.ITPAY_AGENT_TYPE);if(configured&&isInstallAgentType(configured))return configured;}
 throw Object.assign(new AgentTypeRequiredError(),{message:"host_context_required: Agent must supply its own actual --agent-type; do not ask the user to choose an identity"});
}

type ConnectionOptions={root:string;type:string;surface:"api"|"services";wait:number;json:boolean;buffered?:boolean;reconnect?:boolean;task?:SavedTask|undefined;command?:string;prepared?:boolean;servicesDirectory?:string|undefined};
export async function runConnection(options:ConnectionOptions):Promise<void>{
 const {root,type,surface,wait,task}=options;
 const executable=resolve(process.argv[1]!);process.env.ITPAY_AGENT_EXECUTABLE=executable;
 const publicEnv=`ITPAY_AGENT_EXECUTABLE=${shellQuote(executable)} ITPAY_HUB_OAUTH_ISSUER=${shellQuote(new URL(hubOAuthConfig().tokenURL).origin)} ITPAY_BACKEND_URL=${shellQuote(resolveBackendURL())} ITPAY_HUB_URL=${shellQuote(hubOAuthConfig().resource)} ${process.env.ITPAY_AGENT_HOME?'ITPAY_AGENT_HOME='+shellQuote(process.env.ITPAY_AGENT_HOME)+' ':''}`;
 const again=options.command??`${publicEnv}${shellQuote(process.execPath)} ${shellQuote(executable)} --agent-type ${type} agent --wait 120 --json`;
 const emit=(status:string,result:Record<string,unknown>,instruction:string,next:string|null=null)=>writeCommandEnvelope({status,result:{...result,...(task?{task}:{}),agent_type:type},instruction,next:next?{command:next,reason:status==="pending"?"立即等待原连接，无需用户回复":"继续原任务"}:null,recovery:[]},{jsonOutput:options.json});
 try{
  if(task?.authorization_terminal&&!options.reconnect){emit(task.authorization_terminal,{},"本人已拒绝或取消；只有明确重连才重新发起。");return;}
  if(options.reconnect&&task)recordAgentAuthorization(root,undefined);
  const selected=surface==="api"?loadHubConfig():undefined;
  const common=selected?.apiKey?undefined:prepareAgentConnection(root,resolveBackendURL(),type,{surface,...(options.prepared?{prepared:true}:{}),...(options.servicesDirectory?{services_directory:options.servicesDirectory}:{})});
  const installation=surface==="api"?(selectedHubInstallationPath()?{selector:selectedHubInstallationPath()!}:prepareHubInstallation(join(root,"api"),undefined,common?{root,state:common}:null)):undefined;
  if(installation)selectHubInstallation(installation.selector);
  const apiNext=installation?`${publicEnv}${shellQuote(process.execPath)} ${shellQuote(executable)} --agent-type ${type} api --profile ${shellQuote(installation.selector)} ${task?.request_id?'status '+task.request_id:'list'} --json`:null;
  if(selected?.apiKey){
   const installed=loadHubConfig();
   if(selected.baseURL!==installed.baseURL||task?.request_id&&installed.apiKey!==selected.apiKey)throw new Error("credential_conflict: keep the original request credential");
   if(!process.env.ITPAY_HUB_KEY)importHubKey(selected.apiKey,installed.baseURL);
   const me=await new HubClient(loadHubConfig()).me();
   emit("connected",{selector:installation!.selector,identity:describeHubIdentity(me,"api_key")},describeAccount(me)+"\n使用所选 API Key；继续原任务。",apiNext);return;
  }
  let summary:Record<string,string>={},initial=false;
  if(common){
   let view=await connectAgent(root,common,Boolean(options.reconnect),surface);
   if(view.status==="active"&&view.enabled_surfaces&&!view.enabled_surfaces.includes(surface))view=await connectAgent(root,common,true,surface);
   const deadline=Date.now()+wait*1000;
   while(view.status==="pending"){
    initial ||= !common.buyer_id&&view.enabled_surfaces?.length===1&&view.enabled_surfaces.includes(surface);
    const {enabled_surfaces,...authorization}=view;
    emit("pending",{authorization},"展示原官方链接；本人确认后继续原任务。",again);
    if(options.buffered||Date.now()>=deadline)return;
    await sleep(Math.min(2000,deadline-Date.now()));
    view=await connectAgent(root,common,false,surface);
   }
   if(view.status!=="active"){if(view.status==="denied"&&task)recordAgentAuthorization(root,"denied");emit(view.status,{authorization:{status:view.status}},"保留原任务和连接；拒绝或撤销后停止。");return;}
   summary=Object.fromEntries(["services","api"].map(item=>[item,view.enabled_surfaces?.includes(item)?"enabled":"consent_required"]));
   if(summary[surface]!=="enabled"){emit("surface_not_enabled",{connection_id:view.connection_id,surfaces:summary},"此项尚未开通；保留原连接，明确需要时在原页补充同意。");return;}
  }
  const other=surface==="api"?"services":"api",label=other==="api"?"API":"Services";
  const message=summary[other]==="consent_required"?
   `${label} 未开通：${initial?"你在确认页取消了勾选。":""}以后用到 ${label} 时，会在这条连接上请你补充确认。`:"Services 和 API 均已开通。继续原任务。";
  if(surface==="api"){
   if(common)saveAgentConnection(hubCredentialsPath()+".agent-connection.json",{root,state:common});
   let result=hubDeviceStatus();
   if(result.phase==="connected")try{
    const me=await new HubClient(loadHubConfig()).me();
    if(common&&me.buyer_id!==new URL(hubOAuthConfig().tokenURL).origin+"|"+common.buyer_id)throw new Error("original Agent API account changed");
   }catch(error){if(!(error instanceof Error&&error.message.startsWith("authorization_required:")))throw error;result={phase:"disconnected"};}
   if(result.phase!=="connected"){
    result=await connectHubDevice(undefined,0,task?.request_id);
    if(result.phase==="pending"){
     emit("pending",{...result,...(common&&!result.approval_required?{url:undefined}:{}),selector:installation!.selector},!common||result.approval_required?"展示原官方链接并等待确认。":"连接正在准备；按原 next 继续。",again);
     if(options.buffered||wait===0)return;
     result=await connectHubDevice(result.handle as string,wait);
    }
   }
   if((result.phase==="denied"||result.phase==="cancelled")&&task)recordAgentAuthorization(root,result.phase);
   emit(String(result.phase),{...result,selector:installation!.selector,...(common?{connection_id:common.connection_id,surfaces:summary}:{})},result.phase==="connected"?(await currentAccountLabel())+"\n"+(common?message:"账号已连接；继续原任务。"):"保留原连接和任务。",result.phase==="connected"?apiNext:result.phase==="pending"?again:null);return;
  }
  process.env.ITPAY_STATE_DIR=common?(common.services_directory??join(root,"services")):(options.servicesDirectory??join(root,"services"));
  const backend=newBackendClient(loadConfig());
  if(common)await bindAgentServices(root,common);
  let result=await agentAuth("status",resolveBackendURL(),backend) as Record<string,unknown>;
  if(["login_required","auth_pending","auth_expired","auth_session_missing"].includes(String(result.status)))result=await agentAuth("login",resolveBackendURL(),backend) as Record<string,unknown>;
  const deadline=Date.now()+wait*1000;
  while(result.status==="auth_pending"&&!options.buffered&&Date.now()<deadline){emit("pending",{authorization:result},"展示原官方登录入口并继续等待。",again);await sleep(Math.min(2000,deadline-Date.now()));result=await agentAuth("status",resolveBackendURL(),backend) as Record<string,unknown>;}
  if((result.status==="auth_denied"||result.status==="auth_cancelled")&&task)recordAgentAuthorization(root,result.status==="auth_denied"?"denied":"cancelled");
  const next=`${publicEnv}ITPAY_STATE_DIR=${shellQuote(process.env.ITPAY_STATE_DIR)} ${shellQuote(process.execPath)} ${shellQuote(executable)} --agent-type ${type} next --json`;
  emit(result.status==="authenticated"?(task?"connected":"authenticated"):String(result.status),{authorization:result,state_directory:process.env.ITPAY_STATE_DIR,...(common?{connection_id:common.connection_id,surfaces:summary}:{})},result.status==="authenticated"?(common?message:String(result.instruction??"账号已连接；继续原任务。")):"保留原登录与任务。",result.status==="authenticated"?next:result.status==="auth_pending"?again:null);
 }catch(error){
  if((error as {code?:string}).code==="agent_connection_pending"){emit("pending",{},"原连接仍在准备；按原 next 继续。",again);return;}
  throw error;
 }
}

export function registerAgentCommand(program:Command):void{
 program.command("agent").description("Prepare the requested path and retain its original task")
 .option("--task <text>","original user task or @private-file")
 .option("--surface <surface>","api or services")
 .option("--reconnect","explicit request to reconnect")
 .option("--new-task","explicitly new intent")
 .option("--request <id>","original API request")
 .option("--wait <seconds>","wait 0..120 seconds","120")
 .option("--buffered","return link before waiting")
 .option("--json","JSON progress and final status")
 .action(async options=>{
  try{
   const type=actualAgentType();process.env.ITPAY_AGENT_TYPE=type;
   const original=stateDir(),canonical=agentRoot(type);
   const root=(existsSync(join(canonical,"connection.json"))||existsSync(join(canonical,"task.json")))?canonical:servicesConnectionRoot(original,resolveBackendURL(),type);
   const wait=Number(options.wait);if(!Number.isInteger(wait)||wait<0||wait>120)throw new Error("wait must be 0..120");
   const text=options.task?.startsWith("@")?readFileSync(options.task.slice(1),"utf8"):options.task;
   const task=saveAgentTask(root,text,options.surface,options.request,Boolean(options.newTask));
   await runConnection({root,type,surface:task.surface,task,wait,json:Boolean(options.json),buffered:options.buffered,reconnect:options.reconnect,servicesDirectory:root===canonical?join(root,"services"):original});
  }catch(error){writeCommandEnvelope({status:"error",error:{code:"agent_prepare_failed",message:error instanceof Error?error.message:"Agent preparation failed"},instruction:"保留原任务、凭据与连接，不换身份或重发业务。",next:null,recovery:[]},{jsonOutput:Boolean(options.json)});process.exitCode=1;}
 });
}
