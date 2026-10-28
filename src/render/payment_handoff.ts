// Thin Payment/Hub binding to V3 presentation. Payment identity and amount stay server-owned.
import {dispatchRender} from './index.js';
import {buildCheckoutQRPlan} from './checkout_plan.js';
import {buildCheckoutHandoff} from './checkout_handoff.js';
import {buildAgentChatHandoff} from './markdown.js';
import {ensureIdeImageAttach} from './ide.js';
import {normalizeHost,defaultHostForAgentType,validateContext} from '../state/client_context.js';
import {declaredAgentType,qualifyItPayCommand} from '../state/agent_type.js';
import {platformKeyForHost} from './plan.js';
export interface PaymentHandoffInput {action:{kind?:string;target?:string;card_url?:string;card_png_url?:string;branded?:boolean};requestID:string;amountMinor:number;currency:string;agentType?:string;host?:string;target?:string;jsonOutput?:boolean;prepareImage?:boolean;resumeCommand?:string}
function flag(name:string){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;}
function officialLink(value:string|undefined){if(!value)return undefined;try{const u=new URL(value);if(u.username||u.password)return undefined;if(u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))return value;}catch{}return undefined;}
export async function renderPaymentHandoff(input:PaymentHandoffInput){
 const url=officialLink(input.action.target);if(!url)return null;
 const agentType=input.agentType??declaredAgentType();
 const rawHost=input.host??flag('--host')??process.env.ITPAY_HOST;
 const host=rawHost?normalizeHost(rawHost):defaultHostForAgentType(agentType);
 const target=input.target??flag('--target')??process.env.ITPAY_TARGET;
 const invalid=validateContext(host,target);if(invalid||!host)throw new Error(invalid?.message??'invalid host');
 const candidatePNG=input.action.branded===true?officialLink(input.action.card_png_url):undefined;
 const png=candidatePNG&&new URL(candidatePNG).origin===new URL(url).origin?candidatePNG:undefined;
 const card=input.action.branded===true?officialLink(input.action.card_url):undefined;
 const plan=buildCheckoutQRPlan({host,checkoutID:input.requestID,checkoutURL:url,displayToken:'',qrPayload:url,...(png?{qrPNGURL:png}:{}),...(card?{cardURL:card}:{}),nextAction:'payment_required',orderItems:[{title:'服务付款',quantity:1,amountMinor:input.amountMinor,currency:input.currency}],orderCurrency:input.currency,...(agentType?{agentType}:{})});
 // V3 default QR fallback is deliberately suppressed when no branded source was returned.
 plan.preferredQRSources=png?[png]:[];
 plan.paymentOnly=true;
 const nextCommand=qualifyItPayCommand((input.resumeCommand??`itpay api resume ${input.requestID}`)+`${input.jsonOutput?' --json':''}`,agentType);
 plan.afterActionCommand=nextCommand;
 if(png&&input.prepareImage!==false&&['markdown','terminal'].includes(platformKeyForHost(host)))await ensureIdeImageAttach(plan,{});
 const platform=platformKeyForHost(host);
 const rendered=buildCheckoutHandoff({platform,url:plan.linkOnlyURL??url,amount:`${input.currency} ${(input.amountMinor/100).toFixed(2)}`,plan,...(agentType?{agentType}:{}),...(target?{target}:{}),...(png?{qrImageURL:png}:{}),...(plan.ideImageAttach?.status==='downloaded'?{localPath:plan.ideImageAttach.localPath}:{}),...(platform==='markdown'?{markdown:buildAgentChatHandoff(plan).markdown}:{})});
 if(['telegram','feishu','lark'].includes(platform)){const chunks:string[]=[];await dispatchRender(plan,{...(target?{target}:{}),output:line=>chunks.push(line)});rendered.handoff.presentation=JSON.parse(chunks.join(''));}
 if(!input.jsonOutput)await dispatchRender(plan,{...(target?{target}:{}),baseURL:new URL(url).origin});
 return {...rendered,next:{command:nextCommand,reason:'用户完成付款或要求查询时恢复同一原请求'}};
}
