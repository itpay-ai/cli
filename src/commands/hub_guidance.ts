import {declaredAgentType,qualifyItPayCommand} from "../state/agent_type.js";

// Hub command protocol. Credentials are never added to this output envelope.
export interface CommandAction { command: string; reason: string; poll_after_ms?: number }
export interface CommandEnvelope {
 status: string;
 result?: unknown;
 error?: {code: string; message: string};
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
 value={...value,next:value.next?qualify(value.next):null,recovery:value.recovery.map(qualify).filter((action):action is CommandAction=>action!==null)};
 const out = options.output ?? ((text: string) => { process.stdout.write(text); });
 if (options.jsonOutput) { out(JSON.stringify(value, null, 2) + "\n"); return; }
 out(value.status + "\n");
 for (const line of options.plainResult ?? [JSON.stringify(value.error ?? value.result ?? {}, null, 2)]) out(line + "\n");
 out("instruction: " + value.instruction + "\n");
 if (value.next) out("next: " + value.next.command + "\n  when: " + value.next.reason + "\n");
 for (const action of value.recovery) out("recovery: " + action.command + "\n  when: " + action.reason + "\n");
}
