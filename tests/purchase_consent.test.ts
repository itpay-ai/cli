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
  assert.equal(JSON.parse(approved).next.command,'itpay cart add --quote q_fixture --json');
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
 assert.match(String(actions[1]?.command),/workflow:expand_search.*--input-json/);
 assert.doesNotMatch(JSON.stringify(actions),/curl|rm -rf/);
 assert.deepEqual(serviceInputTemplate({required:['count','priority'],properties:{count:{type:'integer',minimum:1,default:1},priority:{type:'string',enum:['fastest','cheapest']}}}),{count:'<count>',priority:'<priority>'});
});
