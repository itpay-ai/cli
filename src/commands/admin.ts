import {readFileSync} from "node:fs";
import {HubClient,loadHubConfig} from "../client/hub.js";
const actions=new Set(['operations_list','ingestions_list','import_github','ingestion_status','ingestion_retry','credentials_list','credential_put','source_requirements','source_bind','acceptance_status','acceptance_set']);
export function parseAdminInput(action:string,raw:string):Record<string,unknown>{
 if(!actions.has(action))throw Error('unknown admin action');if(Buffer.byteLength(raw)>128*1024)throw Error('admin input exceeds 128 KiB');
 const args:unknown=JSON.parse(raw);if(!args||Array.isArray(args)||typeof args!=='object')throw Error('JSON object required');return args as Record<string,unknown>;
}
export async function runAdminCommand(action:string,source:string):Promise<void>{
 if(source!=='-'&&!source.startsWith('@'))throw Error('Use stdin or a private file, never secret command arguments');
 if(action==='credential_put'&&source!=='-')throw Error('credential_put accepts stdin only');
 const raw=readFileSync(source==='-'?0:source.slice(1),'utf8');const args=parseAdminInput(action,raw);
 const cfg=loadHubConfig();if(!cfg.apiKey||cfg.bearerToken)throw Error('Explicit scoped ITPAY_HUB_KEY required');
 const out=await new HubClient(cfg).adminTool(action,args);
 if(out.error)throw Error('admin request denied');
 for(const content of out.result?.content||[])if(content.type==='text')process.stdout.write(content.text+'\n');
 if(out.result?.isError)process.exitCode=1;
}
