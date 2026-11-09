import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {HubClient,loadHubConfig} from '../client/hub.js';
import {HubTaskStore,hubTasksDir} from '../state/hub_tasks.js';
import {withAsyncFileLock} from '../state/file_lock.js';
import {openInSystemBrowser} from '../render/browser.js';
import {describeAccount} from './hub.js';
import {writeCommandEnvelope} from './hub_guidance.js';

type FundingTask={key:string;amount:string;buyer_id:string;topup_id?:string;status?:string;request_id?:string};
type FundingView={topup_id:string;status:string;amount?:string;account_hint?:string;page_url?:string;checkout_url?:string;image?:string;notice?:string;expires_at?:string;minimum_applied?:boolean};
export async function walletTopup(options:{topup?:string;topupStatus?:string;request?:string;noOpen?:boolean;jsonOutput:boolean}){
 const cfg=loadHubConfig(),api=new HubClient(cfg),me=await api.me();
 const root=join(hubTasksDir(),'.funding');mkdirSync(root,{recursive:true,mode:0o700});
 let path:string;
 if(options.topupStatus){const name=readdirSync(root).find(name=>{try{return (JSON.parse(readFileSync(join(root,name),'utf8')) as FundingTask).topup_id===options.topupStatus}catch{return false}});if(!name)throw Error('not_found: original top-up is not in this installation');path=join(root,name)}
 else {if(!options.topup||!/^\d+(?:\.\d{1,2})?$/.test(options.topup))throw Error('invalid_input: enter a positive CNY amount with at most two decimal places');path=join(root,encodeURIComponent(options.topup)+'.json')}
 await withAsyncFileLock(path+'.lock',async()=>{
  let saved:FundingTask|undefined=existsSync(path)?JSON.parse(readFileSync(path,'utf8')) as FundingTask:undefined;
  if(saved&&saved.buyer_id!==me.buyer_id)throw Error('authorization_required: original top-up account changed');
  if(!options.topupStatus&&saved?.topup_id&&['credited','failed','closed_unpaid'].includes(saved.status??'')){writeFileSync(join(root,'receipt-'+encodeURIComponent(saved.topup_id)+'.json'),JSON.stringify(saved),{mode:0o600})}
  if(!options.topupStatus&&(!saved||saved.status==='credited'||saved.status==='failed'||saved.status==='closed_unpaid'))saved={key:'cli-wallet-'+randomUUID(),amount:options.topup!,buyer_id:me.buyer_id,...options.request?{request_id:options.request}:{}};
  if(!saved)throw Error('not_found: original top-up is unavailable');
  if(options.request)saved.request_id=options.request;
  const task=saved.request_id?new HubTaskStore().get(saved.request_id):undefined;
  if(saved.request_id&&!task?.intent_id)throw Error('invalid_state: keep the original request; no funding intent is available');
  const save=()=>{const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify(saved),{mode:0o600});renameSync(tmp,path)};
  save(); // The original funding identity exists before any POST.
  const data=(options.topupStatus?await api.topupStatus(options.topupStatus):await api.createTopup({amount_cny:saved.amount,payer_currency:'CNY',...(task?.intent_id?{continuation_id:task.intent_id}:{})},saved.key)) as unknown as FundingView;
  data.account_hint="…"+me.buyer_id.split("|").pop()!.slice(-6);
  saved.topup_id=data.topup_id;saved.status=data.status;save();
  const browser=data.page_url&&!options.topupStatus&&!options.noOpen?await openInSystemBrowser(data.page_url,cfg.baseURL):{status:'unavailable',reason:'host link presentation'};
  const next=data.status==='credited'?saved.request_id?{command:`itpay api call --pending ${saved.request_id}${options.jsonOutput?' --json':''}`,reason:'到账后继续自己的原请求'}:null:{command:`itpay api wallet --topup-status ${data.topup_id}${options.jsonOutput?' --json':''}`,reason:'只读核对原充值；本人付款后继续'};
  writeCommandEnvelope({status:data.status,result:{...data,browser,...saved.request_id?{request_id:saved.request_id}:{}},instruction:describeAccount(me)+"\n"+(data.status==='credited'?`账号 ${data.account_hint??''} 已到账 ¥${data.amount??saved.amount}。不要重复付款；如有原请求，继续返回的原 call --pending。充值不增加消费授权。`:`${data.notice?data.notice+'。':''}为账号 ${data.account_hint??''} 充值 ¥${data.amount??saved.amount}。可扫码或打开同单收银台；按宿主能力展示官方图片。${data.expires_at?'有效至 '+data.expires_at+'。':''}展示能力不足时照常使用同单链接办理。充值不增加消费授权。`),next,recovery:[]},{jsonOutput:options.jsonOutput});
 });
}
