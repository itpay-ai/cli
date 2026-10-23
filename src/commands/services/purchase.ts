import {purchaseContract} from "../../services/shared/purchase_contract.generated.js";
import {HttpError} from "../../client/http.js";
import {HttpTransportError} from "../../client/transport.js";
import {purchaseEnvelope} from "../../services/shared/purchase.js";
import {setTimeout as delay} from "node:timers/promises";
import type {BackendClient} from "../../client/backend.js";
import type {PurchaseConfirmation} from "../../client/types.js";
import type {CLIConfig} from "../../state/config.js";
import {validateContext} from "../../state/client_context.js";
import {hasSpecializedHTTPGuidance,CommandContractError,writeCommandEnvelope} from "../../services/shared/envelope.js";
import {presentServiceCheckout,runServicesCheckout} from "./commerce.js";

type Options=NonNullable<Parameters<typeof runServicesCheckout>[4]> & {timeoutSeconds?:number};

function invalid(path="input", allowed?: readonly string[]):never {
 throw new CommandContractError("purchase_input_invalid","purchase confirmation input is incomplete or invalid","本次未发送确认。按当前 confirmation_schema 和完整 file_content 修正技术字段；只有缺失的真实同意或价格决定才问用户。",[],undefined,{request_sent:false,field:path,...(allowed?{allowed_values:allowed}:{})});
}
export function parsePurchaseConfirmation(raw:Record<string,unknown>):PurchaseConfirmation {
 const keys:readonly string[]=purchaseContract.required;
 for(const key of Object.keys(raw)) if(!keys.includes(key)) invalid(key,keys);
 if(typeof raw.review_ref!=="string" || !raw.review_ref) invalid("review_ref");
 if(typeof raw.request_key!=="string" || !raw.request_key || raw.request_key.length>purchaseContract.request_key_max_utf16_units) invalid("request_key");
 if(raw.user_approved!==true) invalid("user_approved",["true"]);
 if(typeof raw.user_answer!=="string" || !raw.user_answer.trim()) invalid("user_answer");
 const p=raw.price_policy;
 if(!p || typeof p!=="object" || Array.isArray(p)) invalid("price_policy");
 if(!("mode" in p) || typeof p.mode!=="string" || !Object.hasOwn(purchaseContract.modes,p.mode)) invalid("price_policy.mode",Object.keys(purchaseContract.modes));
 if(!("currency" in p) || typeof p.currency!=="string" || !p.currency) invalid("price_policy.currency");
 const safeAmount=(n:unknown):n is number=>typeof n==="number" && Number.isSafeInteger(n) && n>=0 && n<=purchaseContract.amount_maximum;
 const amountField=p.mode==="exact" ? purchaseContract.modes.exact : p.mode==="capped" ? purchaseContract.modes.capped : null;
 const allowedFields=["mode","currency",...(amountField?[amountField]:[])];
 for(const key of Object.keys(p)) if(!allowedFields.includes(key)) invalid(`price_policy.${key}`,allowedFields);
 if(p.mode==="exact" && "amount_minor" in p && safeAmount(p.amount_minor)) return {review_ref:raw.review_ref,request_key:raw.request_key,user_approved:true,user_answer:raw.user_answer,price_policy:{mode:"exact",currency:p.currency,amount_minor:p.amount_minor}};
 if(p.mode==="capped" && "maximum_minor" in p && safeAmount(p.maximum_minor)) return {review_ref:raw.review_ref,request_key:raw.request_key,user_approved:true,user_answer:raw.user_answer,price_policy:{mode:"capped",currency:p.currency,maximum_minor:p.maximum_minor}};
 if(p.mode==="confirm_on_official_page")return {review_ref:raw.review_ref,request_key:raw.request_key,user_approved:true,user_answer:raw.user_answer,price_policy:{mode:"confirm_on_official_page",currency:p.currency}};
 return invalid(`price_policy.${amountField}`);
}

export async function runServicesPurchase(backend:BackendClient,config:CLIConfig,id:string,input:Record<string,unknown>|undefined,options:Options={}):Promise<void>{
 const confirm=input ? parsePurchaseConfirmation(input):undefined;
 if(confirm && options.resume)invalid();
 const contextError=validateContext(options.host ?? "terminal",options.target);
 if(contextError)throw new CommandContractError(contextError.code,contextError.message,"补齐当前可信 Host/target；本次未发送确认。",[],undefined,{request_sent:false});
 const seconds=options.timeoutSeconds ?? 60;
 if(!Number.isFinite(seconds) || seconds<=0 || seconds>120)invalid();
 let deadline=options.deadline ?? Date.now()+seconds*1000;
 let failureStage=confirm ? "confirm_purchase" : options.resume ? "resume_purchase" : "read_purchase_review";
 try {
 let state=confirm ? await backend.confirmServicePurchase(id,confirm,{deadline}) : options.resume ? await backend.resumeServicePurchase(id,{deadline}) : await backend.getServicePurchaseReview(id,{deadline});
 while(state.status==="running"){
  if(state.auto_wait_remaining_ms!==undefined){
   if(state.auto_wait_remaining_ms<=0)break;
   deadline=Math.min(deadline,Date.now()+state.auto_wait_remaining_ms);
  }
  const wait=Math.min(3000,Math.max(250,state.poll_after_ms ?? 750));
  if(Date.now()+wait+50>=deadline)break;
  await delay(wait);failureStage="resume_purchase";state=await backend.resumeServicePurchase(id,{deadline});
 }
 if(state.status==="checkout_ready"){
  if(!state.checkout || state.effects.payment_requested || state.effects.charged)throw new CommandContractError("purchase_response_invalid","official page facts are incomplete","保留原购买，读取原状态，不创建替代入口。",[{command:`itpay services purchase ${id} --resume --json`,reason:"恢复原购买"}]);
  failureStage="read_checkout_presentation";
  return await presentServiceCheckout(backend,config,id,state.checkout,{...options,deadline});
 }
 writeCommandEnvelope(purchaseEnvelope(state),{...(options.jsonOutput!==undefined ? {jsonOutput:options.jsonOutput}:{}),...(options.output ? {output:options.output}:{})});
 } catch(error) {
  if(error instanceof HttpError && hasSpecializedHTTPGuidance(error)){
   error.executionContext={...error.executionContext,service_execution_id:id,execution_created:true,failure_stage:failureStage};
   throw error;
  }
  if(error instanceof HttpError || error instanceof HttpTransportError){
   const recoverable=error instanceof HttpTransportError || error instanceof HttpError && (error.status>=500 || error.status===408 || error.status===429) && !["purchase_preparation_unsupported","purchase_review_unavailable","purchase_review_expired","purchase_request_conflict"].includes(error.code);
   const recoveryCommand=`itpay services purchase ${id}${failureStage==="read_purchase_review" ? "" : " --resume"} --json`;
   throw new CommandContractError(error.code,error.message,"原购买本次读取或操作未确认完成；保留已知执行和真实同意，按实际原因停止。技术读取故障不等于过期；不重放确认或创建替代购买。",recoverable?[{command:recoveryCommand,reason:"仅用户要求或平台读取恢复后恢复原购买，复用已保存的真实同意，不重放确认"}]:[],undefined,{service_execution_id:id,failure_stage:failureStage,...(error.diagnostics.length?{network_diagnostics:error.diagnostics}:{}),...(error instanceof HttpError && typeof error.payload?.provider_called==="boolean"?{provider_called:error.payload.provider_called}:{})});
  }
  throw error;
 }
}
