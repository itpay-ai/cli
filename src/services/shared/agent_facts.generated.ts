// Generated from compose-v4 apps/mcp/src/agentPresentation.ts; SHA-256 417e2e16a0387bf885e01fb8aa5cfb6c9c1fefdb89c4438c9af01828d4f09ebc.
// Canonical Personal Agent facts projection. Generated Buyer copies retain this
// source identity; strict itpay.chat.v1 and its consumers remain unchanged.
import {z} from 'zod';
const truth=z.union([z.boolean(),z.literal('unknown')]);
export const agentDisplaySchema=z.object({
 version:z.literal('itpay.agent.v1'),
 kind:z.enum(['result','selection','confirmation','handoff','progress','blocked','error']),
 state:z.string(),summary:z.string(),actions:z.array(z.object({purpose:z.string(),tool:z.string(),arguments:z.record(z.unknown()),requires_confirmation:z.boolean()}).strict()),acceptance:z.enum(['accepted','not_accepted','unknown']),
 references:z.record(z.string()),
 effects:z.object({persistent_task_created:truth,order_created:truth,inventory_held:truth,price_held:truth,payment_requested:truth,charged:truth,fulfilled:truth}).strict(),
 cost:z.object({classification:z.enum(['public_free','platform_subsidized','included_entitlement','user_paid','unknown']),settlement_state:z.string(),actual_charge:z.record(z.unknown()).nullable(),wallet_debited:truth}).strict(),
 coverage:z.record(z.unknown()),freshness:z.object({observed_at:z.string().nullable(),valid_until:z.string().nullable(),from_cache:truth}).strict(),
 links:z.array(z.object({kind:z.string(),purpose:z.string(),url:z.string(),access:z.literal('account_session'),expires_at:z.string().nullable()}).strict()),
 recovery:z.object({kind:z.enum(['read_original','complete_account_step','supply_missing_decision','wait','none']),reason_code:z.string().nullable()}).strict(),
 result:z.record(z.unknown()),untrusted_content:z.literal(true),
}).strict();
export type AgentFrame=z.infer<typeof agentDisplaySchema>;
function isRecord(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object'&&!Array.isArray(v);}
const object=(v:unknown):Record<string,unknown>=>isRecord(v)?v:{};
const text=(v:unknown):string|undefined=>typeof v==='string'&&v.length?v:undefined;
const fact=(v:unknown):boolean|'unknown'=>typeof v==='boolean'?v:'unknown';
const privateKeys=new Set(['display_token','complete_exchange_token','receipt_token','start_token','poll_token','access_token','refresh_token','session_token','private_key','authorization','api_key','provider_secret']);
function secretURL(value:string):boolean {
 try{const u=new URL(value);return Boolean(u.username||u.password||[...u.searchParams.keys()].some(k=>privateKeys.has(k.toLowerCase())||k.toLowerCase()==='token')||/(?:access_token|refresh_token|start_token|poll_token|display_token)=/i.test(u.hash));}catch{return false;}
}
// Preserve business content and scope, but never propagate transport secrets.
// Omitted values are explicit references-required facts, not silent truncation.
function publicData(value:unknown):unknown {
 if(Array.isArray(value))return value.map(publicData);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,privateKeys.has(key.toLowerCase())?{availability:'protected_transport_only'}:publicData(item)]));
 if(typeof value==='string'){if(secretURL(value))return {availability:'secure_reference_required'};return value.replace(/https?:\/\/[^\s<>"']+/gi,target=>secretURL(target)?'[protected reference]':target);}
 return value;
}
export function accountEntryLink(value:unknown,allowedOrigins:readonly string[]):string|undefined{
 const v=text(value);if(!v)return;
 try{const u=new URL(v);if(!allowedOrigins.includes(u.origin)||u.username||u.password||u.search||u.hash||!/^\/(?:checkout|orders)\/[^/]+$/.test(u.pathname))return;return u.href;}catch{return;}
}
export function presentAgent(value:unknown,options:{allowedOrigins:readonly string[];originalReferences?:Record<string,string>}):AgentFrame {
 const raw=object(value),service=object(raw.service);
 const appliedRoot=object(service.result);
 const applied=Object.keys(object(appliedRoot.original_result)).length?object(appliedRoot.original_result):appliedRoot;
 const checkout=Object.keys(object(service.checkout)).length?object(service.checkout):object(raw.checkout),handoff=applied.checkout_id?applied:object(service.handoff);
 const purchase=object(raw.review),sourceEffects=object(raw.effects);
 const refs:Record<string,string>={...options.originalReferences};
 const refKeys=['run_id','intent_id','operation_id','publication_id','request_ref','service_execution_id','source_service_execution_id','checkout_id','order_id','case_id','result_ref'];
 for(const source of [raw,service,applied,handoff,checkout,object(object(raw.result).case)])for(const key of refKeys){const v=text(source[key]);if(v)refs[key]=v;}
 const error=object(raw.error),summary=object(service.summary);
 let state=text(checkout.status)??text(applied.state)??text(service.state)??text(raw.execution_state)??text(raw.status)??text(object(object(raw.result).case).status)??'unknown';
 const acceptance:AgentFrame['acceptance']=raw.accepted===false?'not_accepted':raw.accepted===true||text(raw.run_id)||text(raw.service_execution_id)?'accepted':text(raw.intent_id)&&!text(raw.run_id)?'not_accepted':'unknown';
 const paymentReceived=['payment_succeeded','completed','refunded'].includes(text(checkout.status)??'');
 const links:AgentFrame['links']=[];
 const entry=object(raw.official_entry??object(raw.checkout).official_entry);
 const candidates=[...(Array.isArray(handoff.links)?handoff.links:[]),...(entry.url?[entry]:[])];
 for(const candidate of candidates){const c=object(candidate);if(c.access!=='account_session'&&handoff.handoff_access!=='account_session')continue;const url=accountEntryLink(c.url,options.allowedOrigins);if(url&&!links.some(l=>l.url===url))links.push({kind:text(c.kind)??'official_checkout',purpose:text(c.purpose)??'checkout',url,access:'account_session',expires_at:text(c.expires_at)??text(handoff.expires_at)??null});}
 if(['expired','cancelled','failed'].includes(state))links.length=0;
 let kind:AgentFrame['kind']=Object.keys(error).length?'error':['queued','running','in_flight','processing','started'].includes(state)?'progress':Object.keys(purchase).length?'confirmation':links.length?'handoff':state==='blocked'?'blocked':'result';
 if(state==='unknown'||state==='unavailable')kind='error';
 if(paymentReceived)state=checkout.status==='refunded'?'refunded':'payment_received';
 const settlement=text(raw.settlement_state)??'unknown';
 const costClass=object(raw.cost).classification;
 const classification=costClass==='public_free'||costClass==='platform_subsidized'||costClass==='included_entitlement'||costClass==='user_paid'?costClass:'unknown';
 const code=text(error.code)??text(summary.error_code)??text(applied.reason_code);
 const reason=code&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(code)?code:null;
 const result=object(publicData({...(Object.keys(purchase).length?{purchase_review:purchase}:{}),...(Object.keys(error).length?{error}:{}),...(service.summary!==undefined?{summary:service.summary}:{}),...(service.actions!==undefined?{available_choices:service.actions}:{}),...(service.result!==undefined?{service_result:service.result}:{}),...(raw.result!==undefined?{content:raw.result}:{}),...(Object.keys(checkout).length?{checkout}:{}),...(raw.effects!==undefined?{preparation_effects:raw.effects}:{})}));
 return agentDisplaySchema.parse({version:'itpay.agent.v1',kind,state,summary:state==='unknown'?'原任务状态尚未确认':kind==='progress'?'原任务处理中':kind==='handoff'?'请登录原账号办理':state==='payment_received'?'付款已确认，履约以原订单事实为准':'当前事实见 result',actions:[],acceptance,references:refs,
  effects:{persistent_task_created:fact(sourceEffects.persistent_task_created),order_created:fact(sourceEffects.order_created),inventory_held:fact(sourceEffects.inventory_held),price_held:fact(sourceEffects.price_held),payment_requested:fact(sourceEffects.payment_requested),charged:paymentReceived?true:fact(sourceEffects.charged),fulfilled:fact(sourceEffects.fulfilled)},
  cost:{classification,settlement_state:settlement,actual_charge:raw.actual_charge===undefined?null:object(publicData(raw.actual_charge)),wallet_debited:['captured','partially_refunded','refunded'].includes(settlement)?true:['free','reserved','released'].includes(settlement)?false:'unknown'},
  coverage:object(publicData(applied.coverage??summary.coverage??raw.coverage)),
  freshness:{observed_at:text(applied.observed_at)??text(summary.observed_at)??text(raw.updated_at)??null,valid_until:text(applied.expires_at)??text(summary.expires_at)??null,from_cache:fact(applied.from_cache??summary.from_cache)},links,
  recovery:{kind:kind==='confirmation'?'supply_missing_decision':links.length?'complete_account_step':refs.run_id||refs.service_execution_id?'read_original':'none',reason_code:reason},result,untrusted_content:true});
}
