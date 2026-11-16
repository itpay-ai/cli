import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {HubClient,loadHubConfig} from '../client/hub.js';
import {HubTaskStore,hubTasksDir} from '../state/hub_tasks.js';
import {withAsyncFileLock} from '../state/file_lock.js';
import {openInSystemBrowser} from '../render/browser.js';
import {describeAccount} from './hub.js';
import {writeCommandEnvelope} from './hub_guidance.js';

type FundingTask={key:string;amount:string;payer_currency?:"CNY"|"USD";buyer_id:string;topup_id?:string;status?:string;payment_status?:string;request_id?:string;renewal_of?:string};
type FundingView={topup_id:string;status:string;payment_status?:string;amount?:string;payer_currency?:string;payer_minor_amount?:string;environment?:string;account_hint?:string;page_url?:string;checkout_url?:string;image?:string;collection_action?:unknown;presentation_hint?:string;notice?:string;expires_at?:string;minimum_applied?:boolean};
const refundStates=new Set(['refunded','partially_refunded','refund_requested','refund_pending','refund_unknown','refund_failed','refund_rejected']);
const paymentStatus=(value:{status?:string;payment_status?:string})=>value.payment_status??(refundStates.has(value.status??'')?'credited':value.status??'');
const purchaseEnded=(value:FundingTask)=>['credited','closed_unpaid','refunded','partially_refunded'].includes(paymentStatus(value));
export async function walletTopup(options:{topup?:string;topupStatus?:string;request?:string;payerCurrency?:string;noOpen?:boolean;jsonOutput:boolean}){
 if(options.payerCurrency&&(!options.topup||options.topupStatus||!['CNY','USD'].includes(options.payerCurrency)))throw Error('invalid_input: --payer-currency CNY|USD requires --topup and cannot change an original status read');
 const currency=(options.payerCurrency??'CNY') as 'CNY'|'USD';
 const cfg=loadHubConfig(),api=new HubClient(cfg),me=await api.me();
 const root=join(hubTasksDir(),'.funding');mkdirSync(root,{recursive:true,mode:0o700});
 let path:string;
 if(options.topupStatus){const name=readdirSync(root).find(name=>{try{return (JSON.parse(readFileSync(join(root,name),'utf8')) as FundingTask).topup_id===options.topupStatus}catch{return false}});if(!name)throw Error('not_found: original credit purchase is not in this installation');path=join(root,name)}
 else {if(!options.topup||!/^\d+(?:\.\d{1,2})?$/.test(options.topup))throw Error('invalid_input: enter a positive credit quantity with at most two decimal places');path=join(root,encodeURIComponent(options.topup)+(currency==='USD'?'-USD':'')+'.json')}
 await withAsyncFileLock(path+'.lock',async()=>{
  let saved:FundingTask|undefined=existsSync(path)?JSON.parse(readFileSync(path,'utf8')) as FundingTask:undefined;
  if(saved&&saved.buyer_id!==me.buyer_id)throw Error('authorization_required: original credit purchase account changed');
  // A new explicit purchase first observes its known original. Refund progress
  // is a public projection, not a return to an unpaid purchase. If this read is
  // uncertain, keep the original task/key; do not replace it with a new POST.
  if(!options.topupStatus&&saved?.topup_id){
   const original=await api.topupStatus(saved.topup_id) as unknown as FundingView;
   if(original.topup_id!==saved.topup_id)throw Error('original_topup_mismatch: preserve the original purchase and query it again');
   saved.status=original.status;saved.payment_status=paymentStatus(original);
  }
  // A fresh explicit purchase may ask the server to reconcile/fence an
  // expired original. Persist its new key once, retaining the original ID for
  // reads until the POST is confirmed. Unknown/restart must reuse this key.
  if(!options.topupStatus&&saved?.topup_id&&paymentStatus(saved)==='expired'&&!saved.renewal_of){
   writeFileSync(join(root,'receipt-'+encodeURIComponent(saved.topup_id)+'.json'),JSON.stringify(saved),{mode:0o600});
   saved={...saved,key:'cli-wallet-'+randomUUID(),renewal_of:saved.topup_id};
  }
  if(!options.topupStatus&&saved?.topup_id&&purchaseEnded(saved)&&!saved.renewal_of){writeFileSync(join(root,'receipt-'+encodeURIComponent(saved.topup_id)+'.json'),JSON.stringify(saved),{mode:0o600})}
  if(!options.topupStatus&&(!saved||purchaseEnded(saved)&&!saved.renewal_of))saved={key:'cli-wallet-'+randomUUID(),amount:options.topup!,payer_currency:currency,buyer_id:me.buyer_id,...options.request?{request_id:options.request}:{}};
  if(!saved)throw Error('not_found: original credit purchase is unavailable');
  if(options.request)saved.request_id=options.request;
  const task=saved.request_id?new HubTaskStore().get(saved.request_id):undefined;
  if(saved.request_id&&!task?.intent_id)throw Error('invalid_state: keep the original request; no funding intent is available');
  const save=()=>{const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify(saved),{mode:0o600});renameSync(tmp,path)};
  save(); // The original funding identity exists before any POST.
  const data=(options.topupStatus?await api.topupStatus(options.topupStatus):await api.createTopup({amount_cny:saved.amount,payer_currency:saved.payer_currency??'CNY',...(task?.intent_id?{continuation_id:task.intent_id}:{})},saved.key)) as unknown as FundingView;
  data.account_hint="…"+me.buyer_id.split("|").pop()!.slice(-6);
  if(!options.topupStatus)delete saved.renewal_of;
  saved.topup_id=data.topup_id;saved.status=data.status;saved.payment_status=paymentStatus(data);save();
  const refund=refundStates.has(data.status),credited=data.status==='credited'&&paymentStatus(data)==='credited';
  const payable=['created','payment_pending'].includes(data.status)&&['created','payment_pending'].includes(paymentStatus(data))&&(!data.expires_at||Date.parse(data.expires_at)>Date.now());
  if(!payable){delete data.page_url;delete data.checkout_url;delete data.image;delete data.collection_action;delete data.presentation_hint;}
  const browser=payable&&data.page_url&&!options.topupStatus&&!options.noOpen?await openInSystemBrowser(data.page_url,cfg.baseURL):{status:'unavailable',reason:payable?'host link presentation':'original purchase is not payable'};
  const refundPending=['refund_requested','refund_pending','refund_unknown'].includes(data.status);
  const readNext={command:`itpay api wallet --topup-status ${data.topup_id}${options.jsonOutput?' --json':''}`,reason:refund?'只读核对原退款，不再付款':payable?'只读核对原购买 credit；本人付款后继续':'只读核对原购买结果，不要再次付款'};
  const next=refund?(refundPending?readNext:null):credited?(saved.request_id?{command:`itpay api call --pending ${saved.request_id}${options.jsonOutput?' --json':''}`,reason:'到账后继续自己的原请求'}:null):purchaseEnded(saved)?null:readNext;
  const label=({refunded:'已原路退款',partially_refunded:'已部分退款',refund_requested:'等待人工复核',refund_pending:'退款处理中',refund_unknown:'正在核对原退款',refund_failed:'退款未完成',refund_rejected:'退款申请未获通过'} as Record<string,string>)[data.status];
  // Actual cash comes exclusively from the frozen server quote. Never convert
  // credit quantity locally or assume the requested currency was charged.
  const minor=data.payer_minor_amount;
  const cash=(data.payer_currency==='CNY'||data.payer_currency==='USD')&&minor&&/^\d+$/.test(minor)?`${data.payer_currency} ${BigInt(minor)/100n}.${(BigInt(minor)%100n).toString().padStart(2,'0')}`:'待原单确认';
  const instruction=refund?`原购买 ${data.topup_id}：${label}。不要再次付款；退款进度沿原单只读核对，不替换或重发原退款。`:
   credited?`账号 ${data.account_hint??''} 已到账 ${data.amount??saved.amount} credit。不要重复付款；如有原请求，继续返回的原 call --pending。购买 credit 不增加消费授权。`:
   payable?`${data.notice?data.notice+'。':''}为账号 ${data.account_hint??''} 购买 ${data.amount??saved.amount} credit（实际支付 ${cash}${data.environment==='test' ? '；测试模式' : ''}）。可扫码或打开同单收银台；按宿主能力展示官方图片。${data.expires_at?'有效至 '+data.expires_at+'。':''}展示能力不足时照常使用同单链接办理。购买 credit 不增加消费授权。`:
   `原购买 ${data.topup_id} 状态：${data.status}。当前没有可付款动作；仅查询原购买结果，不要再次付款。`;
  writeCommandEnvelope({status:data.status,result:{...data,browser,...saved.request_id?{request_id:saved.request_id}:{}},instruction:describeAccount(me)+"\n"+instruction,next,recovery:[]},{jsonOutput:options.jsonOutput});
 });
}
