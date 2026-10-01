import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BackendClient} from '../src/client/backend.js';
import {HttpClient} from '../src/client/http.js';
import {startMockBackend} from './mock_backend.js';
import {runServicesNext, runServicesPage, runServicesReadResult} from '../src/commands/services.js';
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

test('audit repair: transfer credentials stay in their plan and leg; single leg has booking entry', async()=>{
  const mock=await startMockBackend();
  try {
    const backend:BackendClient=Object.create(new BackendClient(new HttpClient({baseURL:mock.url})));
    const leg={train_code:'G_CHECK',travel_date:'2030-01-01',from_station:'甲站',to_station:'乙站',departure:'2030-01-01 09:00',arrival:'2030-01-01 10:00'};
    const journey={journey_id:'j_check',route_family_id:'rf_check',booking_support:'separate_legs_only' as const,qualification_status:'eligible' as const,rides:[leg,leg],ticket_plans:[{ticket_plan_ref:'tp_check',qualification_status:'eligible',legs:[leg,leg],ticket_offers:[0,1].map(leg_index=>({leg_index,ticket_plan_ref:'tp_check',passengers:2,seat_type:'O',seat_name:'二等座',booking_offer:{service_id:'itpay-rail-booking',selection_token:`rsel_check_${leg_index}`}}))}]};
    backend.getRailJourneyDetail=async()=>({service_execution_id:'se_check',plan_id:'p_check',snapshot_id:'s_check',query_revision:1,journey});
    let output='';await runServicesReadResult(backend,'se_check',{journey:'j_check',snapshot:'s_check',jsonOutput:true,output:s=>output+=s});
    const result=JSON.parse(output);for(const [index,row] of result.result.ticket_plans[0].legs.entries()){assert.equal(row.booking_template.input_example.selection.token,`rsel_check_${index}`);assert.equal(row.booking_template.input_example.passengers,2);assert.equal(row.booking_template.ticket_plan_ref,'tp_check');assert.equal(row.booking_template.leg_index,index);}
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
    backend.getServiceExecution=async()=>({...base,refunds:[],rail_booking:{message:'issued',state:'issued',issued_legs:0,legs:[]}});
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
