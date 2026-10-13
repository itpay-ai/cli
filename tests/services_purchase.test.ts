import assert from 'node:assert/strict';
import test from 'node:test';
import {BackendClient} from '../src/client/backend.js';
import {HttpClient} from '../src/client/http.js';
import {parsePurchaseConfirmation,runServicesPurchase} from '../src/commands/services/purchase.js';
import {CommandContractError} from '../src/services/shared/envelope.js';
import {purchaseEnvelope} from '../src/services/shared/purchase.js';
import type {ServicePurchaseState} from '../src/client/types.js';
import type {CLIConfig} from '../src/state/config.js';

const input={review_ref:'server_scope',request_key:'original_request',user_approved:true,user_answer:'用户已明确同意此对象和价格',price_policy:{mode:'exact',currency:'CNY',amount_minor:100}};
const config:CLIConfig={baseURL:'https://sandbox.itpay.ai',environment:'development',checkoutCurrency:'CNY',idempotencyKey:'fixture',ideImageAttach:false};
const effects={page_created:false,page_reused:false,payment_requested:false,charged:false,human_page_action_required:false} as const;
const running:ServicePurchaseState={status:'running',service_execution_id:'se_original',completed_stage:'quote_pending',poll_after_ms:250,auto_wait_remaining_ms:0,effects};

test('technical errors reject locally and unknown price cannot imply approval',async()=>{
 const backend=new BackendClient(new HttpClient({baseURL:config.baseURL}));
 let sent=0; backend.confirmServicePurchase=async()=>{sent++;return running;};
 for(const bad of [{...input,user_approved:false},{...input,user_answer:''},{input},{...input,price_policy:{mode:'',currency:'CNY'}},{...input,price_policy:{...input.price_policy,quote_id:'invented'}},{...input,price_policy:{...input.price_policy,amount_minor:NaN}}]){
  await assert.rejects(runServicesPurchase(backend,config,'se_original',bad,{jsonOutput:true}),e=>e instanceof CommandContractError && e.result?.request_sent===false);
 }
 assert.equal(sent,0);
 assert.deepEqual(parsePurchaseConfirmation(input),input);
 assert.equal(parsePurchaseConfirmation({...input,price_policy:{mode:'capped',currency:'CNY',maximum_minor:200}}).price_policy.maximum_minor,200);
 assert.equal(parsePurchaseConfirmation({...input,price_policy:{mode:'confirm_on_official_page',currency:'CNY'}}).price_policy.mode,'confirm_on_official_page');
});

test('persisted exhausted budget stops polling and preserves original recovery in text and JSON',async()=>{
 const backend=new BackendClient(new HttpClient({baseURL:config.baseURL}));
 let confirmed=0,resumed=0;
 backend.confirmServicePurchase=async()=>{confirmed++;return running;};
 backend.resumeServicePurchase=async()=>{resumed++;return running;};
 let json='',text='';
 await runServicesPurchase(backend,config,'se_original',input,{jsonOutput:true,output:s=>json+=s});
 await runServicesPurchase(backend,config,'se_original',undefined,{resume:true,jsonOutput:false,output:s=>text+=s});
 assert.equal(confirmed,1);assert.equal(resumed,1);
 const out=JSON.parse(json);
 assert.equal(out.result.auto_wait_remaining_ms,0);
 assert.match(out.next.command,/services purchase se_original --resume/);
 assert.equal(out.result.effects.payment_requested,false);
 assert.equal(out.result.effects.charged,false);
 assert.match(text,/120秒上限/);assert.match(text,/quote_pending/);
});

test('review exposes complete flat file and does not require asking again',()=>{
 const out=purchaseEnvelope({...running,status:'confirmation_required',review:{review_ref:'server_scope',binding:{service_execution_id:'se_original',owner_ref:'owner',service_contract_version_id:'v1',contract_hash:'hash',capability_id:'paid',material_hash:'before',accepted_material_hash:'after',revision:1,terms_version:'terms',price_kind:'fixed',expires_at:'2099-01-01T00:00:00Z'},summary:{subject:'普通服务',quantity:1},confirmation_template:{...input,user_approved:false,user_answer:'',price_policy:{mode:'exact',currency:'CNY',amount_minor:100}}}});
 const template=out.result.input_template;
 assert.ok(template && typeof template==='object' && 'file_content' in template);
 assert.equal('user_answer_required' in template,false);
 assert.match(out.instruction,/已有明确同意.*沿用/);
 assert.equal(out.next,null);
 assert.ok(Buffer.byteLength(JSON.stringify(out))<12*1024);
});
