import { qualifyHubInstallation } from "../state/hub_installation.js";
import {HttpError} from "../client/http.js";
import {declaredAgentType,qualifyItPayCommand} from "../state/agent_type.js";

// Hub command protocol. Credentials are never added to this output envelope.
export interface CommandAction { command: string; reason: string; poll_after_ms?: number; read_only?: {method: "GET"; path: string} }
export interface CommandEnvelope {
 status: string;
 result?: unknown;
 error?: {code: string; message: string; details?: unknown};
 instruction: string;
 next: CommandAction | null;
 recovery: CommandAction[];
 [key: string]: unknown;
}
export function writeCommandEnvelope(value: CommandEnvelope, options: {jsonOutput?: boolean; output?: (text: string) => void; plainResult?: string[]} = {}): void {
 // Carry only public configuration into executable follow-ups. Never copy
 // token/key fields or an URL containing userinfo, query credentials or hash.
 const qualify=(action:CommandAction):CommandAction|null=>{
  if(!action.command.startsWith("itpay ")) return action;
  const installed = qualifyHubInstallation(action.command);
  if (installed) return {...action,command:qualifyItPayCommand(installed,declaredAgentType())};
  const assignments:string[]=[];
  for(const name of ["ITPAY_HUB_URL","ITPAY_HUB_OAUTH_ISSUER","ITPAY_HUB_OAUTH_CLIENT","ITPAY_HUB_OAUTH_SCOPE","ITPAY_STATE_DIR"]){
   const raw=process.env[name];if(!raw)continue;
   if(name==="ITPAY_HUB_URL"||name==="ITPAY_HUB_OAUTH_ISSUER"){
    try{const u=new URL(raw);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)return null}catch{return null}
   }
   const quoted="'"+raw.replaceAll("'", "'\"'\"'")+"'";
   assignments.push(name+"="+quoted);
  }
  return {...action,command:[...assignments,qualifyItPayCommand(action.command,declaredAgentType())].join(" ")};
 };
 value={...value,instruction:value.instruction+" "+routingInstruction(value),next:value.next?qualify(value.next):null,recovery:value.recovery.map(qualify).filter((action):action is CommandAction=>action!==null)};
 const out = options.output ?? ((text: string) => { process.stdout.write(text); });
 if (options.jsonOutput) { out(JSON.stringify(value, null, 2) + "\n"); return; }
 out(value.status + "\n");
 for (const line of options.plainResult ?? [JSON.stringify(value.error ?? value.result ?? {}, null, 2)]) out(line + "\n");
 out("instruction: " + value.instruction + "\n");
 if (value.next) out("next: " + value.next.command + "\n  when: " + value.next.reason + "\n");
 for (const action of value.recovery) out("recovery: " + action.command + "\n  when: " + action.reason + "\n");
}

export function hubFailureInstruction(error: unknown, fallback: string): string {
 if(!(error instanceof HttpError)) return fallback;
 if((error.code === "request_timeout" || error.code === "request_cancelled") && error.message.includes("outcome is unknown")) return "提交结果未知；保留原身份、入口、幂等键及请求引用，先读取原任务，不换路重发或重新付款。";
 if(error.code === "request_timeout" || error.code === "request_cancelled") return "Hub 读取超时或已取消，未取得当前事实；这不表示操作未发布或消费预算不足。保留原身份、条件及已有请求引用，稍后读取；不换路重发。";
 if(error.status === 404) return "该操作或原引用当前不存在或不可见；核对原编号及可见发布，不猜替代操作。";
 if(error.status === 403) return "当前凭据权限或授权范围不足；核对实际拒绝原因及官方授权，保留原身份和请求，不换入口绕过。";
 return fallback;
}

function routingInstruction(value: CommandEnvelope): string {
 const result = value.result && typeof value.result === "object" ? value.result as Record<string,unknown> : {};
 const original = ["request_id","run_id","intent_id","order_id","topup_id"].some(key=>typeof result[key]==="string" && result[key]!=="") || ["unknown","unavailable"].includes(value.status) || ["hub_request_unknown","request_timeout","request_cancelled"].includes(value.error?.code ?? "");
 return original ? "继续原身份、入口和已有请求引用，不换路重发。" : "当前为 API Hub；办理、交付与售后使用 Services，空结果只限当前目录及条件。";
}
