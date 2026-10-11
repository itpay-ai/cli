import {writeFileSync} from 'node:fs';
import {BackendClient} from '../src/client/backend.js';
import {HttpClient} from '../src/client/http.js';
import {startMockBackend} from './mock_backend.js';
import {runServicesNext} from '../src/commands/services.js';
const mock=await startMockBackend();
const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
const base=await backend.getServiceExecution('se_mock_next');
const samples=[];
const railBinding={public_service_id:"itpay-rail",service_definition_version:"scv_itpay_rail_public_v1",operation_id:"query_smart",adapter_key:"rail.v1"};
try {
 for(const [name,changes] of Object.entries({
  query_only:{},
  exact_to_smart:{current_result_items:[{service_capability_result_item_id:'sri_exact',rank:0,safe_payload:{result:{candidates:[],catalog_total:0,resolved_station_pair:{origin_name:'甲站',origin_code:'AAA',destination_name:'乙站',destination_code:'BBB',travel_date:'2030-10-08'}}}}],execution:{...base.execution,service_id:'itpay-rail-exact',service_contract_version_id:'scv_itpay_rail_exact_v1',public_binding:railBinding},workflow:{current_step:'done',status:'completed',revision:1,steps:{rail_search:{output:{candidates:[],catalog_total:0}}}}},
  location_recovery:{execution:{...base.execution,service_id:'itpay-rail-smart',service_contract_version_id:'scv_itpay_rail_smart_v6',public_binding:railBinding},workflow:{current_step:'failure',status:'failed',revision:1,steps:{},failure:{source_step:'geo_confirm',reason_code:'amap_request_failed',endpoint:'destination'}}},
  whole_journey_review:{execution:{...base.execution,service_id:'itpay-rail-booking',service_contract_version_id:'scv_itpay_rail_booking_v4',public_binding:{...railBinding,operation_id:'prepare_purchase'}},workflow:{current_step:'booking_review',status:'human_action',revision:1,steps:{},human_action:{action_type:'workflow:booking_review',input_schema:{required:['draft_revision','notice_version','accept_non_guaranteed'],properties:{draft_revision:{type:'integer'},notice_version:{type:'string'},accept_non_guaranteed:{type:'boolean'}}},context:{review:{draft_revision:1,notice_version:'rail-booking-v4',legs:[{train_code:'G_fixture',from_station:'甲站',to_station:'乙站',seat_type:'O'}]}}}}},
  quote_recovery:{execution:{...base.execution,service_id:'itpay-rail-booking',service_contract_version_id:'scv_itpay_rail_booking_v4',public_binding:{...railBinding,operation_id:'prepare_purchase'}},workflow:{current_step:'failure',status:'failed',revision:1,steps:{},failure:{source_step:'booking_quote',reason_code:'insufficient_inventory'}}},
  payment_unknown:{execution:{...base.execution,status:'payment_pending',phase:'purchase'},workflow:{status:'payment',current_step:'pay',revision:1,steps:{}},checkout_bindings:[{checkout_id:'chk_fixture'}],payment_bindings:[{status:'pending',checkout_id:'chk_fixture'}]},
  company_candidate:{workflow_entry:undefined,allowed_actions:[{type:'select_candidate',requires_human:true}]},
  seller_paid:{workflow_entry:undefined,allowed_actions:[{type:'prepare_quote',capability_id:'company_report',requires_human:true}],execution:{...base.execution,service_id:'seller-fixture'},current_result_items:[],result_items:[]}
 })) {
  const client=Object.create(backend);let reads=0;client.getServiceExecution=async()=>{reads++;return {...base,execution_requests:[],workflow_entry:{capability_id:"itpay_service",input_schema:{}},...changes};};
  const render=(jsonOutput:boolean,output:(s:string)=>void)=>name==='query_only' ? runServicesNext(backend,'se_rail_plan_complete',{jsonOutput,output}) : runServicesNext(client,'se_fixture',{jsonOutput,output});
  let json='';await render(true,s=>json+=s);
  let text='';await render(false,s=>text+=s);
  samples.push({name,fixture:changes,json:JSON.parse(json),text,bytes:Buffer.byteLength(json),calls_per_render:reads/2});
 }
 writeFileSync(process.argv[2]!,JSON.stringify({scope:'real CLI rendering with isolated synthetic Backend facts; not natural UX',samples},null,2));
}finally {await mock.close();}
