import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {HttpError} from '../client/http.js';
import {HubClient,loadHubConfig,type WalletRefund} from '../client/hub.js';
import {hubTasksDir} from '../state/hub_tasks.js';
import {withAsyncFileLock} from '../state/file_lock.js';
import {writeCommandEnvelope} from './hub_guidance.js';

type RefundAttempt={request_id:string;buyer_id:string;sent:boolean;topup_id?:string;refund_id?:string;status?:string;rejection?:{status:number;code:string;message:string}};
const displayAtoms=(raw:string)=>{const n=BigInt(raw);return (n/1000000n).toString()+(n%1000000n?'.'+(n%1000000n).toString().padStart(6,'0').replace(/0+$/,''):'')+' credit'};
const refundReason=(reason:string|undefined)=>({original_credit_used:'原 credit 已消费，不能全额批准',original_credit_occupied:'原 credit 有占用，需核对原任务',outside_24_hours:'已超过自动退款时限，需人工复核',not_latest_credit:'非最近到账，需人工复核',automatic_disabled:'当前采用人工复核',original_payment_disputed:'原付款争议待核对',original_credit_incomplete:'原批次不完整，不能全额批准'} as Record<string,string>)[reason??''];
const validID=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

export async function walletRefund(options:{latest:boolean;request?:string;status?:string;confirm:boolean;jsonOutput:boolean}){
 if(options.status&&(options.latest||options.request||options.confirm)||!options.latest&&!options.status||options.confirm&&!options.request)throw Error('invalid_input: preview --refund-latest first; confirm with its --refund-request, or only read --refund-status');
 const cfg=loadHubConfig();
 if(cfg.apiKey||!cfg.sessionEnv)throw Error('authorization_required: original-wallet refunds require this installation normal OAuth connection; no credential fallback');
 const api=new HubClient(cfg),me=await api.me();
 const root=join(hubTasksDir(),'.refunds');mkdirSync(root,{recursive:true,mode:0o700});
 const id=options.status||options.request||'cli-refund-'+randomUUID();
 if(!validID(id))throw Error('invalid_input: refund request ID must be 1-128 letters, digits, dot, dash or underscore');
 const file=join(root,id+'.json');
 await withAsyncFileLock(file+'.lock',async()=>{
  let saved:RefundAttempt|undefined=existsSync(file)?JSON.parse(readFileSync(file,'utf8')) as RefundAttempt:undefined;
  if(saved&&(saved.request_id!==id||saved.buyer_id!==me.buyer_id))throw Error('authorization_required: original refund account changed');
  if((options.status||options.confirm)&&!saved)throw Error('not_found: preview/save this original refund request in this installation/profile before confirmation or recovery');
  const save=()=>{const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(saved),{mode:0o600});renameSync(tmp,file)};
  let result:WalletRefund;
  if(saved?.status==='submission_rejected'&&saved.rejection&&!options.status){
   throw new HttpError(saved.rejection.status,{code:saved.rejection.code,message:saved.rejection.message},'Original refund submission was rejected; keep its request key.');
  }else if(saved?.status==='preview_changed'){
   result={status:'preview_changed',request_key:id,reason:'original_changed',next_step:'review_latest_original',account_hint:'…'+me.buyer_id.split('|').pop()!.slice(-6),wallet_url:cfg.baseURL+'/me/usage'};
  }else if(saved?.sent||options.status){
   // Even a repeated confirmation after B arrives only reads A's saved key.
   result=await api.walletRefundStatus({request_key:id});
   if(saved?.rejection&&result.request_recorded===false)throw new HttpError(saved.rejection.status,{code:saved.rejection.code,message:saved.rejection.message},'Original refund submission was rejected; keep its request key.');
  }else if(options.confirm){
   const topupID=saved?.topup_id;if(!topupID)throw Error('refund_preview_required: obtain and save the original server preview before confirming');
   saved={request_id:id,buyer_id:me.buyer_id,topup_id:topupID,sent:true,status:'unconfirmed'};save();
   try{result=await api.walletRefundIntent(id,topupID)}catch(error){
    const changed=error instanceof HttpError&&error.status===409&&error.code==='refund_preview_changed';
    // SDK contract mismatch can be raised after a successful POST response.
    // That client-side409 is not proof of server rejection.
    if(error instanceof HttpError&&error.status>=400&&error.status<500&&![408,425].includes(error.status)&&error.code!=='contract_mismatch'&&!changed){
     saved.status='submission_rejected';saved.rejection={status:error.status,code:error.code,message:error.message};save();
     throw error;
    }
    // POST uncertainty is durable. Never automatically POST again, even if
    // readback is absent; the original worker/owner must reconcile it.
    result={status:changed?'preview_changed':'unconfirmed',request_key:id,...changed?{reason:'original_changed'}:{},next_step:changed?'review_latest_original':'read_original_request',account_hint:'…'+me.buyer_id.split('|').pop()!.slice(-6),wallet_url:cfg.baseURL+'/me/usage'};
   }
  }else{
   result=await api.walletRefundStatus({});
   saved={request_id:id,buyer_id:me.buyer_id,sent:false,...result.topup_id?{topup_id:result.topup_id}:{},status:result.status};save();
  }
  if(!saved)throw Error('invalid_state: original refund attempt missing');
  saved.status=result.status;if(result.topup_id)saved.topup_id=result.topup_id;if(result.refund_id)saved.refund_id=result.refund_id;save();
  writeWalletRefund(result,{id,preview:!saved.sent&&!options.status,jsonOutput:options.jsonOutput});
 });
}

export function writeWalletRefund(result:WalletRefund,{id,preview,jsonOutput,readTopup=false}:{id:string;preview:boolean;jsonOutput:boolean;readTopup?:boolean}){
  const status=result.status??'unconfirmed',terminal=['succeeded','failed','rejected','unavailable'].includes(status);
  const original=`itpay api wallet ${readTopup?'--topup-status':'--refund-status'} ${id}${jsonOutput?' --json':''}`;
  const confirm=`itpay api wallet --refund-latest --refund-request ${id} --confirm${jsonOutput?' --json':''}`;
  const next=status==='preview_changed'?{command:`itpay api wallet --refund-latest${jsonOutput?' --json':''}`,reason:'最新原款已变化；只读重新预览，必须取得新的明确同意'}:terminal?null:preview?{command:confirm,reason:'仅在用户明确同意退款后确认；服务端决定原额与原路去向'}:{command:original,reason:'只读核对原退款；unknown/超时不重新提交'};
  const amount=result.cny_equivalent?result.cny_equivalent.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''):undefined;
  const cashRaw=String(result.amount_minor_text??result.amount_minor??'');
  const cash=/^\d+$/.test(cashRaw)&&/^[A-Z]{3}$/.test(result.currency??'')?`${result.currency} ${BigInt(cashRaw)/100n}.${(BigInt(cashRaw)%100n).toString().padStart(2,'0')}`:undefined;
  const ownRefundHold=['pending','unknown'].includes(status)&&Boolean(result.refund_id)&&result.reason==='original_credit_occupied'&&result.used_atoms==='0'&&Boolean(result.credit_atoms)&&result.credit_atoms!=='0'&&result.occupied_atoms===result.credit_atoms;
  const condition=ownRefundHold?undefined:refundReason(result.reason);
  const instruction=(preview?'这是本人最近一笔原款的退款预览，尚未提交。':status==='preview_changed'?'预览后的最新原款已变化，本次未退款或冻结。重新预览并取得新的明确同意，不能自动确认另一笔。':status==='succeeded'?'渠道已确认原路退款，并扣回对应 credit。':status==='requested'?'原申请等待人工复核，申请未冻结资金。':status==='pending'?'原 credit 已冻结，等待原渠道确认退款。':status==='unconfirmed'||status==='unknown'?'原退款结果待确认。只查询原请求，不换号、不重发。':'读取原退款结果。')+(cash?` 原款 ${cash}，按原支付币种退回。`:'')+(amount?` 对应 ${amount} credit = CNY ${amount}；退款金额以原支付币种回执为准。`:'')+(condition?` 条件：${condition}。`:'')+(result.used_atoms!==undefined&&result.occupied_atoms!==undefined?` 原批已用 ${displayAtoms(result.used_atoms)}，${ownRefundHold?'退款冻结':'占用'} ${displayAtoms(result.occupied_atoms)}。`:'')+` 原渠道 ${result.payment_provider||'未记录'}；ItPay 账号 ${result.account_hint??'未记录'}；原付款账户 ${result.payment_account_hint||'尾号未记录'}，两者不可混用。`;
  writeCommandEnvelope({status,result:{...result,...readTopup?{}:{request_id:id}},instruction,next,recovery:[]},{jsonOutput:jsonOutput});
}
