import {createHash,createPublicKey,randomUUID,sign} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createDeviceKey} from './device_key.js';
import {withFileLock} from './file_lock.js';
import {canonicalAgentType} from './agent_type.js';
import {CLI_VERSION,API_CONTRACT_REVISION} from './release_identity.js';
import {DeviceAuthority} from './device_authority.js';

export type AgentConnectionState={backend:string;agent_type:string;start_key:string;connection_id?:string;buyer_id?:string};
export type AgentConnectionView={connection_id:string;status:string;agent_type:string;buyer_id:string;url?:string};
function readPrivate<T>(path:string):T|undefined {
 if(!existsSync(path))return;
 const st=lstatSync(path);if(!st.isFile()||(st.mode&0o077)!==0)throw new Error('Agent connection state must be a private regular file');
 return JSON.parse(readFileSync(path,'utf8')) as T;
}
export function saveAgentConnection(path:string,value:unknown):void {
 mkdirSync(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID();writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,path);
}
// A legacy root remains on its original authorization path. Never infer ownership
// of an existing consumer from a public type or move accepted requests to a new one.
export function prepareAgentConnection(root:string,backend:string,type:string):AgentConnectionState|undefined {
 const path=join(root,'connection.json');mkdirSync(root,{recursive:true,mode:0o700});
 return withFileLock(path+'.lock',()=>{
  const current=readPrivate<AgentConnectionState>(path);
  if(current){createDeviceKey(join(root,'services','device','device-private.pem'),true);if(current.backend!==backend||current.agent_type!==canonicalAgentType(type))throw new Error('original Agent connection endpoint/type changed');return current;}
  if(existsSync(join(root,'api','api-profile.json'))||existsSync(join(root,'services','device','identity.json'))||existsSync(join(root,'services','device','sessions')))return;
  createDeviceKey(join(root,'services','device','device-private.pem'),false);
  const value={backend,agent_type:canonicalAgentType(type)!,start_key:randomUUID()};saveAgentConnection(path,value);return value;
 });
}
export async function agentConnectionRequest(root:string,state:AgentConnectionState,path:string,body?:Record<string,unknown>,extra:Record<string,string>={}):Promise<Response> {
 const key=createDeviceKey(join(root,'services','device','device-private.pem'),true);
 const raw=body===undefined?'':JSON.stringify(body),method=body===undefined?'GET':'POST';
 const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();
 const message=['itpay-agent-connection/v1',method,path,createHash('sha256').update(raw).digest('hex'),timestamp,nonce].join('\n');
 return fetch(state.backend+path,{method,redirect:'error',signal:AbortSignal.timeout(30_000),headers:{'X-ItPay-CLI-Version':CLI_VERSION,'X-ItPay-Contract-Revision':API_CONTRACT_REVISION,...extra,'Content-Type':'application/json','X-ItPay-Connection-Time':timestamp,'X-ItPay-Connection-Nonce':nonce,'X-ItPay-Connection-Proof':sign(null,Buffer.from(message),key).toString('base64url')},...(body===undefined?{}:{body:raw})});
}
export async function connectAgent(root:string,state:AgentConnectionState,restart=false):Promise<AgentConnectionView> {
 const key=createDeviceKey(join(root,'services','device','device-private.pem'),true);
 const response=await agentConnectionRequest(root,state,'/v1/agent-connections/start',{public_key:createPublicKey(key).export({format:'jwk'}).x!,agent_type:state.agent_type,start_key:state.start_key,...(restart?{restart:true}:{})});
 if(!response.ok)throw Object.assign(new Error(`original Agent connection unavailable (${response.status}); keep its task and key`),{code:response.status===503?"agent_connection_pending":"agent_connection_failed"});
 const view=await response.json() as AgentConnectionView;
 if(!/^acn_[A-Za-z0-9_-]+$/.test(view.connection_id)||view.agent_type!==state.agent_type||!['pending','active','expired','denied','revoked'].includes(view.status))throw new Error('invalid Agent connection response');
 if(state.connection_id&&state.connection_id!==view.connection_id)throw new Error('original Agent connection changed');
 if(state.buyer_id&&view.buyer_id!==state.buyer_id)throw new Error('original Agent account changed');
 if(view.url){const url=new URL(view.url);if(url.origin!==new URL(state.backend).origin||url.pathname!==`/agent/connect/${view.connection_id}`||url.username||url.password||url.hash)throw new Error('Agent connection link mismatch');}
 state.connection_id=view.connection_id;if(view.buyer_id)state.buyer_id=view.buyer_id;
 saveAgentConnection(join(root,'connection.json'),state);return view;
}
export async function bindAgentServices(root:string,state:AgentConnectionState):Promise<void> {
 if(!state.connection_id||!state.buyer_id)throw new Error('original Agent approval is required');
 const path=`/v1/agent-connections/${state.connection_id}/services`;
 const authority=new DeviceAuthority({baseURL:state.backend,requestedAgentType:state.agent_type,compatibilityHeaders:{'X-ItPay-CLI-Version':CLI_VERSION,'X-ItPay-Contract-Revision':API_CONTRACT_REVISION},statePath:join(root,'services','device','identity.json'),privateKeyPath:join(root,'services','device','device-private.pem')});
 for(let attempt=0;attempt<2;attempt++){
  const headers=await authority.authorizationHeaders({method:'POST',path,body:'{}'});
  const response=await agentConnectionRequest(root,state,path,{},headers);
  if(response.ok)return;
  if(attempt===0&&response.status===401){
   const error=await response.json() as {code?:string};
   if(error.code==='agent_device_session_required'){await authority.recoverAuthorization();continue;}
  }
  throw new Error(`original Services binding unavailable (${response.status}); keep the original Agent identity`);
 }
}
