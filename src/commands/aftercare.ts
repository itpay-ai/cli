import type {BackendClient} from "../client/backend.js";
import type {CLIConfig} from "../state/config.js";
import {serviceAdapter} from "../services/registry.js";
import {CommandContractError} from "../services/shared/envelope.js";
function adapter(identity:Parameters<typeof serviceAdapter>[0]){
 const capability=serviceAdapter(identity).aftercare;
 if(!capability)throw new CommandContractError("aftercare_unsupported","Locked service does not support this aftercare operation","使用原服务声明的售后入口，不套用其他业务规则。",[]);
 return capability;
}
export async function runAftercareList(backend:BackendClient,orderID:string){const value=await backend.listRailAftercare(orderID);return adapter(value.execution_identity).directory(value,orderID);}
export async function runAftercareGet(backend:BackendClient,id:string){const value=await backend.getRailAftercare(id);return adapter(value.execution_identity).present(value);}
export async function runAftercareCreate(backend:BackendClient,config:CLIConfig,orderID:string,input:unknown){const value=await backend.listRailAftercare(orderID);return adapter(value.execution_identity).create(backend,config,orderID,input);}
export async function runAftercareRespond(backend:BackendClient,id:string,input:unknown,cancel=false){const value=await backend.getRailAftercare(id);return adapter(value.execution_identity).respond(backend,id,input,cancel);}
