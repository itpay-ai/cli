import assert from 'node:assert/strict';
import test from 'node:test';
import {BackendClient} from '../src/client/backend.js';
import {HttpError,HttpClient} from '../src/client/http.js';
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
 const capped=parsePurchaseConfirmation({...input,price_policy:{mode:'capped',currency:'CNY',maximum_minor:200}}).price_policy;assert.equal(capped.mode,'capped');assert.equal(capped.mode==='capped'&&capped.maximum_minor,200);
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
 assert.equal(out.next,null);
 assert.match(out.recovery[0].command,/services purchase se_original --resume/);
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

test('verified official presentation is delivered without optional execution HTTP reads', async()=>{
 const {startMockBackend}=await import('./mock_backend.js');
 const {createServer}=await import('node:http');
 const mock=await startMockBackend();
 const source=new BackendClient(new HttpClient({baseURL:mock.url}));
 const quote=await source.prepareServiceQuote('se_fixture',{capability_id:'precise_report'});
 assert.ok(quote.approval_template);
 await source.recordServiceExecutionAction('se_fixture',{action_type:'approve_purchase',actor_type:'agent',status:'approved',input_snapshot:{...quote.approval_template,user_approved:true}});
 const checkout=await source.createServiceExecutionCheckout('se_fixture',{capability_id:'precise_report'});
 try {for(const slow of ['headers','body']){
  let optionalRequests=0;
  const server=createServer(async(req,res)=>{
   if(req.url==='/v1/service-executions/se_fixture'){optionalRequests++;if(slow==='body'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}return;}
   const response=await fetch(mock.url+req.url,{method:req.method??'GET'});res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const backend=new BackendClient(new HttpClient({baseURL:`http://127.0.0.1:${address.port}`}));
  backend.getServicePurchaseReview=async()=>({...running,status:'checkout_ready',completed_stage:'official_page',checkout,effects:{...effects,page_reused:true,human_page_action_required:true}});
  const started=Date.now();let output='';
  try {
   await runServicesPurchase(backend,config,'se_fixture',undefined,{jsonOutput:true,output:s=>output+=s});
   const result=JSON.parse(output);assert.ok(result.handoff.url);assert.equal(result.result.effects.payment_requested,false);assert.equal(optionalRequests,0);assert.ok(Date.now()-started<2000);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }}finally{await mock.close();}
});


test('purchase read faults preserve the original ID and phase without claiming expiry or effects',async()=>{
 const backend=new BackendClient(new HttpClient({baseURL:config.baseURL}));
 for(const code of ['internal_error','purchase_review_expired']){
  backend.getServicePurchaseReview=async()=>{throw new HttpError(code==='internal_error'?500:409,{code,message:'controlled current read fault'},'fault');};
  await assert.rejects(runServicesPurchase(backend,config,'se_original',undefined,{jsonOutput:true}),error=>{
   assert(error instanceof CommandContractError);assert.equal(error.code,code);assert.equal(error.result?.service_execution_id,'se_original');assert.equal(error.result?.failure_stage,'read_purchase_review');assert.equal(error.result?.provider_called,undefined);assert.equal(error.result?.execution_created,undefined);
   if(code==='purchase_review_expired')assert.equal(error.recovery.length,0);else assert.equal(error.recovery[0]?.command,'itpay services purchase se_original --json');return true;
  });
 }
});

test('purchase recovery preserves persisted confirmation and stops definitive HTTP failures',async()=>{
 const backend=new BackendClient(new HttpClient({baseURL:config.baseURL}));
 for(const stage of ['confirm','resume'] as const){
  for(const status of [400,401,403,404,409,429,500,503]){
   const fault=async()=>{throw new HttpError(status,{code:'controlled_fault',message:'controlled fault'},'fault');};
   backend.confirmServicePurchase=fault;backend.resumeServicePurchase=fault;
   await assert.rejects(runServicesPurchase(backend,config,'se_original',stage==='confirm'?input:undefined,{resume:stage==='resume',jsonOutput:true}),error=>{
    if(status===401||status===403){assert(error instanceof HttpError);assert.equal(error.executionContext?.service_execution_id,'se_original');assert.equal(error.executionContext?.failure_stage,`${stage}_purchase`);return true;}
    assert(error instanceof CommandContractError);assert.equal(error.result?.failure_stage,`${stage}_purchase`);
    assert.deepEqual(error.recovery.map(action=>action.command),status===429||status>=500?['itpay services purchase se_original --resume --json']:[]);return true;
   });
  }
 }
});

test('Dot and Muse receive a credential-free original account link without waiting for QR',async()=>{
 const {startMockBackend}=await import('./mock_backend.js');const mock=await startMockBackend();
 try{
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const quote=await backend.prepareServiceQuote('se_fixture',{capability_id:'precise_report'});assert(quote.approval_template);
  await backend.recordServiceExecutionAction('se_fixture',{action_type:'approve_purchase',actor_type:'agent',status:'approved',input_snapshot:{...quote.approval_template,user_approved:true}});
  const checkout=await backend.createServiceExecutionCheckout('se_fixture',{capability_id:'precise_report'});
  const originalToken=checkout.checkout.display_token;
  checkout.checkout.display_token='';
  checkout.checkout.checkout.expires_at=new Date(Date.now()+60000).toISOString();
  backend.getCheckoutPresentation=async()=>{throw Error('account entry must not read a bearer presentation');};
  checkout.checkout.checkout_url=`https://app-test.itpay.ai/checkout/${checkout.checkout.checkout.checkout_id}`;
  checkout.checkout.official_entry={url:checkout.checkout.checkout_url,purpose:'checkout',access:'account_session'};
  backend.getServicePurchaseReview=async()=>({...running,status:'checkout_ready',completed_stage:'official_page',checkout,effects:{...effects,page_reused:true,human_page_action_required:true}});
  for(const agentType of ['dot','muse']){
   let output='',images=0,persisted=0;
   await runServicesPurchase(backend,{...config,agentType},'se_fixture',undefined,{agentType,jsonOutput:true,persistHandoff:()=>{persisted++;},output:s=>{output+=s},fetchImpl:async()=>{images++;throw Error('optional QR must not block link');}});
   const result=JSON.parse(output);assert.equal(result.handoff.url,checkout.checkout.checkout_url);assert.equal(result.handoff.access,'account_session');assert.equal(images,0);assert.equal(persisted,0);
   assert(!output.includes(originalToken));assert(!output.includes('--token'));assert(!output.includes('display_token='));assert.equal(result.result.agent_facts.effects.order_created,'unknown');assert.equal(result.result.agent_facts.references.checkout_id,checkout.checkout.checkout.checkout_id);assert.match(result.next.command,new RegExp(`--agent-type ${agentType} services get se_fixture`));
  }

  const valid=structuredClone(checkout);
  for(const change of ['expired','missing-expiry','wrong-expiry','wrong-cart','wrong-status','credential-url','wrong-purpose','wrong-access']){
   const altered=structuredClone(valid);
   if(change==='expired')altered.checkout.checkout.expires_at='2000-01-01T00:00:00Z';
   if(change==='missing-expiry')delete altered.checkout.checkout.expires_at;
   if(change==='wrong-expiry')altered.checkout.official_entry!.expires_at='2000-01-01T00:00:00Z';
   if(change==='wrong-cart')altered.checkout.checkout.cart_id='foreign-cart';
   if(change==='wrong-status')altered.checkout.checkout.status='payment_pending';
   if(change==='credential-url'){altered.checkout.checkout_url+='?display_token=forbidden';altered.checkout.official_entry!.url=altered.checkout.checkout_url;}
   if(change==='wrong-purpose')(altered.checkout.official_entry as any).purpose='other';
   if(change==='wrong-access')(altered.checkout.official_entry as any).access='bearer';
   backend.getServicePurchaseReview=async()=>({...running,status:'checkout_ready',completed_stage:'official_page',checkout:altered,effects});
   await assert.rejects(runServicesPurchase(backend,{...config,agentType:'muse'},'se_fixture',undefined,{jsonOutput:true}),e=>e instanceof CommandContractError && ['secure_handoff_unavailable','checkout_not_payable'].includes(e.code),change);
  }
  backend.getServicePurchaseReview=async()=>({...running,status:'checkout_ready',completed_stage:'official_page',checkout:valid,effects});
  await assert.rejects(runServicesPurchase(backend,{...config,agentType:'codex-desktop'},'se_fixture',undefined,{jsonOutput:true}),e=>e instanceof CommandContractError && e.code==='checkout_not_payable','legacy host must still require its bearer');
  backend.getServicePurchaseReview=async()=>({...running,status:'checkout_ready',completed_stage:'official_page',checkout,effects});
  const officialURL=checkout.checkout.checkout_url;
  checkout.checkout.checkout_url=`https://evil.example/checkout/${checkout.checkout.checkout.checkout_id}`;
  checkout.checkout.official_entry={url:checkout.checkout.checkout_url,purpose:'checkout',access:'account_session'};
  await assert.rejects(runServicesPurchase(backend,{...config,agentType:'dot'},'se_fixture',undefined,{jsonOutput:true}),e=>e instanceof CommandContractError&&e.code==='secure_handoff_unavailable');
  checkout.checkout.checkout_url=officialURL;
  delete checkout.checkout.official_entry;
  await assert.rejects(runServicesPurchase(backend,{...config,agentType:'muse'},'se_fixture',undefined,{jsonOutput:true}),e=>e instanceof CommandContractError&&e.code==='secure_handoff_unavailable'&&e.recovery[0]?.command==='itpay --agent-type muse services get se_fixture --json');
 }finally{await mock.close();}
});
