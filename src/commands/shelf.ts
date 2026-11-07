import {HubClient,loadHubConfig,hubErrorDetails,safePriceChange,type PublicPriceChange,type RunReceipt,type RequestStatus} from "../client/hub.js";
import {HttpError} from "../client/http.js";
import {HubTaskStore,type HubTask} from "../state/hub_tasks.js";
import {loadShown,saveShown,type ShelfDescriptor} from "../state/hub_show_cache.js";
import {HubTaskRequestError,readRunInput} from "./hub.js";
import {writeCommandEnvelope,type CommandAction} from "./hub_guidance.js";

type Facts=RunReceipt&{held_atoms?:string;captured_atoms?:string;result_expires_at?:string};
type Snapshot=RequestStatus&{price_change?:PublicPriceChange;required_action?:{web_action?:{target?:string};target?:string}};
const client=()=>new HubClient(loadHubConfig());
export function priceLabel(price:{mode:string;amount_atoms?:string}):string{
 if(price.mode==="free")return "免费";
 const atoms=BigInt(price.amount_atoms??"0");
 const fraction=(atoms%1000000n).toString().padStart(6,"0").replace(/0+$/,"");
 return "¥"+atoms/1000000n+(fraction?"."+fraction:"")+"/次";
}
function statusAction(id:string,json:boolean):CommandAction{
 return {command:`itpay api status ${id}${json?" --json":""}`,reason:"只读核对原请求"};
}
function pendingAction(id:string,json:boolean):CommandAction{
 return {command:`itpay api call --pending ${id}${json?" --json":""}`,reason:"等待并接续同一原请求"};
}
function remember(store:HubTaskStore,task:HubTask,snapshot:Snapshot):HubTask{
 if(snapshot.request_id!==store.idempotencyKey(task.request_id))throw new Error("invalid_state: original request binding changed");
 if(snapshot.run){
  if(snapshot.run.operation_id!==task.operation_id || snapshot.run.publication_id!==task.publication_id ||
     task.run_id && task.run_id!==snapshot.run.run_id)throw new Error("invalid_state: original execution binding changed");
  return store.update(task.request_id,{run_id:snapshot.run.run_id,
   status:snapshot.run.execution_state==="succeeded"?"succeeded":snapshot.run.execution_state==="failed"?"failed":"dispatched",
   terminal:snapshot.terminal,state_source:"hub",state_stale:false})!;
 }
 if(snapshot.intent){
  if(task.intent_id && task.intent_id!==snapshot.intent.intent_id)throw new Error("invalid_state: original intent binding changed");
  return store.update(task.request_id,{intent_id:snapshot.intent.intent_id,status:snapshot.terminal?"failed":"blocked",
   blocking_reason:snapshot.intent.blocking_reason,terminal:snapshot.terminal,state_source:"hub",state_stale:false})!;
 }
 throw new Error("invalid_state: original request has no receipt");
}
function render(task:HubTask,snapshot:Snapshot,json:boolean):void{
 const run=snapshot.run as Facts|undefined;
 if(run){
  const zero=run.captured_atoms==="0" && run.held_atoms==="0";
  writeCommandEnvelope({status:run.execution_state==="succeeded"?"succeeded":snapshot.terminal?"failed":"pending",
   result:{request_id:task.request_id,run_id:run.run_id,execution_state:run.execution_state,
    settlement_state:run.settlement_state,delivery_state:run.delivery_state,captured_atoms:run.captured_atoms??null,
    held_atoms:run.held_atoms??null,result:run.result??null,result_expires_at:run.result_expires_at??null,error:run.error??null,first_error:run.first_error??null},
   instruction:run.execution_state==="failed"&&zero?"本次没扣钱。":snapshot.terminal?"按原结果与费用回执回答。":"结果待核对，继续读取原请求。",
   next:statusAction(task.request_id,json),recovery:[]},{jsonOutput:json});
  return;
 }
 const reason=snapshot.intent?.blocking_reason??"unknown";
 const target=snapshot.required_action?.web_action?.target??snapshot.required_action?.target;
 const changed=snapshot.terminal && reason==="publication_changed";
 const price=safePriceChange(snapshot.price_change);
 const zero=changed && price?.captured_atoms==="0" && price.held_atoms==="0";
 const label=price?.current_price?"CNY "+priceLabel({mode:"per_call",amount_atoms:price.current_price.amount_atoms}):"暂不可读取";
 writeCommandEnvelope({status:changed?"price_changed":reason,
  result:{request_id:task.request_id,intent_id:task.intent_id,captured_atoms:zero?"0":null,held_atoms:zero?"0":null,...(price?{price_change:price}:{}),...(price?.current_price?{current_price:price.current_price}:{})},
  ...(target&&!changed?{handoff:{type:"open_url",url:target,label:"打开官方页面"}}:{}),
  instruction:changed?`当前价格 ${label}。${zero?"原请求已结束，扣费0、冻结0，本次没扣钱。先 show 核对当前商品，说明新价并取得明确同意后再用新 call。":"原请求费用仍须核对。先 status 原请求，未确认零扣费和零冻结前不要新 call。"}`:
   reason==="insufficient_balance"?"请在原单官方页面充值，到账后继续原请求。":"保留原请求，按官方操作完成授权或核对。",
  next:changed&&zero?{command:`itpay api show ${task.operation_id}${json?" --json":""}`,reason:"查看当前用途与价格"}:
   changed?statusAction(task.request_id,json):snapshot.terminal?null:pendingAction(task.request_id,json),recovery:[]},{jsonOutput:json});
}
export async function shelfCategories(json:boolean):Promise<void>{
 const result=await client().shelfGet<{items:unknown[]}>("/v1/catalog/categories");
 writeCommandEnvelope({status:"listed",result,instruction:"选择真实分类后 list 查看商品。",next:null,recovery:[]},{jsonOutput:json});
}
export async function shelfList(options:{category?:string;query?:string;limit?:string;cursor?:string;json?:boolean}):Promise<void>{
 const q=new URLSearchParams();
 for(const key of ["category","query","limit","cursor"] as const)if(options[key]!==undefined)q.set(key,options[key]!);
 const data=await client().shelfGet<{items:Array<{operation_id:string;display_name:string;summary:string;unit_price?:{mode?:string;amount_atoms?:string}|null}>;next_cursor?:string}>("/v1/catalog/operations?"+q);
 writeCommandEnvelope({status:"listed",result:{items:data.items.map(item=>({id:item.operation_id,name:item.display_name,
  purpose:item.summary,price:priceLabel({mode:item.unit_price?.mode??(item.unit_price?"per_call":"free"),amount_atoms:item.unit_price?.amount_atoms??"0"})})),
  page:{next_cursor:data.next_cursor||null}},instruction:"选定商品后 show 查看用途、价格、示例和保留时间。",next:null,recovery:[]},{jsonOutput:Boolean(options.json)});
}
export async function shelfShow(id:string,json:boolean):Promise<void>{
 const d=await client().shelfGet<ShelfDescriptor>("/v1/catalog/operations/"+encodeURIComponent(id));
 if(d.operation_id!==id || !d.example_input || !d.current_publication_id)throw new Error("invalid_state: incomplete product descriptor");
 saveShown(d);
 writeCommandEnvelope({status:"shown",result:{id:d.operation_id,purpose:d.summary,price:priceLabel(d.price_card),
  ttl_days:d.result_retention_days,example_input:d.example_input},
  instruction:"先说明用途、价格与结果保留时间，取得用户同意后 call。UTC时间查询请按当前UTC替换示例起止时间。",
  next:null,recovery:[]},{jsonOutput:json});
}
export async function shelfStatus(id:string,json:boolean):Promise<void>{
 const store=new HubTaskStore();
 const task=store.get(id);
 if(!task)throw new Error("not_found: original request is not in this installation");
 try{
  const snapshot=await client().getRequest(store.idempotencyKey(id)) as Snapshot;
  render(remember(store,task,snapshot),snapshot,json);
 }catch(error){
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
export async function shelfCall(operation:string|undefined,options:{input?:string;pending?:string;json?:boolean}):Promise<void>{
 const json=Boolean(options.json), store=new HubTaskStore(), api=client();
 let task:HubTask;
 if(options.pending){
  if(operation||options.input!==undefined)throw new Error("invalid_input: --pending preserves the original input and operation");
  const original=store.get(options.pending);
  if(!original)throw new Error("not_found: original request is not in this installation");
  task=original;
 }else{
  if(!operation||options.input===undefined)throw new Error("invalid_input: call requires an operation and --input");
  const shown=loadShown(operation);
  const input=await readRunInput(options.input);
  task=store.getOrCreate({operation_id:operation,publication_id:shown.current_publication_id,input,
   max_charge_atoms:shown.price_card.amount_atoms,...(shown.shown_event_id?{shown_event_id:shown.shown_event_id}:{})}).task;
 }
 try{
  if(!options.pending){
   const admission=await api.run(task.operation_id,{expected_publication_id:task.publication_id,
    input:task.input as Record<string,unknown>,...(task.shown_event_id?{shown_event_id:task.shown_event_id}:{}),...(task.credential_id?{credential_id:task.credential_id}:{}),...(task.source_credentials?{source_credentials:task.source_credentials}:{}),max_charge:{currency:"CNY",scale:6,amount_atoms:task.max_charge_atoms!}},store.idempotencyKey(task.request_id));
   if("run_id" in admission)store.update(task.request_id,{run_id:admission.run_id,status:"dispatched"});
   else if("intent_id" in admission)store.update(task.request_id,{intent_id:admission.intent_id,status:"blocked",blocking_reason:admission.blocking_reason});
  }
  let snapshot:Snapshot;
  try { snapshot=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot; }
  catch(error) {
   if(!(options.pending && error instanceof HttpError && error.status===404 && !task.run_id && !task.intent_id && task.blocking_reason==="authorization_required"))throw error;
   await api.run(task.operation_id,{expected_publication_id:task.publication_id,input:task.input as Record<string,unknown>,...(task.shown_event_id?{shown_event_id:task.shown_event_id}:{}),...(task.credential_id?{credential_id:task.credential_id}:{}),...(task.source_credentials?{source_credentials:task.source_credentials}:{}),
    max_charge:{currency:"CNY",scale:6,amount_atoms:task.max_charge_atoms!}},store.idempotencyKey(task.request_id));
   snapshot=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot;
  }
  task=remember(store,store.get(task.request_id)!,snapshot);
  if(options.pending && !snapshot.run && snapshot.intent?.status==="open" && !snapshot.terminal){
   await api.continueIntent(snapshot.intent.intent_id,"cli-continue-"+task.request_id);
   snapshot=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot;
   task=remember(store,task,snapshot);
  }
  const deadline=Date.now()+120_000;
  while(!snapshot.terminal && snapshot.run?.execution_state!=="unknown" && snapshot.run?.settlement_state!=="reconciling" && (snapshot.run || options.pending) && Date.now()<deadline){
   await new Promise(resolve=>setTimeout(resolve,Math.min(2000,deadline-Date.now())));
   snapshot=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot;
   task=remember(store,task,snapshot);
  }
  render(task,snapshot,json);
 }catch(error){
  if(error instanceof HttpError && error.code==="publication_changed"){
   // Server admission rejected before any run, or it closed the unexecuted
   // original intent under its lock. Read that original evidence next.
   store.update(task.request_id,{status:"failed",blocking_reason:"publication_changed"});
   try {
    const original=await api.getRequest(store.idempotencyKey(task.request_id)) as Snapshot;
    render(remember(store,store.get(task.request_id)!,original),original,json);
   }catch(readError){
    const price=hubErrorDetails(error)?.price_change;
    if(readError instanceof HttpError && readError.status===404 && price){
     render(task,{request_id:store.idempotencyKey(task.request_id),terminal:true,pending_stage:null,next:null,intent:{intent_id:task.intent_id??"",kind:"api_run",status:"cancelled",blocking_reason:"publication_changed"},price_change:price} as Snapshot,json);
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
