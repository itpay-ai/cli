import { AgentTaskConflict, attachAgentRequest } from "../state/agent_task.js";
import {storedHubProfile,hubCredentialKind} from "../state/hub_credentials.js";
import { selectedHubInstallationPath } from "../state/hub_installation.js";
import {HubClient,loadHubConfig,hubErrorDetails,safePriceChange,type PublicPriceChange,type RunReceipt,type RequestStatus} from "../client/hub.js";
import {HttpError} from "../client/http.js";
import {HubTaskStore,type HubTask} from "../state/hub_tasks.js";
import {loadShown,saveShown,type ShelfDescriptor} from "../state/hub_show_cache.js";
import {HubTaskRequestError,readRunInput,TOPUP_INSTRUCTION,CREDIT_GUIDANCE,currentAccountLabel} from "./hub.js";
import {writeCommandEnvelope,type CommandAction} from "./hub_guidance.js";

type Facts=RunReceipt&{held_atoms?:string;captured_atoms?:string;result_expires_at?:string};
type Snapshot=RequestStatus&{price_change?:PublicPriceChange;required_action?:{web_action?:{target?:string};target?:string}};
const client=()=>new HubClient(loadHubConfig());
export function priceLabel(price:{mode:string;amount_atoms?:string;unit?:string}):string{
 if(price.mode==="free")return "免费";
 const atoms=BigInt(price.amount_atoms??"0");
 const fraction=(atoms%1000000n).toString().padStart(6,"0").replace(/0+$/,"");
 return ""+atoms/1000000n+(fraction?"."+fraction:"")+" credit/"+(price.unit==="page"?"页":price.unit==="call"||!price.unit?"次":price.unit);
}
function statusAction(id:string,json:boolean):CommandAction{
 return {command:`itpay api status ${id}${json?" --json":""}`,reason:"只读核对原请求"};
}
function pendingAction(id:string,json:boolean):CommandAction{
 return {command:`itpay api call --pending ${id}${json?" --json":""}`,reason:"等待并接续同一原请求"};
}
function remember(store:HubTaskStore,task:HubTask,snapshot:Snapshot):HubTask{
 if(snapshot.request_id!==store.idempotencyKey(task.request_id))throw new Error("invalid_state: original request binding changed");
 if(task.credential_recovery&&!snapshot.credential_recovery)throw new Error("invalid_state: missing credential recovery binding");
 if(task.run_id&&!snapshot.run&&!snapshot.credential_recovery)throw new Error("invalid_state: original execution binding changed");
 if(snapshot.run){
  if(snapshot.run.operation_id!==task.operation_id || snapshot.run.publication_id!==task.publication_id ||
     !snapshot.credential_recovery && task.run_id && task.run_id!==snapshot.run.run_id)throw new Error("invalid_state: original execution binding changed");
  const updated=store.update(task.request_id,{run_id:snapshot.run.run_id,
   status:snapshot.run.execution_state==="succeeded"?"succeeded":["failed","cancelled"].includes(snapshot.run.execution_state)?"failed":"dispatched",
   terminal:snapshot.terminal,state_source:"hub",state_stale:false},snapshot)!;
  const success=snapshot.run.execution_state==="succeeded" && ["free","captured","released","refunded","partially_refunded"].includes(snapshot.run.settlement_state);
  const failedFree=["failed","cancelled"].includes(snapshot.run.execution_state) && ["free","released"].includes(snapshot.run.settlement_state) && snapshot.run.captured_atoms==="0";
  if(snapshot.terminal && (success||failedFree) && snapshot.run.held_atoms==="0" && !snapshot.credential_recovery)attachAgentRequest(selectedHubInstallationPath(),task.request_id,true);
  return updated;
 }
 if(snapshot.intent){
  if(task.intent_id && task.intent_id!==snapshot.intent.intent_id)throw new Error("invalid_state: original intent binding changed");
  return store.update(task.request_id,{intent_id:snapshot.intent.intent_id,status:snapshot.terminal?"failed":"blocked",
   blocking_reason:snapshot.intent.blocking_reason,terminal:snapshot.terminal,state_source:"hub",state_stale:false},snapshot)!;
 }
 throw new Error("invalid_state: original request has no receipt");
}
function absentDeviceConsent(error:unknown,task:HubTask,requestKey:string):boolean{
 if(!(error instanceof HttpError)||error.status!==404||task.run_id||task.intent_id||task.terminal||task.credential_mode!=="platform"||hubCredentialKind()==="api_key")return false;
 const detail=hubErrorDetails(error),profile=storedHubProfile();
 if(detail?.request_admission!=="not_admitted"||detail.request_id!==requestKey||!profile?.device_approval_id||detail.device_approval_id!==profile.device_approval_id||typeof detail.device_consent_limit_atoms!=="string"||!/^\d+$/.test(detail.device_consent_limit_atoms)||!task.max_charge_atoms||!/^\d+$/.test(task.max_charge_atoms))return false;
 return BigInt(task.max_charge_atoms)>BigInt(detail.device_consent_limit_atoms);
}
function deviceConsentPending(snapshot:Snapshot):boolean{
 return !snapshot.run&&!snapshot.terminal&&["authorization_denied","authorization_revoked","budget_exceeded"].includes(snapshot.intent?.blocking_reason??"")&&hubCredentialKind()!=="api_key"&&Boolean(storedHubProfile()?.device_approval_id);
}
async function render(task:HubTask,snapshot:Snapshot,json:boolean):Promise<void>{
 const run=snapshot.run as Facts|undefined;
 if(run){
  const zero=run.captured_atoms==="0" && run.held_atoms==="0";
  const balanceNotice=(run as typeof run & {low_balance?:unknown}).low_balance;
  const firstNotice=Boolean(balanceNotice&&!task.low_balance_notified);
  if(firstNotice)new HubTaskStore().update(task.request_id,{low_balance_notified:true});
  writeCommandEnvelope({status:run.execution_state==="succeeded"?"succeeded":snapshot.terminal?"failed":"pending",
   result:{request_id:task.request_id,...(snapshot.previous_runs?{previous_runs:snapshot.previous_runs}:{}),run_id:run.run_id,execution_state:run.execution_state,
    settlement_state:run.settlement_state,delivery_state:run.delivery_state,captured_atoms:run.captured_atoms??null,
    held_atoms:run.held_atoms??null,...(firstNotice?{low_balance:balanceNotice}:{}),result:run.result??null,result_expires_at:run.result_expires_at??null,error:run.error??null,first_error:run.first_error??null},
   instruction:firstNotice?(await currentAccountLabel(snapshot.account_hint))+"\n"+TOPUP_INSTRUCTION:run.execution_state==="failed"&&zero?"本次未扣 credit。":snapshot.terminal?"按原结果与 credit 费用回执回答。captured_atoms/held_atoms 保留原字段，按 scale=6 读取为 credit；未知数值不可当零。":"结果待核对，继续读取原请求。",
   next:snapshot.terminal?null:statusAction(task.request_id,json),recovery:[]},{jsonOutput:json});
  return;
 }
 const reason=snapshot.intent?.blocking_reason??(readyToContinue(snapshot)?"pending":"unknown");
 const deviceConsent=deviceConsentPending(snapshot);
 const uncharged=Boolean(snapshot.credential_recovery?.zero_effect_verified)||["insufficient_balance","authorization_denied","authorization_revoked","budget_exceeded"].includes(reason);
 const stopped=snapshot.terminal&&snapshot.intent?.status==="cancelled"&&reason!=="publication_changed";
 const target=snapshot.required_action?.web_action?.target??snapshot.required_action?.target;
 const changed=snapshot.terminal && reason==="publication_changed";
 const price=safePriceChange(snapshot.price_change);
 const zero=changed && price?.captured_atoms==="0" && price.held_atoms==="0";
 const label=price?.current_price?priceLabel({mode:"per_call",amount_atoms:price.current_price.amount_atoms}):"暂不可读取";
 writeCommandEnvelope({status:stopped?"stopped":changed?"price_changed":reason,
  result:{request_id:task.request_id,...(snapshot.previous_runs?{previous_runs:snapshot.previous_runs}:{}),intent_id:task.intent_id,account:snapshot.account_hint,captured_atoms:zero||uncharged?"0":null,held_atoms:zero||uncharged?"0":null,...(price?{price_change:price}:{}),...(price?.current_price?{current_price:price.current_price}:{})},
  ...(target&&!changed&&!deviceConsent?{handoff:{type:"open_url",url:target,label:"打开官方页面"}}:{}),
  instruction:stopped?(uncharged?"已停止这次请求，未扣 credit。":"已停止这次请求，费用以原回执为准。"):changed?`当前价格 ${label}。${zero?"原请求已结束，扣费0 credit、冻结0 credit，本次未扣 credit。先 show 核对当前商品，说明新价并取得明确同意后再用新 call。":"原请求费用仍须核对。先 status 原请求，未确认零扣费和零冻结前不要新 call。"}`:
   readyToContinue(snapshot)?"原请求已可接续，按返回操作继续；尚未执行。":deviceConsent?"请在原安装为同一请求确认消费额度；保留原账号、输入与价格，不只修改钱包或网页预算。":reason==="insufficient_balance"?(await currentAccountLabel(snapshot.account_hint))+"\n"+TOPUP_INSTRUCTION:reason==="credential_unavailable"?"请打开官方页面，选择改用 credit、更新 Key 或停止。保留原请求，等待原选择完成；不自动改用 credit。":"保留原请求，按官方操作完成授权或核对。",
  next:changed&&zero?{command:`itpay api show ${task.operation_id}${json?" --json":""}`,reason:"查看当前用途与价格"}:
   changed?statusAction(task.request_id,json):snapshot.terminal?null:deviceConsent?{command:`itpay api connect --request ${task.request_id}${json?" --json":""}`,reason:"为原请求确认设备消费额度"}:reason==="credential_unavailable"?{command:`itpay api status ${task.request_id} --wait 120${json?" --json":""}`,reason:"只读等待原 Key 选择"}:pendingAction(task.request_id,json),recovery:[]},{jsonOutput:json});
}
export async function shelfCategories(json:boolean):Promise<void>{
 const result=await client().shelfGet<{items:unknown[]}>("/v1/catalog/categories");
 writeCommandEnvelope({status:"listed",result,instruction:"选择真实分类后 list 查看商品。",next:null,recovery:[]},{jsonOutput:json});
}
export async function shelfList(options:{category?:string;query?:string;limit?:string;cursor?:string;json?:boolean}):Promise<void>{
 const q=new URLSearchParams();
 for(const key of ["category","query","limit","cursor"] as const)if(options[key]!==undefined)q.set(key,options[key]!);
 const data=await client().shelfGet<{items:Array<{operation_id:string;display_name:string;summary:string;unit_price?:{mode?:string;amount_atoms?:string;unit?:string}|null}>;next_cursor?:string}>("/v1/catalog/operations?"+q);
 writeCommandEnvelope({status:"listed",result:{items:data.items.map(item=>({id:item.operation_id,name:item.display_name,
  purpose:item.summary,price:priceLabel({mode:item.unit_price?.mode??(item.unit_price?"per_call":"free"),amount_atoms:item.unit_price?.amount_atoms??"0",unit:item.unit_price?.unit??"call"})})),
  page:{next_cursor:data.next_cursor||null}},instruction:"选定商品后 show 查看用途、价格、示例和保留时间。",next:null,recovery:[]},{jsonOutput:Boolean(options.json)});
}
export async function shelfShow(id:string,json:boolean):Promise<void>{
 const d=await client().shelfGet<ShelfDescriptor>("/v1/catalog/operations/"+encodeURIComponent(id));
 if(d.operation_id!==id || !d.example_input || !d.current_publication_id)throw new Error("invalid_state: incomplete product descriptor");
 saveShown(d);
 writeCommandEnvelope({status:"shown",result:{id:d.operation_id,purpose:d.summary,price:priceLabel(d.price_card),
  ttl_days:d.result_retention_days,example_input:d.example_input},
  instruction:"先说明用途、credit 报价与结果保留时间，取得用户同意后 call。"+CREDIT_GUIDANCE+"UTC时间查询请按当前UTC替换示例起止时间。",
  next:null,recovery:[]},{jsonOutput:json});
}
// Waiting only reads the original request. Unknown outcomes stop polling and
// retain their original identity; neither status nor this loop submits work.
function readyToContinue(snapshot:Snapshot):boolean{
 return !snapshot.run && snapshot.intent?.status==="open" && !snapshot.intent.blocking_reason && !snapshot.required_action;
}
async function waitForRequest(api:HubClient,store:HubTaskStore,task:HubTask,snapshot:Snapshot,seconds:number):Promise<{task:HubTask;snapshot:Snapshot}>{
 const deadline=Date.now()+seconds*1000;
 while(!snapshot.terminal && !readyToContinue(snapshot) && snapshot.run?.execution_state!=="unknown" && snapshot.run?.settlement_state!=="reconciling" && Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,Math.min(2000,deadline-Date.now())));
  snapshot=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot;
  task=remember(store,task,snapshot);
 }
 return {task,snapshot};
}
export async function shelfStatus(id:string,json:boolean,wait=0):Promise<void>{
 if(!Number.isInteger(wait)||wait<0||wait>120)throw new Error("invalid_input: wait must be between 0 and 120 seconds");
 const store=new HubTaskStore();
 const task=store.get(id);
 if(!task)throw new Error("not_found: original request is not in this installation");
 try{
  const api=client();
  const first=await api.getRequest(store.idempotencyKey(id)) as Snapshot;
  const {task:updated,snapshot}=await waitForRequest(api,store,remember(store,task,first),first,wait);
  await render(updated,snapshot,json);
 }catch(error){
  if(absentDeviceConsent(error,task,store.idempotencyKey(id))){
   writeCommandEnvelope({status:"not_admitted",result:{request_id:id,captured_atoms:"0",held_atoms:"0"},instruction:"原连接的权威记录确认这笔请求尚未受理，且原设备额度小于冻结报价。按原保存请求准备同意，不换身份或参数。",next:pendingAction(id,json),recovery:[]},{jsonOutput:json});return;
  }
  if(error instanceof HttpError && error.status===404 && !task.intent_id && !task.run_id &&
    ["publication_changed","authorization_required"].includes(task.blocking_reason??"")){
   const changed=task.blocking_reason==="publication_changed";
   writeCommandEnvelope({status:changed?"price_changed":"not_admitted",result:{request_id:id,captured_atoms:changed?null:"0",held_atoms:changed?null:"0"},
    instruction:changed?"原提交已被拒；当前价格和费用回执暂不可读。先核对原请求，未核实前不要新 call。":"原请求尚未准入，按原保存输入继续。",
    next:changed?statusAction(id,json):pendingAction(id,json),recovery:[]},{jsonOutput:json});
   return;
  }
  throw new HubTaskRequestError(error,store.get(id)??task)
 }
}
export async function shelfCall(operation:string|undefined,options:{input?:string;pending?:string;credentialMode?:string;json?:boolean}):Promise<void>{
 if(options.credentialMode!==undefined&&options.credentialMode!=="platform")throw new Error("invalid_input: credential mode must be platform");
 const json=Boolean(options.json), store=new HubTaskStore(), api=client();
 let task:HubTask;
 if(options.pending){
  if(operation||options.input!==undefined||options.credentialMode!==undefined)throw new Error("invalid_input: --pending preserves the original input and operation");
  const original=store.get(options.pending);
  if(!original)throw new Error("not_found: original request is not in this installation");
  task=original;
 }else{
  if(!operation||options.input===undefined)throw new Error("invalid_input: call requires an operation and --input");
  const shown=loadShown(operation);
  const input=await readRunInput(options.input);
  task=store.getOrCreate({operation_id:operation,publication_id:shown.current_publication_id,input,
   max_charge_atoms:shown.price_card.amount_atoms,...(options.credentialMode==="platform"?{credential_mode:"platform" as const}:{}),...(shown.shown_event_id?{shown_event_id:shown.shown_event_id}:{})}).task;
 }
 try{attachAgentRequest(selectedHubInstallationPath(),task.request_id)}catch(error){
  if(!(error instanceof AgentTaskConflict))throw error;
  const original=store.get(error.requestID);if(!original)throw error;
  try{remember(store,original,await api.getRequest(store.idempotencyKey(original.request_id)) as Snapshot)}catch(readError){throw new HubTaskRequestError(readError,original)}
  // Network I/O is outside the file lock; both release and this final attach
  // compare the current pointer, so another process cannot be overwritten.
  attachAgentRequest(selectedHubInstallationPath(),task.request_id);
 }
 try{
  if(!options.pending){
   const admission=await api.run(task.operation_id,{expected_publication_id:task.publication_id,
    input:task.input as Record<string,unknown>,...(task.shown_event_id?{shown_event_id:task.shown_event_id}:{}),...(task.credential_mode?{credential_mode:task.credential_mode}:{}),...(task.credential_id?{credential_id:task.credential_id}:{}),...(task.source_credentials?{source_credentials:task.source_credentials}:{}),max_charge:{currency:"CNY",scale:6,amount_atoms:task.max_charge_atoms!}},store.idempotencyKey(task.request_id));
   if("run_id" in admission)store.update(task.request_id,{run_id:admission.run_id,status:"dispatched"});
   else if("intent_id" in admission && "blocking_reason" in admission)store.update(task.request_id,{intent_id:admission.intent_id,status:"blocked",blocking_reason:admission.blocking_reason});
  }
  let snapshot:Snapshot;
  try { snapshot=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot; }
  catch(error) {
   if(!(options.pending && (absentDeviceConsent(error,task,store.idempotencyKey(task.request_id)) || error instanceof HttpError && error.status===404 && !task.run_id && !task.intent_id && task.blocking_reason==="authorization_required")))throw error;
   await api.run(task.operation_id,{expected_publication_id:task.publication_id,input:task.input as Record<string,unknown>,...(task.shown_event_id?{shown_event_id:task.shown_event_id}:{}),...(task.credential_mode?{credential_mode:task.credential_mode}:{}),...(task.credential_id?{credential_id:task.credential_id}:{}),...(task.source_credentials?{source_credentials:task.source_credentials}:{}),
    max_charge:{currency:"CNY",scale:6,amount_atoms:task.max_charge_atoms!}},store.idempotencyKey(task.request_id));
   snapshot=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot;
  }
  task=remember(store,store.get(task.request_id)!,snapshot);
  if(options.pending && !snapshot.run && snapshot.intent?.status==="open" && !snapshot.terminal && !deviceConsentPending(snapshot)){
   await api.continueIntent(snapshot.intent.intent_id,"cli-continue-"+task.request_id);
   snapshot=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot;
   task=remember(store,task,snapshot);
  }
  if((snapshot.run || options.pending) && !deviceConsentPending(snapshot))({task,snapshot}=await waitForRequest(api,store,task,snapshot,120));
  await render(task,snapshot,json);
 }catch(error){
  if(error instanceof HttpError&&error.code==="continuation_in_progress"){
   try{const first=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot;
    const {task:updated,snapshot}=await waitForRequest(api,store,remember(store,store.get(task.request_id)!,first),first,120);
    await render(updated,snapshot,json);return;
   }catch(readError){throw new HubTaskRequestError(readError,store.get(task.request_id)??task)}
  }
  if(error instanceof HttpError && error.code==="publication_changed"){
   // Server admission rejected before any run, or it closed the unexecuted
   // original intent under its lock. Read that original evidence next.
   store.update(task.request_id,{status:"failed",blocking_reason:"publication_changed"});
   try {
    const original=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot;
    await render(remember(store,store.get(task.request_id)!,original),original,json);
   }catch(readError){
    const price=hubErrorDetails(error)?.price_change;
    if(readError instanceof HttpError && readError.status===404 && price){
     await render(task,{request_id:store.idempotencyKey(task.request_id),terminal:true,pending_stage:null,next:null,intent:{intent_id:task.intent_id??"",kind:"api_run",status:"cancelled",blocking_reason:"publication_changed"},price_change:price} as Snapshot,json);
    }else throw new HubTaskRequestError(readError,store.get(task.request_id)??task);
   }
   return;
  }
  const code=error instanceof HttpError?error.code:error instanceof Error&&error.message.startsWith("authorization_required:")?"authorization_required":undefined;
  if(code==="authorization_required"||code==="unauthenticated")store.update(task.request_id,{blocking_reason:"authorization_required",status:"blocked"});
  else store.update(task.request_id,{status:"unknown"});
  throw new HubTaskRequestError(error,store.get(task.request_id)??task);
 }
}
