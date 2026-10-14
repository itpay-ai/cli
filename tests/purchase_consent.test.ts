import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFileSync} from 'node:fs';
import {BackendClient} from '../src/client/backend.js';
import {HttpClient} from '../src/client/http.js';
import {runServicesAction,runServicesQuote} from '../src/commands/services.js';
import {startMockBackend} from './mock_backend.js';

test('quote renders complete scoped approval and approval leads to the same quote',async()=>{
 const mock=await startMockBackend();
 try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const model=await backend.getServiceExecution('se_mock_next');
  const cap=model.capabilities.find(c=>c.requires_payment)!;
  backend.getServiceExecution=async()=>({...model,workflow_entry:{capability_id:cap.capability_id,input_schema:{}},capabilities:[{...cap,delivery_email_required:false,input_schema:{}}]});
  const template={service_quote_lock_id:'q_fixture',service_execution_id:'se_fixture',service_id:model.execution.service_id,service_contract_version_id:model.execution.service_contract_version_id,capability_id:cap.capability_id,owner_ref:'agent_fixture:buyer_fixture',material_hash:'canonical_fixture',subject_fingerprint:'subject_fixture',terms_version:'contract_fixture',scope:'prepare_checkout' as const,expires_at:'2099-10-08T01:00:00Z',user_approved:false,evidence_source:'agent_reported' as const,price_policy:{mode:'exact' as const,quote_id:'q_fixture',amount_minor:500,currency:'CNY'}};
  backend.prepareServiceQuote=async()=>({service_quote_lock_id:'q_fixture',service_execution_id:'se_fixture',capability_id:cap.capability_id,amount_minor:500,currency:'CNY',expires_at:template.expires_at,approval_template:template});
  let json='',text='';
  await runServicesQuote(backend,'se_fixture',cap.capability_id,{}, {jsonOutput:true,output:s=>json+=s});
  await runServicesQuote(backend,'se_fixture',cap.capability_id,{}, {jsonOutput:false,output:s=>text+=s});
  const result=JSON.parse(json);
  assert.equal(result.result.approval_template.user_approved,false);
  assert.equal(result.next,null);
  assert.deepEqual(result.interaction.input_template.input,template);
  assert.match(text,/canonical_fixture/);
  assert.match(text,/prepare_checkout/);
  backend.recordServiceExecutionAction=async(_id,input)=>({service_execution_action_id:'approval_fixture',service_execution_id:'se_fixture',action_type:input.action_type,status:'approved',actor_type:'agent'});
  let approved='';
  await runServicesAction(backend,'se_fixture','approve_purchase',{...template,user_approved:true},{actorType:'agent',status:'approved',jsonOutput:true,output:s=>approved+=s});
  assert.equal(JSON.parse(approved).next.command,'itpay services purchase se_fixture --resume --json');
  assert.ok(Buffer.byteLength(json)<12*1024);
  if(process.env.ITPAY_CONSENT_EVIDENCE) writeFileSync(process.env.ITPAY_CONSENT_EVIDENCE,JSON.stringify({scope:'CLI renders controlled server facts; not natural UX',json:result,text,approved:JSON.parse(approved),bytes:Buffer.byteLength(json)},null,2));
 }finally{await mock.close();}
});

test('ordinary service fields cannot select a rail presentation and unknown binding stops',async()=>{
 const {servicesNextEnvelope}=await import('../src/services/presentation.js');
 const mock=await startMockBackend();
 try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const base=await backend.getServiceExecution('se_fixture');
  const ordinary={...base,execution_requests:[],workflow_entry:{capability_id:'itpay_service',input_schema:{type:'object',required:['endpoints'],properties:{endpoints:{type:'string'}}}},workflow:{status:'human_action',current_step:'review',revision:1,steps:{},human_action:{action_type:'accept_document',input_schema:{type:'object',required:['accepted'],properties:{accepted:{type:'boolean'}}},context:{review:{document_revision:2},places:{origin:{resolution_candidates:[]}},search:{}}}}};
  const shown=servicesNextEnvelope(ordinary);
  assert.equal(shown.status,'confirmation_required');
  assert.doesNotMatch(JSON.stringify(shown),/车票|席别|站点|地图|booking_review_required/);
  assert.deepEqual(shown.interaction?.input_template?.input,{accepted:false});
  const terminal=servicesNextEnvelope({...ordinary,execution:{...ordinary.execution,status:'failed'}});
  assert.equal(terminal.status,'failed');
  assert.equal(terminal.next,null);
  assert.doesNotMatch(JSON.stringify(terminal),/accept_document/);
  const unknown=servicesNextEnvelope({...ordinary,execution:{...ordinary.execution,public_binding:{public_service_id:'other',service_definition_version:'future',operation_id:'review',adapter_key:'future.v1'}}});
  assert.equal(unknown.status,'presentation_contract_unavailable');
  assert.equal(unknown.next,null);
 }finally {await mock.close();}
});

test('templates do not accept boolean defaults or silently downgrade malformed public purchase',async()=>{
 const {serviceInputTemplate}=await import('../src/services/shared/input.js');
 const {publicPurchaseTemplate}=await import('../src/services/shared/platform.js');
 assert.deepEqual(serviceInputTemplate({required:['accepted'],properties:{accepted:{type:'boolean',default:true}}}),{accepted:false});
 assert.equal(publicPurchaseTemplate(undefined),undefined);
 assert.throws(()=>publicPurchaseTemplate({service_id:'itpay-rail',operation_id:'prepare_purchase',input:{selections:[]}}),/incomplete public purchase/);
});

test('public overview uses complete rail endpoints and structured actions never execute server shell',async()=>{
 const {writeServiceOverview}=await import('../src/commands/services/lifecycle.js');
 let overview='';
 writeServiceOverview({schema_version:'itpay.service-definition.v1',service_id:'itpay-rail',definition_version:'scv_itpay_rail_public_v1',adapter_key:'rail.v1',display_names:{'zh-CN':'火车票服务'},operations:[{id:'query_smart',role:'query',billing_mode:'free',display_names:{'zh-CN':'Smart'},binding:{service_id:'itpay-rail-smart',service_contract_version_id:'scv_itpay_rail_smart_v6',capability_id:'itpay_service'},input_schema:{required:['travel_date'],properties:{travel_date:{type:'string'},endpoints:{type:'object',required:['origin','destination'],properties:{origin:{type:'object',required:['text'],properties:{text:{type:'string'}}},destination:{type:'object',required:['text'],properties:{text:{type:'string'}}}}}}}}]},{jsonOutput:true,output:s=>overview+=s});
 assert.deepEqual(JSON.parse(overview).result.operations[0].input_template.input.input.endpoints,{origin:{text:'<text>'},destination:{text:'<text>'}});
 const {railAvailableActions}=await import('../src/services/rail/actions.js');
 const {serviceInputTemplate}=await import('../src/services/shared/input.js');
 const actions=railAvailableActions({plan_id:'p',query_revision:2,readiness:'ready',snapshot_id:'snap',available_actions:[{type:'read_updates',command:'curl https://invalid.test',provider_effect:'none'},{type:'expand_search',command:'rm -rf /',provider_effect:'bounded_provider_batch',target:{service_execution_id:'se',query_revision:2,snapshot_id:'snap'},input:{action_request_id:'handle',expected_query_revision:2,snapshot_id:'snap'}}]},'se');
 assert.equal(actions[0]?.command,'itpay services next se --since-snapshot snap --json');
 const expansion=actions[1]?.input_template;assert(expansion && typeof expansion==="object" && "command" in expansion && "file_content" in expansion);assert.equal(actions[1]?.command,undefined);assert.match(String(expansion.command),/workflow:expand_search.*--input-json/);assert.deepEqual(expansion.file_content,{action_request_id:"handle",expected_query_revision:2,snapshot_id:"snap"});
 assert.doesNotMatch(JSON.stringify(actions),/curl|rm -rf/);
 assert.deepEqual(serviceInputTemplate({required:['count','priority'],properties:{count:{type:'integer',minimum:1,default:1},priority:{type:'string',enum:['fastest','cheapest']}}}),{count:'<count>',priority:'<priority>'});
});

test('public operation recovery executes through main with the original operation and continuation', async()=>{
 const {createServer}=await import('node:http');
 const {mkdtempSync,writeFileSync,rmSync,readFileSync}=await import('node:fs');
 const {tmpdir}=await import('node:os'); const {join,resolve}=await import('node:path');
 const {execFile}=await import('node:child_process'); const {promisify}=await import('node:util');
 const mock=await startMockBackend(); const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
 const base=await backend.getServiceExecution('se_mock_next'); const evidence=[];
 const work=mkdtempSync(join(tmpdir(),'itpay-operation-recovery-'));
 try {for(const operation of ['query_exact','query_smart','prepare_purchase','legacy']) for(const mode of ['new','execution','continuation']) {
  if(operation==='legacy' && mode!=='new')continue;
  const serviceID=operation==='legacy'?'legacy-service':'itpay-rail';
  const id='se_recovery';const continuation={service_execution_id:'se_original',snapshot_id:'snapshot_original'};
  const binding={public_service_id:'itpay-rail',service_definition_version:'scv_itpay_rail_public_v1',operation_id:operation,adapter_key:'rail.v1',...(mode==='continuation'?{source_execution_id:continuation.service_execution_id,source_snapshot_id:continuation.snapshot_id}:{})};
  const model={...base,execution:{...base.execution,service_execution_id:id,service_id:serviceID,...(operation!=='legacy'?{public_binding:binding}:{})},execution_requests:[],workflow_entry:{capability_id:'itpay_service',input_schema:{}},workflow:{status:'human_action',current_step:'review',revision:1,steps:{},human_action:{action_type:'accept_document',input_schema:{properties:{accepted:{type:'boolean'}},required:['accepted']}}}};
  let failed=false;const calls:Array<{path:string;body:Record<string,unknown>}>=[];
  const schema={type:'object',properties:{travel_date:{type:'string'},passengers:{type:'integer'},user_approved:{type:'boolean'},owner_ref:{type:'string'}},required:['travel_date','passengers','user_approved','owner_ref']};
  const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();const body=raw?JSON.parse(raw):{};const path=req.url!;
   if(path==='/v1/service-executions' || path===`/v1/service-executions/${id}/advance`) {
    calls.push({path,body});res.setHeader('content-type','application/json');
    if(!failed){failed=true;res.statusCode=400;res.end(JSON.stringify({code:'capability_input_invalid',message:'travel_date required',service_id:'itpay-rail-exact',service_contract_version_id:'scv_itpay_rail_exact_v1',input_schema:schema,...(mode==='execution'?{service_execution_id:id}:{}),execution_created:mode==='execution',provider_called:false}));return;}
    res.end(JSON.stringify(path.endsWith('/advance')?model:{execution:model.execution,capabilities:[],workflow_entry:model.workflow_entry}));return;
   }
   if(path===`/v1/service-executions/${id}`){res.setHeader('content-type','application/json');res.end(JSON.stringify(model));return;}
   const forwarded=await fetch(mock.url+path,{method:req.method!,headers:{'content-type':'application/json'},...(raw?{body:raw}:{})});res.statusCode=forwarded.status;res.setHeader('content-type','application/json');res.end(await forwarded.text());
  }); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)); const address=server.address();assert(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  let entry=resolve('tests/cli_test_entry.ts');
  if(process.env.ITPAY_REWORK_MAIN){entry=join(work,'packed-entry.mjs');writeFileSync(entry,readFileSync(resolve('tests/cli_test_entry.ts'),'utf8').replace('await import(process.env.ITPAY_CLI_PACKAGE_ENTRY ?? "../src/main.js");',`await import(${JSON.stringify(process.env.ITPAY_REWORK_MAIN)});`));}
  const executable=entry.endsWith('.ts')?resolve('node_modules/.bin/tsx'):process.execPath;
  const run=async(args:string[])=>{try{return await promisify(execFile)(executable,[entry,...args],{env:{...process.env,NODE_ENV:'test',ITPAY_AGENT_TYPE:'codex-cli',HOME:work,ITPAY_CLI_TEST_TRANSPORT_URL:url},timeout:15000});}catch(error){const output=error as {stdout:string;stderr:string};return output;}};
  try {
   const file=join(work,'input.json');const known={passengers:2,user_approved:false,owner_ref:'fixture-owner'};writeFileSync(file,JSON.stringify(operation==='legacy'?known:{input:known,...(mode==='continuation'?{continuation}:{})}));
   const first=await run(['services','run',serviceID,...(operation!=='legacy'?['--operation',operation]:[]),...(mode==='execution'?['--execution',id]:[]),'--input-json',file,'--timeout','0','--json']);
   const failure=JSON.parse(first.stdout || first.stderr);assert(failure.interaction,JSON.stringify(failure));const template=failure.interaction.input_template;
   if(operation!=='legacy')assert.match(template.command,new RegExp(`--operation ${operation}`));else assert.doesNotMatch(template.command,/--operation/);
   const parameters=operation==='legacy'?template.input:template.input.input;assert.deepEqual(parameters, {...known,travel_date:'<travel_date>'});
   const returnedTemplate=JSON.parse(JSON.stringify(template));
   if(mode==='continuation')assert.deepEqual(template.input.continuation,continuation);
   parameters.travel_date='2030-10-09';writeFileSync(file,JSON.stringify(template.input));
   const args=template.command.replace(/^itpay /,'').replace('<file>',file).split(' ');args.push('--timeout','0');
   const second=await run(args);const result=JSON.parse(second.stdout);assert.notEqual(result.status,'service_overview');
   const retry=calls.find((call,index)=>index>0&&!call.path.endsWith('/advance')) ?? calls.at(-1)!;
   if(!retry.path.endsWith('/advance')){if(operation!=='legacy')assert.equal(retry.body.operation_id,operation);else assert.equal(retry.body.operation_id,undefined);if(mode==='continuation')assert.deepEqual(retry.body.continuation,continuation);}
   assert.deepEqual(retry.body.input,{...known,travel_date:'2030-10-09'});
   evidence.push({operation,mode,template:returnedTemplate,result,calls});
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }} finally {await mock.close();rmSync(work,{recursive:true,force:true});}
 if(process.env.ITPAY_REWORK_EVIDENCE)writeFileSync(process.env.ITPAY_REWORK_EVIDENCE,JSON.stringify({scope:'Actual main entry and synthetic HTTP facts; no real services or transaction',cases:evidence},null,2));
});

test('same error codes and result selectors cannot cross a locked service boundary',async()=>{
 const {runServicesRun,runServicesReadResult}=await import('../src/commands/services.js');
 const {HttpError}=await import('../src/client/http.js');const {loadConfig}=await import('../src/state/config.js');
 const mock=await startMockBackend();try{
 const backend=new BackendClient(new HttpClient({baseURL:mock.url}));const base=await backend.getServiceExecution('se_mock_next');
 for(const identity of [{service_id:'ordinary',service_contract_version_id:'v1'},{service_id:'itpay-rail-smart',service_contract_version_id:'unknown'}]) {
  backend.startServiceExecution=async()=>{throw new HttpError(400,{...identity,code:'invalid_selection',message:'bad candidate',reason:'input_constraint_invalid'},'invalid');};
  await assert.rejects(runServicesRun(backend,loadConfig({}),'ordinary',{endpoints:{},review:{},search:{}}),error=>{assert(error instanceof Error);assert.equal((error as import('../src/services/shared/envelope.js').CommandContractError).code,'invalid_selection');assert.doesNotMatch(JSON.stringify(error),/rail-booking/);return true;});
  backend.startServiceExecution=async()=>{throw new HttpError(400,{...identity,code:'capability_input_invalid',message:'missing endpoints',input_schema:{type:'object',properties:{endpoints:{type:'string'}},required:['endpoints']}},'invalid');};
  await assert.rejects(runServicesRun(backend,loadConfig({}),'ordinary',{}),error=>{assert(error instanceof Error);const recovery=error as import('../src/services/shared/envelope.js').CommandContractError;assert.doesNotMatch(JSON.stringify({instruction:recovery.instruction,interaction:recovery.interaction}),/铁路|席别|rail-booking/);if(identity.service_contract_version_id==='unknown'){assert.equal(recovery.code,'presentation_contract_unavailable');assert.equal(recovery.interaction,undefined);}return true;});
  backend.getServiceExecution=async()=>({...base,execution:{...base.execution,...identity}});
  backend.recordServiceExecutionAction=async()=>{throw new HttpError(400,{code:'booking_review_invalid',message:'bad generic review'},'invalid');};
  await assert.rejects(runServicesAction(backend,'se_fixture','accept_document',{}),error=>{assert(error instanceof HttpError);return true;});
  let businessReads=0;backend.getRailJourneyDetail=async()=>{businessReads++;throw new Error('must not read');};
  await assert.rejects(runServicesReadResult(backend,'se_fixture',{journey:'j_fixture'}));assert.equal(businessReads,0);
 }
 }finally{await mock.close();}
});

test('candidate selection is a non-executable interaction for one or many free or paid candidates',async()=>{
 const {servicesNextEnvelope}=await import('../src/services/presentation.js');const mock=await startMockBackend();try{
 const backend=new BackendClient(new HttpClient({baseURL:mock.url}));const base=await backend.getServiceExecution('se_mock_next');
 for(const count of [1,2])for(const paid of [false,true]){
 const model={...base,execution_requests:[],current_result_items:Array.from({length:count},(_,index)=>({...base.result_items[0]!,rank:index+1,display_title:`candidate ${index+1}`})),allowed_actions:[{type:'select_candidate',requires_human:true}],capabilities:base.capabilities.map(cap=>({...cap,requires_payment:paid}))};
 delete model.workflow_entry;
 const value=servicesNextEnvelope(model);assert.equal(value.next,null);assert.equal(value.interaction?.input_template?.executable,false);assert.doesNotMatch(JSON.stringify(value.recovery),/<rank>|approve_purchase/);
 }
 }finally{await mock.close();}
});

test('buy refuses original unpayable checkout before rendering or payment',async()=>{
 const {runBuy}=await import('../src/commands/buy.js');
 const {loadConfig}=await import('../src/state/config.js');
 const {CartSession}=await import('../src/state/cart_session.js');
 const {CommandContractError}=await import('../src/services/shared/envelope.js');
 const mock=await startMockBackend();
 try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const cart={cart_id:'cart_original',status:'active',amount_minor:500,currency:'CNY',items:[{title:'server original journey',quantity:1,amount_minor:500,currency:'CNY',service_execution_id:'se_original',service_quote_lock_id:'q_original'}]};
  backend.getCart=async()=>cart;
  let creates=0,payments=0;
  backend.createPaymentIntent=async()=>{payments++;throw new Error('must not pay');};
  for(const status of ['expired','failed','payment_pending','payment_succeeded','payment_required']) {
   backend.createCheckout=async()=>{creates++;return {checkout:{checkout_id:'chk_original',cart_id:cart.cart_id,status,next_action:'none',amount_minor:500,currency:'CNY',expires_at:'2026-10-09T01:00:00Z'},display_token:'test_only',checkout_url:'http://localhost/checkout/chk_original',qr_payload:''};};
   backend.getCheckoutPresentation=async()=>({checkout:{checkout_id:'chk_original',cart_id:cart.cart_id,status,next_action:'none',amount_minor:500,currency:'CNY',expires_at:'2026-10-09T01:00:00Z'},items:cart.items,payment_intents:[],buyer_session:{state:'account'},server_now:'2026-10-09T01:00:01Z',payment_remaining_seconds:0});
   await assert.rejects(runBuy(backend,loadConfig({}),{cartSession:new CartSession('CNY'),cartID:cart.cart_id,host:'plain-chat',pay:true,jsonOutput:true}),error=>{
    assert(error instanceof CommandContractError);assert.equal(error.code,'checkout_not_payable');return true;
   });
  }
  assert.equal(creates,5); // replay requests only; Backend tests assert no new purchase/tokens
  assert.equal(payments,0);
 }finally{await mock.close();}
});

test('missing public continuation retries only the pinned detail once and then stops',async()=>{
 const {readSavedResult}=await import('../src/services/rail/reading.js');
 const {CommandContractError}=await import('../src/services/shared/envelope.js');
 const mock=await startMockBackend();
 try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const model=await backend.getServiceExecution('se_fixture');
  model.execution.public_binding={public_service_id:'itpay-rail',service_definition_version:'scv_itpay_rail_public_v1',operation_id:'query_smart',adapter_key:'rail.v1'};
  const broken={service_id:'itpay-rail',operation_id:'prepare_purchase',input:{selections:[]}};
  const plan={ticket_plan_ref:'tp',qualification_status:'eligible',booking_input:{selections:[]},purchase_operation:broken};
  const detail:Awaited<ReturnType<BackendClient['getRailJourneyDetail']>>={service_execution_id:'se_fixture',plan_id:'p',snapshot_id:'snap',query_revision:1,journey:{journey_id:'journey',route_family_id:'rf',qualification_status:'eligible',ticket_plans:[plan]}};
  let reads=0;
  backend.getRailJourneyDetail=async(_id,_journey,snapshot)=>{reads++; if(reads===2)assert.equal(snapshot,'snap');return detail;};
  await assert.rejects(readSavedResult(backend,model,'se_fixture',{journey:'journey',jsonOutput:true,output:()=>{}}),error=>{assert(error instanceof CommandContractError);assert.equal(error.code,'public_operation_contract_invalid');assert.equal(error.recovery.length,0);return true;});
  assert.equal(reads,2);
  reads=0;let output='';
  backend.getRailJourneyDetail=async()=>{reads++;return reads===1?detail:{...detail,journey:{...detail.journey,ticket_plans:[{...plan,purchase_operation:{...broken,continuation:{service_execution_id:'se_fixture',snapshot_id:'snap'}}}]}};};
  await readSavedResult(backend,model,'se_fixture',{journey:'journey',jsonOutput:true,output:s=>output+=s});
  assert.equal(reads,2);assert.equal(JSON.parse(output).result.snapshot_id,'snap');
  assert.match(output,/--operation/);
 }finally{await mock.close();}
});

test('refund manual and unknown watches return immediately with all owner facts',async()=>{
 const {runWatchRefund}=await import('../src/commands/refund.js');
 const {refundStateEnvelope}=await import('../src/services/shared/refund.js');
 const mock=await startMockBackend();
 try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));const base=await backend.getRefund('rr_pending');
  const patches:Partial<Awaited<ReturnType<BackendClient['getRefund']>>>[]=[{decision_mode:'manual'},{status:'failed',failure_class:'outcome_unknown'}];
  for(const patch of patches) {
   backend.getRefund=async()=>({...base,...patch});let output='';const start=Date.now();
   await runWatchRefund(backend,'rr_pending',{jsonOutput:true,output:s=>output+=s});
   assert.ok(Date.now()-start<1000);const envelope=JSON.parse(output);
   assert.equal(envelope.result.access_locked,base.access_locked);
   assert.doesNotMatch(String(envelope.next?.command),/watch/);
   if(patch.failure_class)assert.equal(envelope.result.failure_class,'outcome_unknown');
  }
  for(const status of ['succeeded','cancelled','rejected'])assert.equal(refundStateEnvelope({...base,status},'shown').next,null);
 }finally{await mock.close();}
});

test('public expired prepare preserves typed adapter and complete original query file',async()=>{
 const {runServicesRun}=await import('../src/commands/services.js');
 const {loadConfig}=await import('../src/state/config.js');
 const {HttpError}=await import('../src/client/http.js');
 const {CommandContractError}=await import('../src/services/shared/envelope.js');
 const mock=await startMockBackend();try{
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const binding={public_service_id:'itpay-rail',service_definition_version:'scv_itpay_rail_public_v1',adapter_key:'rail.v1',operation_id:'prepare_purchase'};
  const query={endpoints:{origin:{kind:'station',text:'甲站'},destination:{kind:'place',text:'乙住宅'}},travel_date:'2030-10-15',passengers:1,priority:'fastest',reuse_from:{execution_id:'old'}};
  for(const mode of ['fresh','existing','history_failed','unknown_contract','wrong_binding']) {
   backend.startServiceExecution=async()=>{throw new HttpError(409,{code:'rail_selection_expired',message:'saved choice expired',execution_created:false,provider_called:false,service_id:'itpay-rail-booking',service_contract_version_id:'scv_itpay_rail_booking_v4',public_binding:{...binding,...(mode==='wrong_binding'?{public_service_id:'another_service'}:mode==='unknown_contract'?{service_definition_version:'unknown'}:{})},selection_expiry:{query_execution_id:'se_query',query_service_id:'itpay-rail-smart',query_public_binding:{...binding,operation_id:'query_smart'},expired_at:'2000-01-01T00:00:00Z',query_input:query,safe_new_query:mode==='fresh',...(mode==='existing'?{booking_execution_id:'se_original'}:{}),...(mode==='history_failed'?{recovery_block_reason:'购买历史读取失败'}:{})}},'expired');};
   await assert.rejects(runServicesRun(backend,loadConfig({}), 'itpay-rail',{selections:[],passengers:1},{operationID:'prepare_purchase'}),error=>{
    if(mode==='unknown_contract'||mode==='wrong_binding'){assert(error instanceof CommandContractError);assert.equal(error.code,'rail_selection_expired');assert.equal(error.interaction,undefined);return true;}
    assert(error instanceof CommandContractError);assert.equal(error.result?.execution_created,false);
    const template=error.interaction?.input_template;
    if(mode==='fresh'){
     assert(template);assert.match(template.command,/services run itpay-rail --operation query_smart --input-json <file>/);
     assert.deepEqual(template.file_content,{input:Object.fromEntries(Object.entries(query).filter(([key])=>key!=='reuse_from'))});
     assert.deepEqual(template.input,template.file_content);assert.equal(template.user_answer_required,undefined);assert.equal(error.recovery.length,0);
    }else{assert.equal(template,undefined);if(mode==='existing')assert.match(error.recovery[0]!.command,/next se_original/);else assert.match(error.instruction,/购买历史读取失败/);}
    return true;
   });
  }
 }finally{await mock.close();}
});

test('saved credential deadline is distinct from historical itinerary and missing expiry',async()=>{
 const {purchaseCredentialFacts}=await import('../src/services/rail/results.js');
 assert.equal(purchaseCredentialFacts(undefined).status,'unknown');
 assert.equal(purchaseCredentialFacts('0001-01-01T00:00:00Z').status,'unknown');
 assert.equal(purchaseCredentialFacts('2000-01-01T00:00:00Z').status,'expired');
 assert.equal(purchaseCredentialFacts('2099-01-01T00:00:00Z').status,'not_expired');
});

test('run shares the remaining deadline with quote and authoritative checkout presentation',async()=>{
 const {createServer}=await import('node:http');const {mkdtempSync,readFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const mock=await startMockBackend();
 try{
  const base=await new BackendClient(new HttpClient({baseURL:mock.url})).getServiceExecution('se_budget');
  const results:unknown[]=[];
  for(const stage of ['quote','presentation']){
   const calls:string[]=[];const home=mkdtempSync(join(tmpdir(),'itpay-run-budget-'));
   const model={...base,execution_requests:[],current_result_items:[],delivery_bindings:[],payment_bindings:[],checkout_bindings:[],execution:{...base.execution,status:'running'},workflow_entry:{capability_id:'precise_report',input_schema:{}},workflow:{status:'payment',current_step:'payment',revision:1,steps:{}},capabilities:base.capabilities.map(c=>({...c,input_schema:{},delivery_email_required:false})),actions:stage==='presentation'?[{action_type:'approve_purchase',status:'approved'}]:[]};
   const server=createServer(async(req,res)=>{
    const path=req.url!;calls.push(`${req.method} ${path.split('?')[0]}`);const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();
    if(path==='/v1/service-executions/se_budget'){await new Promise(resolve=>setTimeout(resolve,700));res.setHeader('content-type','application/json');res.end(JSON.stringify(model));return;}
    if(path.endsWith('/quotes')||path.includes('/presentation')){await new Promise(resolve=>setTimeout(resolve,600));}
    if(res.destroyed)return;
    const forwarded=await fetch(mock.url+path,{method:req.method!,headers:{'content-type':'application/json'},...(body?{body}:{})});res.statusCode=forwarded.status;res.setHeader('content-type','application/json');res.end(await forwarded.text());
   });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
   let entry=resolve('tests/cli_test_entry.ts');if(process.env.ITPAY_CLI_PACKAGE_ENTRY){entry=join(home,'entry.mjs');writeFileSync(entry,readFileSync(resolve('tests/cli_test_entry.ts'),'utf8'));}
   const started=Date.now();let output='';
   try{await promisify(execFile)(entry.endsWith('.ts')?resolve('node_modules/.bin/tsx'):process.execPath,[entry,'services','run','svc_qizhidao_company_lookup','--execution','se_budget','--timeout','1','--json'],{env:{...process.env,HOME:home,ITPAY_AGENT_TYPE:'codex-cli',ITPAY_CLI_TEST_TRANSPORT_URL:`http://127.0.0.1:${address.port}`},timeout:5000});assert.fail('slow command should reach its shared budget');}
   catch(error){output=(error as {stdout:string}).stdout;assert.match(output,/network_timeout|workflow_start_outcome_unknown/);assert(Date.now()-started<2200,'actual CLI process exits without another 30s request budget');}
   finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
   assert.equal(calls.filter(x=>x.includes('/quotes')).length,stage==='quote'?1:0);
   assert.equal(calls.filter(x=>x.endsWith('/checkout')).length,stage==='presentation'?1:0);
   assert.equal(calls.filter(x=>x.includes('/presentation')).length,stage==='presentation'?1:0);
   results.push({stage,elapsed_ms:Date.now()-started,calls,output:JSON.parse(output)});
  }
  if(process.env.ITPAY_EVIDENCE_DIR)writeFileSync(join(process.env.ITPAY_EVIDENCE_DIR,'R1-real-http-budget.json'),JSON.stringify(results,null,2));
 }finally{await mock.close();}
});

test('real CLI authorization timeout exits without late verification or original business write',async()=>{
 const {createServer}=await import('node:http');const {mkdtempSync,readFileSync,readdirSync,existsSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const mock=await startMockBackend();const home=mkdtempSync(join(tmpdir(),'itpay-process-auth-budget-'));const calls:string[]=[];
 const server=createServer(async(req,res)=>{
  const path=req.url!;calls.push(`${req.method} ${path.split('?')[0]}`);const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();
  if(path==='/v1/agent-device-enrollments')await new Promise(resolve=>setTimeout(resolve,2200));
  if(res.destroyed)return;
  const f=await fetch(mock.url+path,{method:req.method!,headers:{'content-type':'application/json'},...(body?{body}:{})});res.statusCode=f.status;res.setHeader('content-type','application/json');res.end(await f.text());
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
 let entry=resolve('tests/cli_test_entry.ts');if(process.env.ITPAY_CLI_PACKAGE_ENTRY){entry=join(home,'entry.mjs');writeFileSync(entry,readFileSync(resolve('tests/cli_test_entry.ts'),'utf8'));}
 const file=join(home,'query.json');writeFileSync(file,JSON.stringify({keyword:'fixture'}));const started=Date.now();let output='';
 try{
  try{await promisify(execFile)(entry.endsWith('.ts')?resolve('node_modules/.bin/tsx'):process.execPath,[entry,'services','run','svc_qizhidao_company_lookup','--input-json',file,'--timeout','1','--json'],{env:{...process.env,HOME:home,ITPAY_AGENT_TYPE:'codex-cli',ITPAY_CLI_TEST_TRANSPORT_URL:`http://127.0.0.1:${address.port}`},timeout:5000});assert.fail('expected timeout');}catch(error){output=(error as {stdout:string}).stdout;assert.match(output,/network_timeout|workflow_start_outcome_unknown/);}
  const elapsed=Date.now()-started;assert(elapsed<2100,'CLI exits before slow enrollment returns');
  const stateRoot=join(home,'.itpay-v3');const snapshots=()=>JSON.stringify(existsSync(stateRoot)?readdirSync(stateRoot,{recursive:true}).filter(x=>String(x).endsWith('.json')).map(x=>[x,readFileSync(join(stateRoot,String(x)),'utf8')]):[]);const snapshot=snapshots();
  await new Promise(resolve=>setTimeout(resolve,2300));assert.equal(snapshots(),snapshot);
  assert.equal(calls.filter(x=>x.includes('/agent-device-enrollments')).length,1);assert.equal(calls.filter(x=>x==='POST /v1/service-executions').length,0);
  if(process.env.ITPAY_EVIDENCE_DIR)writeFileSync(join(process.env.ITPAY_EVIDENCE_DIR,'R2-real-authority-process.json'),JSON.stringify({scope:'real DeviceAuthority and fetch, synthetic isolated key, loopback server',elapsed_ms:elapsed,requests:calls,late_state_write:false,original_business_post:false,output:JSON.parse(output)},null,2));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await mock.close();}
});

test('candidate lookup consumes the action budget before any write',async()=>{
 const {createServer}=await import('node:http');let writes=0;
 const server=createServer(async(req,res)=>{
  if(req.method==='POST')writes++;
  await new Promise(resolve=>setTimeout(resolve,160));
  if(!res.destroyed){res.setHeader('content-type','application/json');res.end('{}');}
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 try{
  const backend=new BackendClient(new HttpClient({baseURL:`http://127.0.0.1:${address.port}`}));
  const start=Date.now();
  await assert.rejects(runServicesAction(backend,'se_candidate','select_candidate',{}, {candidateRank:1,deadline:start+60}),/request|timeout|network/i);
  assert.ok(Date.now()-start<150);assert.equal(writes,0);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('actual CLI keeps chat consent unknown and branches saved-result guidance on returned facts',async()=>{
 const {createServer}=await import('node:http');const {mkdtempSync,readFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const mock=await startMockBackend();const base=await new BackendClient(new HttpClient({baseURL:mock.url})).getServiceExecution('se_fixture');const home=mkdtempSync(join(tmpdir(),'itpay-consent-facts-'));let scenario='no_consent';let approvals=0;const evidence:unknown[]=[];
 const diagnostic={journey_id:'j_diag',qualification_status:'ineligible',qualification_reasons:['INVENTORY_INSUFFICIENT'],booking_support:'none',rides:[{train_code:'G1',departure:'2030-10-01 09:00',arrival:'2030-10-01 10:00'}]};
 const server=createServer(async(req,res)=>{
  const path=req.url!;const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();res.setHeader('content-type','application/json');
  if(path==='/v1/service-executions/se_fixture'){
   const reading=scenario.startsWith('page_');res.end(JSON.stringify({...base,execution:{...base.execution,service_id:reading?'itpay-rail-smart':base.execution.service_id,service_contract_version_id:reading?'scv_itpay_rail_smart_v6':base.execution.service_contract_version_id},workflow_entry:{capability_id:'precise_report',input_schema:{}},capabilities:base.capabilities.map(c=>({...c,input_schema:{},delivery_email_required:false}))}));return;
  }
  if(path.includes('/result-items/')){
   const empty=scenario==='page_empty'||scenario==='page_empty_next'||scenario==='page_empty_history';const unknown=scenario==='page_history'||scenario==='page_empty_history';
   res.end(JSON.stringify({snapshot_id:'snap',plan_id:'plan',query_revision:1,page:{result:{journey_page:{total:empty?(scenario==='page_empty_next'?2:0):1,next_offset:scenario==='page_empty_next'?1:null,...(!unknown?{qualification_counts:{eligible:0,ineligible:empty?0:1,unknown:0}}:{})},journeys:empty?[]:[diagnostic]}}}));return;
  }
  if(path.endsWith('/actions'))approvals++;
  const f=await fetch(mock.url+path,{method:req.method!,headers:{'content-type':'application/json'},...(body?{body}:{})});let response=JSON.parse(await f.text());
  if(path.endsWith('/quotes')&&scenario==='changed_terms'){response={...response,amount_minor:700,approval_template:{...response.approval_template,terms_version:'changed-terms',price_policy:{...response.approval_template.price_policy,amount_minor:700}}};}
  res.statusCode=f.status;res.end(JSON.stringify(response));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
 let entry=resolve('tests/cli_test_entry.ts');if(process.env.ITPAY_CLI_PACKAGE_ENTRY){entry=join(home,'entry.mjs');writeFileSync(entry,readFileSync(resolve('tests/cli_test_entry.ts'),'utf8'));}
 const run=async(args:string[])=>{const r=await promisify(execFile)(entry.endsWith('.ts')?resolve('node_modules/.bin/tsx'):process.execPath,[entry,...args],{env:{...process.env,HOME:home,ITPAY_AGENT_TYPE:'codex-cli',ITPAY_CLI_TEST_TRANSPORT_URL:`http://127.0.0.1:${address.port}`},timeout:10000});return r.stdout;};
 try{
  for(scenario of ['no_consent','existing_chat_consent','changed_terms']){
   // Conversation consent is deliberately not supplied to the CLI, which cannot know it.
   const args=['services','quote','se_fixture','--capability','precise_report'];const json=JSON.parse(await run([...args,'--json']));const plain=await run(args);
   assert.equal(json.interaction.input_template.user_answer_required,undefined);assert.equal(json.interaction.input_template.file_content.user_approved,false);assert.equal(json.next,null);assert.match(json.interaction.consent_rule,/false/);assert.ok(plain.includes(json.instruction));
   if(scenario==='changed_terms')assert.equal(json.result.approval_template.terms_version,'changed-terms');
   evidence.push({scenario,scope:'output semantics only; no human consent submitted',json,plain});
  }
  for(scenario of ['page_empty','page_diagnostic','page_history','page_empty_history','page_empty_next']){
   const args=['services','read-result','se_fixture','--snapshot','snap'];const json=JSON.parse(await run([...args,'--json']));const plain=await run(args);assert.ok(plain.includes(json.instruction));
   if(scenario==='page_empty'||scenario==='page_empty_history'){assert.equal(json.result.total,0);assert.equal(json.next,null);assert.doesNotMatch(json.instruction,/detail\.command/);}
   else if(scenario==='page_empty_next'){assert.equal(json.result.count,0);assert.match(json.next.command,/--offset 1/);assert.doesNotMatch(json.instruction,/detail\.command/);}
   else{assert.match(json.result.journeys[0].detail.command,/--journey j_diag/);assert.match(json.instruction,/detail\.command/);}
   evidence.push({scenario,json,plain});
  }
  assert.equal(approvals,0);
  if(process.env.ITPAY_EVIDENCE_DIR)writeFileSync(join(process.env.ITPAY_EVIDENCE_DIR,'R4-R5-package-output.json'),JSON.stringify({scope:'exact package with real HTTP and isolated DeviceAuthority; fixed Backend response fixtures; no approval action',approvals,outputs:evidence},null,2));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await mock.close();}
});

test('creation validation protects both cached checkout handoffs while valid presentation failures retain recovery',async()=>{
 const {runBuy}=await import('../src/commands/buy.js');
 const {runServicesCheckout}=await import('../src/commands/services/commerce.js');
 const {CartSession}=await import('../src/state/cart_session.js');
 const {loadConfig}=await import('../src/state/config.js');
 const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const mock=await startMockBackend();
 try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const config={...loadConfig({ITPAY_STATE_DIR:mkdtempSync(join(tmpdir(),'itpay-created-checkout-'))}),idempotencyKey:'isolated-checkout-validation'};
  const cart={cart_id:'cart_fixture',status:'draft',amount_minor:500,currency:'CNY',items:[]};
  backend.getCart=async()=>cart;
  const serviceFacts={service_quote_lock_id:'quote_fixture',capability_id:'fixture',locked_input:{},binding:{service_checkout_binding_id:'binding_fixture',service_execution_id:'se_fixture',service_quote_lock_id:'quote_fixture',checkout_id:'chk_fixture',status:'active'},handoff_reissued:true};
  let presentationReads=0,paymentWrites=0;
  backend.getCheckoutPresentation=async()=>{presentationReads++;throw new Error('fixture presentation unavailable');};
  backend.createPaymentIntent=async()=>{paymentWrites++;throw new Error('must not pay');};
  for(const values of [{cartID:'other_cart',token:'fixture',status:'payment_required'},{cartID:cart.cart_id,token:'',status:'payment_required'},{cartID:cart.cart_id,token:'fixture',status:'payment_pending'}]) {
   const checkout={checkout:{checkout_id:'chk_rejected',cart_id:values.cartID,status:values.status,next_action:'none',amount_minor:500,currency:'CNY'},display_token:values.token,checkout_url:'http://fixture/checkout/chk_rejected',qr_payload:''};
   backend.createCheckout=async()=>checkout;
   backend.createServiceExecutionCheckout=async()=>({...serviceFacts,binding:{...serviceFacts.binding,checkout_id:checkout.checkout.checkout_id},cart,checkout});
   const session=new CartSession('CNY');let persisted=0;
   await assert.rejects(runBuy(backend,config,{cartSession:session,cartID:cart.cart_id,host:'plain-chat',pay:true,jsonOutput:true}),/current payable entry/);
   assert.equal(session.show().lastCheckoutID,undefined);
   await assert.rejects(runServicesCheckout(backend,config,'se_fixture',undefined,{resume:true,host:'plain-chat',persistHandoff:()=>{persisted++;}}),/current payable entry/);
   assert.equal(persisted,0);
  }
  assert.equal(presentationReads,0);assert.equal(paymentWrites,0);
  const checkout={checkout:{checkout_id:'chk_valid',cart_id:cart.cart_id,status:'payment_required',next_action:'none',amount_minor:500,currency:'CNY'},display_token:'fixture',checkout_url:'http://fixture/checkout/chk_valid',qr_payload:''};
  backend.createCheckout=async()=>checkout;backend.createServiceExecutionCheckout=async()=>({...serviceFacts,binding:{...serviceFacts.binding,checkout_id:checkout.checkout.checkout_id},cart,checkout});
  const session=new CartSession('CNY');let persisted='';
  await assert.rejects(runBuy(backend,config,{cartSession:session,cartID:cart.cart_id,host:'plain-chat',jsonOutput:true}),/fixture presentation unavailable/);
  assert.equal(session.show().lastCheckoutID,'chk_valid');
  await assert.rejects(runServicesCheckout(backend,config,'se_fixture',undefined,{resume:true,host:'plain-chat',persistHandoff:h=>{persisted=h.checkoutID;}}),/fixture presentation unavailable/);
  assert.equal(persisted,'chk_valid');assert.equal(paymentWrites,0);
 }finally{await mock.close();}
});
