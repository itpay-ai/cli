import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {actualAgentType} from './agent.js';
import {prepareAgentConnection,connectAgent,bindAgentServices,saveAgentConnection} from '../state/agent_connection.js';
import {stateDir,taskJournalPath,resolveBackendURL,loadConfig,newBackendClient} from '../state/config.js';
import {readAuthState} from '../state/auth_storage.js';
import {selectedHubInstallationPath} from '../state/hub_installation.js';
import {hubCredentialKind,hubCredentialsPath} from '../state/hub_credentials.js';
import {connectHubDevice,hubDeviceStatus} from '../state/hub_device.js';
import {writeCommandEnvelope} from './guidance.js';
import {currentAccountLabel} from './hub.js';

// First-connection wrappers reuse their original installation and signing key.
// Existing flows, credentials and task journals never enter this path.
export async function firstConnection(surface:'api'|'services',json:boolean,wait=120):Promise<boolean>{
 const backend=resolveBackendURL(),original=stateDir();
 const selector=selectedHubInstallationPath();
 if(surface==='api'&&!selector)return false;
 const root=surface==='api'?dirname(selector!):original;
 const saved=existsSync(join(root,'connection.json'));
 if(!saved&&existsSync(hubCredentialsPath()+'.agent-connection.json')&&surface==='api')return false;
 if(!saved){
  if(surface==='api'&&(hubCredentialKind()!=='none'||hubDeviceStatus().phase!=='disconnected'))return false;
  if(surface==='services'){
   if(readAuthState(backend,process.env,'agent-login')||existsSync(taskJournalPath())||existsSync(taskJournalPath()+'.d'))return false;
   const status=await newBackendClient(loadConfig()).agentAccountStatus();
   if(status.status==='authenticated')return false;
   if(status.status!=='login_required')throw new Error('original device account status unavailable');
  }
 }
 const state=prepareAgentConnection(root,backend,actualAgentType(),{surface,prepared:true,...(surface==='services'?{services_directory:original}:{})});
 if(!state)return false;
 const command=surface==='api'?'itpay api connect --json':'itpay auth login --json';
 const emit=(status:string,result:Record<string,unknown>,instruction:string,pending=false)=>writeCommandEnvelope({status,result,instruction,next:pending?{command,reason:'立即等待同一原连接，无需本人回话'}:null,recovery:[]},{jsonOutput:json});
 const deadline=Date.now()+wait*1000;
 let view;
 try{view=await connectAgent(root,state)}catch(error){if(!state.connection_id&&(error as {http_status?:number}).http_status===404)return false;throw error}
 if(view.status==='pending'){
  emit('pending',{authorization:view},'展示此官方链接；本人确认一次后自动继续原任务。立即按next等待。',true);
  while(view.status==='pending'&&Date.now()<deadline){await sleep(Math.min(2000,deadline-Date.now()));view=await connectAgent(root,state)}
 }
 if(view.status!=='active'){emit(view.status,{authorization:view},'保留同一连接；拒绝或撤销后停止，不自动重开。',view.status==='pending');return true}
 if(view.enabled_surfaces&&!view.enabled_surfaces.includes(surface)){emit('surface_not_enabled',{},'此项未获开通；保留原连接，不自动扩大授权。');return true}
 if(surface==='services'){
  await bindAgentServices(root,state);
  const info=view.account_information;
  emit('authenticated',{account_information:info},'当前账号：'+(info?.display_name||'名称未设置')+' · '+(info?.account_hint||'…'+view.buyer_id.slice(-6))+'\n账号已连接。继续原任务。');
 }else{
  saveAgentConnection(hubCredentialsPath()+'.agent-connection.json',{root,state});
  let result=await connectHubDevice(undefined,0);
  if(result.phase==='pending'&&Date.now()<deadline)result=await connectHubDevice(result.handle,Math.max(0,Math.floor((deadline-Date.now())/1000)));
  emit(result.phase,result.phase==='pending'?{phase:result.phase,handle:result.handle}:result,result.phase==='connected'?(await currentAccountLabel())+'\n账号已连接。继续原任务。':'正在保存原API连接，保留原句柄继续等待。',result.phase==='pending');
 }
 return true;
}
