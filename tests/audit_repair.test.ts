import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BackendClient} from '../src/client/backend.js';
import {loadConfig} from '../src/state/config.js';
import {CommandContractError} from '../src/commands/guidance.js';
import {HttpError, HttpClient} from '../src/client/http.js';
import {startMockBackend} from './mock_backend.js';
import {runServicesCheckout, runServicesNext, runServicesPage, runServicesReadResult, runServicesStart, runServicesRun} from '../src/commands/services.js';
import {runOrder} from '../src/commands/order.js';
import {runGetRefund} from '../src/commands/refund.js';

test('audit repair: saved geo reason, empty candidates and real choices', async () => {
  const mock = await startMockBackend();
  try {
    const backend = new BackendClient(new HttpClient({baseURL:mock.url}));
    const client: BackendClient = Object.create(backend);
    const base = await backend.getServiceExecution('se_mock_next');
    for (const reason of ['address_required', 'station_location_evidence_required', 'coordinate_identity_unverified', 'amap_request_failed']) {
      client.getServiceExecution = async () => ({...base, workflow_entry:{capability_id:"itpay_service",input_schema:{}}, workflow:{current_step:'failure',revision:1,steps:{},status:'failed', error_code:'condition_unmet', failure:{step_id:'resolved_after_confirm', source_step:'geo_confirm', reason_code:reason, endpoint:'destination'}}});
      let output=''; await runServicesNext(client,'se_check',{jsonOutput:true,output:s=>output+=s});
      const result=JSON.parse(output);
      assert.equal(result.result.reason,reason); assert.equal(result.result.affected_endpoint,'destination'); assert.equal(result.next,null);
      if(reason==='address_required') assert.equal(result.result.new_query_template.executable,false);
      else assert.doesNotMatch(result.instruction,/补.*地址|换站查询/);
    }
    for (const candidates of [[], [{id:'poi_real',poi_name:'乙地点',formatted_address:'乙市某区'}]]) {
      client.getServiceExecution=async()=>({...base,workflow_entry:{capability_id:"itpay_service",input_schema:{}},workflow:{current_step:'confirm_location',revision:1,steps:{},status:'human_action',human_action:{action_type:'workflow:confirm_location',input_schema:{required:['choices']},context:{places:{origin:{resolution_status:'resolved',query:'甲市'},destination:{resolution_status:'needs_confirmation',resolution_reason:'ADDRESS_REQUIRED',query:'乙地',resolution_candidates:candidates}}}}}});
      let output='';await runServicesNext(client,'se_check',{jsonOutput:true,output:s=>output+=s});const result=JSON.parse(output);
      if(!candidates.length) assert.equal(result.interaction,undefined);
      else {assert.match(result.interaction.input_template.command,/--input-json/); assert.doesNotMatch(result.instruction,/地址及 id/);assert.equal(result.interaction.input_template.input.choices.destination,'<所选候选id>');}
    }
  } finally {await mock.close();}
});

test('journey harness: one plan has one whole booking entry; single leg stays compatible', async()=>{
  const mock=await startMockBackend();
  try {
    const backend:BackendClient=Object.create(new BackendClient(new HttpClient({baseURL:mock.url})));
    const leg={train_code:'G_CHECK',travel_date:'2030-01-01',from_station:'甲站',to_station:'乙站',departure:'2030-01-01 09:00',arrival:'2030-01-01 10:00'};
    const secondLeg={...leg,train_code:'D_CHECK',from_station:'乙站',to_station:'丙站',departure:'2030-01-01 11:00',arrival:'2030-01-01 12:00'};
    const journey={journey_id:'j_check',route_family_id:'rf_check',booking_support:'separate_legs_only' as const,qualification_status:'eligible' as const,rides:[leg,secondLeg],ticket_plans:[{ticket_plan_ref:'tp_check',qualification_status:'eligible',booking_input:{selections:[{token:'rsel_check_0',seat_type:'O'},{token:'rsel_check_1',seat_type:'O'}],passengers:2},legs:[leg,secondLeg],ticket_offers:[0,1].map(leg_index=>({leg_index,ticket_plan_ref:'tp_check',passengers:2,seat_type:'O',seat_name:'二等座',booking_offer:{service_id:'itpay-rail-booking',selection_token:`rsel_check_${leg_index}`}}))}]};
    backend.getRailJourneyDetail=async()=>({service_execution_id:'se_check',plan_id:'p_check',snapshot_id:'s_check',query_revision:1,journey});
    let output='';await runServicesReadResult(backend,'se_check',{journey:'j_check',snapshot:'s_check',jsonOutput:true,output:s=>output+=s});
    const result=JSON.parse(output);const plan=result.result.ticket_plans[0];assert.deepEqual(plan.booking_template.input_example,{selections:[{token:'rsel_check_0',seat_type:'O'},{token:'rsel_check_1',seat_type:'O'}],passengers:2});for(const row of plan.legs){assert.equal(row.booking_template,undefined);}
    backend.getRailJourneyDetail=async()=>({service_execution_id:'se_check',plan_id:'p_check',snapshot_id:'s_check',query_revision:1,journey:{...journey,booking_support:'single_leg',booking_offer:{service_id:'itpay-rail-booking',selection_token:'rsel_single'},passengers:2}});
    output='';await runServicesReadResult(backend,'se_check',{journey:'j_check',snapshot:'s_check',jsonOutput:true,output:s=>output+=s});assert.equal(JSON.parse(output).result.journey.booking_template.input_example.selection.token,'rsel_single');
  }finally{await mock.close();}
});

test('audit repair: refund reader facts agree across siblings, issued stops',async()=>{
  const mock=await startMockBackend();
  try{
    const backend:BackendClient=Object.create(new BackendClient(new HttpClient({baseURL:mock.url})));
    const base=await backend.getServiceExecution('se_mock_next');
    const original=await backend.getRefund('rr_locked');
    for(const state of ['succeeded','failed','cancelled','rejected','accepted'] as const){
      const refund={...original,status:state,access_locked:true,...(state==='failed'?{failure_class:'outcome_unknown' as const}:{})};
      backend.getRefund=async()=>refund;backend.listOrderRefunds=async()=>({refunds:[refund]});backend.getServiceExecution=async()=>({...base,refunds:[refund]});
      const responses=[];for(const run of [(output:(s:string)=>void)=>runGetRefund(backend,'rr_locked',{jsonOutput:true,output}),(output:(s:string)=>void)=>runOrder(backend,'ord_pending',{jsonOutput:true,output}),(output:(s:string)=>void)=>runServicesNext(backend,'se_check',{jsonOutput:true,output})]){let text='';await run(s=>text+=s);responses.push(JSON.parse(text));}
      assert.equal(responses[0].instruction,responses[1].instruction);assert.equal(responses[0].instruction,responses[2].instruction);if(state!=='accepted') assert.equal(responses[2].next,null);
    }
    backend.getServiceExecution=async()=>({...base,refunds:[],rail_booking:{message:'issued',state:'issued',issued_legs:1,legs:[{leg_index:0,state:'issued',issued:true}]}});
    let output='';await runServicesNext(backend,'se_check',{jsonOutput:true,output:s=>output+=s});assert.equal(JSON.parse(output).next,null);
  }finally{await mock.close();}
});

test('audit repair: Exact page rows keep stable details at every offset',async()=>{
  const mock=await startMockBackend();
  try{
    const backend:BackendClient=Object.create(new BackendClient(new HttpClient({baseURL:mock.url})));
    backend.getServiceExecutionResultItemPage=async(_id,_item,offset,limit)=>({service_execution_id:'se_check',service_capability_result_item_id:'sri_check',capability_id:'rail_search',page:{candidates:Array.from({length:Math.min(limit,124-offset)},(_,i)=>({train_code:`G${offset+i}`,seats:[]})),catalog_page:{offset,limit,total:124,count:Math.min(limit,124-offset),next_offset:offset+limit<124?offset+limit:null}}});
    for(const offset of [0,100,122]){let output='';await runServicesPage(backend,'se_check','sri_check',{offset,limit:2,jsonOutput:true,output:s=>output+=s});const result=JSON.parse(output);for(const [i,row]of result.result.candidates.entries())assert.match(row.detail.command,new RegExp(`--offset ${offset+i} --limit 1`));assert.equal(result.result.total,124);}
  }finally{await mock.close();}
});


test('journey harness: current template and structural repair preserve query before provider', async () => {
 const mock=await startMockBackend();
 try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const base=await backend.getServiceExecution('se_mock_next');
  const schema={type:'object',required:['endpoints','travel_date'],properties:{endpoints:{type:'object',required:['origin','destination'],properties:{origin:{type:'object',required:['text'],properties:{text:{type:'string'}}},destination:{type:'object',required:['text'],properties:{text:{type:'string'}}}}},travel_date:{type:'string'},passengers:{type:'integer'}}};
  backend.startServiceExecution=async()=>({execution:{...base.execution,service_id:'itpay-rail-smart'},capabilities:base.capabilities,workflow_entry:{capability_id:'itpay_service',input_schema:schema}});
  let output='';await runServicesStart(backend,'itpay-rail-smart',{jsonOutput:true,output:s=>output+=s});
  const entry=JSON.parse(output);assert.equal(typeof entry.interaction.input_template.input.endpoints.origin.text,'string');assert.equal(entry.interaction.input_template.executable,false);
  backend.startServiceExecution=async()=>{throw new HttpError(400,{code:'capability_input_invalid',message:'$.endpoints is required',input_schema:schema,input_errors:['$.endpoints is required'],execution_created:false,provider_called:false},'invalid');};
  await assert.rejects(runServicesRun(backend,loadConfig({}),'itpay-rail-smart',{origin:'甲区域',destination:'乙住宅',travel_date:'2030-10-01',passengers:2}),error=>{
   assert.ok(error instanceof CommandContractError); const e=error;
   assert.equal(e.result?.execution_created,false);assert.equal(e.interaction?.input_template?.input?.travel_date,'2030-10-01');
   const corrected=e.interaction?.input_template?.input?.endpoints as {origin:{text:string};destination:{text:string}};
   assert.equal(corrected.origin.text,'甲区域');assert.equal(corrected.destination.text,'乙住宅');assert.equal(e.result?.provider_called,false);assert.doesNotMatch(e.interaction!.input_template!.command,/--execution/);return true;
  });
  backend.startServiceExecution=async()=>{throw new HttpError(400,{code:'capability_input_invalid',message:'invalid input',input_schema:schema,execution_created:true,service_execution_id:'se_existing'},'invalid');};
  await assert.rejects(runServicesRun(backend,loadConfig({}),'itpay-rail-smart',{travel_date:'2030-10-01'}),error=>{
   assert.ok(error instanceof CommandContractError);assert.equal(error.result?.service_execution_id,'se_existing');assert.match(error.interaction!.input_template!.command,/--execution se_existing/);assert.equal(error.result?.provider_called,undefined);return true;
  });
 } finally {await mock.close();}
});


test('journey harness: endpoint recovery keeps area/place/station and untouched constraints',async()=>{
 const mock=await startMockBackend();try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));const base=await backend.getServiceExecution('se_mock_next');
  for(const [origin,destination] of [['area','place'],['place','area'],['station','station']]) {
   const query={endpoints:{origin:{kind:origin,text:'甲原意'},destination:{kind:destination,text:'乙原意'}},travel_date:'2030-10-01',passengers:2};
   backend.getServiceExecution=async()=>({...base,workflow_entry:{capability_id:'itpay_service',input_schema:{type:'object',required:['endpoints','travel_date'],properties:{endpoints:{type:'object',required:['origin','destination'],properties:{origin:{type:'object',required:['text'],properties:{text:{type:'string'},kind:{type:'string'}}},destination:{type:'object',required:['text'],properties:{text:{type:'string'},kind:{type:'string'}}}}},travel_date:{type:'string'},passengers:{type:'integer'}}}},workflow:{query_input:query,status:'failed',current_step:'geo',revision:1,steps:{},failure:{step_id:'resolved',reason_code:'address_required',endpoint:'destination'}}});
   let output='';await runServicesNext(backend,'se_mock_next',{jsonOutput:true,output:s=>output+=s});const result=JSON.parse(output);
   assert.deepEqual(result.result.query,query);assert.deepEqual(result.result.new_query_template.input.endpoints.origin,query.endpoints.origin);assert.equal(result.result.new_query_template.input.endpoints.destination.kind,destination);assert.notEqual(result.result.new_query_template.input.endpoints.destination.text,query.endpoints.destination.text);assert.equal(result.result.new_query_template.input.travel_date,query.travel_date);assert.equal(result.result.new_query_template.input.passengers,query.passengers);assert.doesNotMatch(result.instruction,/最近站/);
  }
 }finally{await mock.close();}
});

test('journey harness: review template is complete and carries no invented consent', async()=>{
 const mock=await startMockBackend();try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));const base=await backend.getServiceExecution('se_mock_next');
  const input={draft_revision:1,notice_version:'rail-seat-request.v1',passengers:2,seat_type:'O',seat_preferences:[{passenger_index:0,preference:'auto'},{passenger_index:1,preference:'window'}],party_preference:'together_if_possible',fallback:'automatic_assignment',accept_non_guaranteed:false};
  backend.getServiceExecution=async()=>({...base,execution:{...base.execution,service_id:'itpay-rail-booking'},workflow_entry:{capability_id:'itpay_service',input_schema:{}},workflow:{status:'human_action',current_step:'booking_review',revision:1,steps:{},human_action:{action_type:'workflow:booking_review',input_schema:{required:Object.keys(input)},context:{review:{...input,input_template:input}}}}});
  let output='';await runServicesNext(backend,'se_mock_next',{jsonOutput:true,output:s=>output+=s});const result=JSON.parse(output);
  assert.deepEqual(result.interaction.input_template.input,input);assert.match(result.instruction,/已有明确确认/);assert.equal(result.next,null);
 }finally{await mock.close();}
});

test('journey harness: failed second quote never offers payment or a replacement purchase',async()=>{
 const mock=await startMockBackend();try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));const base=await backend.getServiceExecution('se_mock_next');
  backend.getServiceExecution=async()=>({...base,execution:{...base.execution,service_id:'itpay-rail-booking'},workflow_entry:{capability_id:'itpay_service',input_schema:{}},workflow:{status:'failed',current_step:'refresh_quote',revision:1,steps:{},failure:{step_id:'refresh_quote',reason_code:'quote_seat_unavailable',affected_leg:1}}});
  let output='';await runServicesNext(backend,'se_mock_next',{jsonOutput:true,output:s=>output+=s});const result=JSON.parse(output);assert.equal(result.next,null);assert.equal(result.result.failure.affected_leg,1);assert.match(result.instruction,/第2段/);assert.match(result.instruction,/没有付款入口/);
 }finally{await mock.close();}
});


test('journey harness: one official checkout carries all leg facts',async()=>{
 const mock=await startMockBackend();try{
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));const base=await backend.getServiceExecution('se_mock_next');
  const legs=[{leg_index:0,train_code:'G1',from:'甲站',to:'乙站',travel_date:'2030-10-01',departure:'23:00',arrival:'00:00',arrival_days:1,state:'pending',issued:false,seat_name:'二等座'},{leg_index:1,train_code:'D2',from:'乙站',to:'丙站',travel_date:'2030-10-02',departure:'01:00',arrival:'02:00',arrival_days:0,state:'pending',issued:false,seat_name:'二等座'}];
  backend.getServiceExecution=async()=>({...base,execution:{...base.execution,service_id:'itpay-rail-booking'},rail_booking:{state:'pending',issued_legs:0,message:'待付款',legs}});
  let writes=0;const create=backend.createServiceExecutionCheckout.bind(backend);backend.createServiceExecutionCheckout=async(...args)=>{writes++;const result=await create(...args);result.checkout.checkout.amount_minor=12400;result.cart.items=result.cart.items.map(item=>({...item,amount_minor:12400}));return result;};
  for(const jsonOutput of [true,false]){
   let output='';await runServicesCheckout(backend,loadConfig({ITPAY_API_BASE_URL:mock.url}),'se_mock_next','itpay_service',{resume:true,host:'plain-chat',agentType:'workbuddy',jsonOutput,output:s=>output+=s});
   assert.match(output,/G1/);assert.match(output,/D2/);assert.match(output,/一次付款/);
   if(jsonOutput){const value=JSON.parse(output);assert.equal(value.result.itinerary.legs.length,2);assert.equal(value.result.itinerary.purchase_unit,'journey');assert.equal(value.handoff.agent_action.arguments.files.length,1);}
   if(process.env.ITPAY_EVIDENCE_DIR){const {writeFileSync}=await import('node:fs');writeFileSync(`${process.env.ITPAY_EVIDENCE_DIR}/k710-checkout.${jsonOutput?'json':'txt'}`,output);}
  }assert.equal(writes,2);
 }finally{await mock.close();}
});

test('journey repair: raw multi-leg rejection points to saved complete plan',async()=>{
 const mock=await startMockBackend();try{
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  for(const code of ['rail_journey_selection_required','rail_selection_expired']) {
   backend.startServiceExecution=async()=>{throw new HttpError(400,{code,message:'complete saved plan required'},'invalid');};
   await assert.rejects(runServicesRun(backend,loadConfig({}),'itpay-rail-booking',{legs:[{seat_type:'O'},{seat_type:'O'}]}),error=>{
    assert.ok(error instanceof CommandContractError);assert.equal(error.code,code);assert.match(error.instruction,/手填 legs 只兼容单腿/);assert.ok(error.recovery.some(item=>item.command==='itpay services list --json'));return true;
   });
  }
 }finally{await mock.close();}
});

test('journey repair: station coordinate system gap only offers Exact for complete locked station pair',async()=>{
 const mock=await startMockBackend();try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));const base=await backend.getServiceExecution('se_mock_next');
  for(const kind of ['station','place']) {
   const query={endpoints:{origin:{kind:'station',text:'甲站',station_code:'AAA'},destination:{kind,text:'乙站',station_code:'BBB'}},travel_date:'2030-10-01',passengers:2,arrive_by:'20:00'};
   backend.getServiceExecution=async()=>({...base,execution:{...base.execution,service_id:'itpay-rail-smart'},workflow_entry:{capability_id:'itpay_service',input_schema:{}},workflow:{query_input:query,status:'failed',current_step:'geo',revision:1,steps:{},failure:{step_id:'resolved',reason_code:'station_location_evidence_required',endpoint:'destination'}}});
   let output='';await runServicesNext(backend,'se_mock_next',{jsonOutput:true,output:s=>output+=s});const value=JSON.parse(output);
   assert.equal(value.status,'system_evidence_required');assert.deepEqual(value.result.query,query);
   if(kind==='station') {assert.deepEqual(value.result.new_query_template.input,{origin:'甲站',destination:'乙站',travel_date:'2030-10-01'});assert.match(value.result.new_query_template.command,/itpay-rail-exact/);}
   else {assert.equal(value.result.new_query_template,undefined);assert.match(value.instruction,/当前无可执行恢复/);}
  }
 }finally{await mock.close();}
});

test('local repair: selection errors distinguish input from server inconsistency without invented execution',async()=>{
 const mock=await startMockBackend();try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  for(const reason of ['input_constraint_invalid','stored_selection_inconsistent']) {
   backend.startServiceExecution=async()=>{throw new HttpError(400,{code:'invalid_selection',reason,message:reason},'invalid');};
   await assert.rejects(runServicesRun(backend,loadConfig({}),'itpay-rail-booking',{passengers:1,selections:[]}),error=>{
    assert.ok(error instanceof CommandContractError);assert.equal(error.result?.execution_created,false);assert.equal(error.result?.service_execution_id,undefined);
    if(reason==='stored_selection_inconsistent'){assert.equal(error.recovery.length,0);assert.match(error.instruction,/补参数无法修复/);}else assert.ok(error.recovery.length>0);
    assert.doesNotMatch(error.instruction,/补齐参数|ticket_plan_ref|snapshot_id|journey_ref/);return true;
   });
  }
 }finally{await mock.close();}
});

test('local repair: trusted local mode changes handoff, URL text alone does not',async()=>{
 const {buildCheckoutHandoff}=await import('../src/commands/checkout_handoff.js');
 const {buildCheckoutQRPlan}=await import('../src/commands/buy.js');
 const url='http://127.0.0.1:15173/checkout/test?display_token=synthetic&complete_exchange_token=synthetic';
 for(const localSimulation of [false,true]) {
  const plan=buildCheckoutQRPlan({host:'plain-chat',checkoutID:'test',checkoutURL:url,displayToken:'synthetic',qrPayload:url,nextAction:'select_payment',localSimulation});
  const out=buildCheckoutHandoff({platform:'plain_chat',url,mobileUrl:url,amount:'¥12.00',plan,agentType:'workbuddy'});
  if(localSimulation){assert.match(out.instruction,/在本机打开/);assert.doesNotMatch(out.instruction,/手机端点开|直接跳转支付宝/);assert.equal(out.handoff.mobile_url,undefined);assert.equal(out.handoff.environment,'local_simulation');}
  else {assert.match(out.instruction,/手机端点开/);assert.equal(out.handoff.environment,undefined);}
 }
});

test('local repair: checkout itinerary uses the same quoted names as Web',async()=>{
 const mock=await startMockBackend();try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));const base=await backend.getServiceExecution('se_mock_next');const presentation=await backend.getCheckoutPresentation('chk_mock','synthetic');
  backend.getServiceExecution=async()=>({...base,execution:{...base.execution,service_id:'itpay-rail-booking'}});
  backend.getCheckoutPresentation=async()=>({...presentation,rail_quote:{amount_minor:10000,currency:'CNY',expires_at:'2030-10-01T12:00:00Z',passengers:1,legs:[{arrival_days:0,train_code:'G1',travel_date:'2030-10-01',from:'宁波',to:'郑州东',departure:'09:00',arrival:'15:00',seat_name:'二等座',unit_fare_minor:10000,fare_minor:10000,service_fee_minor:0}]}});
  for(const jsonOutput of [false,true]) {
   let output='';await runServicesCheckout(backend,loadConfig({ITPAY_API_BASE_URL:mock.url}),'se_mock_next','itpay_service',{resume:true,host:'plain-chat',jsonOutput,output:s=>output+=s});
   assert.match(output,/宁波/);assert.match(output,/郑州东/);assert.match(output,/二等座/);
   if(process.env.ITPAY_EVIDENCE_DIR){const {writeFileSync}=await import('node:fs');writeFileSync(`${process.env.ITPAY_EVIDENCE_DIR}/n905-names.${jsonOutput?'json':'txt'}`,output);}
  }
 }finally{await mock.close();}
});
