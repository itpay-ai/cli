import {existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {actualAgentType,runConnection} from "./agent.js";
import {servicesConnectionRoot,readConnectionBroker,prepareAgentConnection} from "../state/agent_connection.js";
import {stateDir,resolveBackendURL} from "../state/config.js";
import {selectedHubInstallationPath,qualifyHubInstallation} from "../state/hub_installation.js";
import {hubCredentialKind,hubCredentialsPath} from "../state/hub_credentials.js";
import {hubDeviceStatus} from "../state/hub_device.js";
import {saveAgentTask} from "../state/agent_task.js";

// Compatibility entry points share the agent lifecycle; old accepted work stays put.
export async function firstConnection(surface:"api"|"services",json:boolean,wait=120):Promise<boolean>{
 const backend=resolveBackendURL(),original=stateDir(),type=actualAgentType(),selector=selectedHubInstallationPath();
 if(surface==="api"&&!selector)return false;
 const broker=surface==="api"?readConnectionBroker(hubCredentialsPath()+".agent-connection.json"):undefined;
 if(surface==="api"&&!broker?.state.connection_id&&(hubCredentialKind()!=="none"||hubDeviceStatus().phase!=="disconnected"))return false;
 const root=surface==="api"?(broker?.root??dirname(selector!)):servicesConnectionRoot(original,backend,type);
 const saved=existsSync(join(root,"task.json"))?saveAgentTask(root,undefined,undefined,undefined):undefined;
 try{
  await runConnection({root,type,surface,json,wait,prepared:surface==="api",servicesDirectory:surface==="services"?original:undefined,task:saved?.surface===surface?saved:undefined,command:surface==="api"?qualifyHubInstallation("itpay api connect --json")!:"itpay auth login --json"});
 }catch(error){
  if((error as {http_status?:number}).http_status===404&&!prepareAgentConnection(root,backend,type)?.connection_id)return false;
  throw error;
 }
 return true;
}
