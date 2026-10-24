import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {BackendClient} from '../src/client/backend.js';
import {HttpClient} from '../src/client/http.js';
import {runCatalogList} from '../src/commands/catalog.js';
import type {CatalogManifest} from '../src/client/types.js';
import {serviceAdapter,errorServiceAdapter} from '../src/services/registry.js';
import {runServicesStart} from '../src/commands/services/lifecycle.js';
import {railServiceGuidance} from '../src/services/rail/guide.js';

test('actual PA3 public definition keeps current schemas and rejects unknown presentation contracts',()=>{
 const {definition}=JSON.parse(readFileSync(new URL('./fixtures/rail-public-v5.json',import.meta.url),'utf8'));
 for(const operation of definition.operations){
  const identity={service_id:operation.binding.service_id,service_contract_version_id:operation.binding.service_contract_version_id,public_binding:{public_service_id:definition.service_id,service_definition_version:definition.definition_version,adapter_key:definition.adapter_key,operation_id:operation.id}};
  const adapter=serviceAdapter(identity);
  assert.equal(adapter.supported,true);
  assert.equal(serviceAdapter({...identity,public_binding:{...identity.public_binding,service_definition_version:'scv_itpay_rail_public_v999'}}).supported,false);
  if(operation.id==='query_exact') assert.deepEqual(Object.keys(operation.input_schema.properties).sort(),['destination','origin','travel_date']);
  if(operation.id==='query_smart'){
   const known={endpoints:{origin:{kind:'station',text:'上海虹桥'},destination:{kind:'station',text:'杭州东'}},travel_date:'2030-10-09',arrive_after:'10:00',arrive_before:'12:00',depart_before:'11:00',passengers:2,seat_preferences:['O'],priority:'fastest',duration_basis:'rail',user_query:'保留全部条件'};
   const input=adapter.inputTemplate(operation.input_schema,known);
   for(const [field,value]of Object.entries(known))assert.deepEqual(input[field],value,field);
   const guidance=railServiceGuidance(identity.service_id,operation.input_schema);
   assert.deepEqual(adapter.guidance(identity.service_id,operation.input_schema),guidance);
   for(const field of ['arrive_after','arrive_before','depart_before','passengers','seat_preferences','duration_basis'])assert.ok(guidance?.optional_fields?.some(x=>x.name===field),field);
  }
  if(operation.id==='prepare_purchase'){
   assert.equal(operation.role,'purchase_preparation');
   for(const field of ['legs','passengers','selection_token','ticket_plan_ref'])assert.ok(operation.input_schema.properties[field],field);
   assert.ok(adapter.aftercare);
  }
 }
});

test('parent directory shows modes and dynamic purchase without internal products',async()=>{
 const path=process.env.ITPAY_PUBLICATION_FIXTURE ?? new URL('./fixtures/public-service-boundary.json',import.meta.url);
 const bundle=JSON.parse(readFileSync(path,'utf8'));
 const manifest=bundle.tables.catalog_manifests.find((r:{catalog_manifest_id:string})=>r.catalog_manifest_id===bundle.activate.catalog_manifest_id);
 const backend=new BackendClient(new HttpClient({baseURL:'http://127.0.0.1:1'}));
 backend.getCatalogManifest=async()=>({version:manifest.version,status:'published',item_count:manifest.manifest_json.items.length,manifest:manifest.manifest_json}) satisfies CatalogManifest;
 let json='',text='';await runCatalogList(backend,{jsonOutput:true,output:s=>json+=s});await runCatalogList(backend,{jsonOutput:false,output:s=>text+=s});
 const result=JSON.parse(json);
 assert.equal(result.result.services.filter((s:{service_id:string})=>s.service_id==='itpay-rail').length,1);
 assert.match(text,/火车票服务/);assert.match(text,/query_exact/);assert.match(text,/实时报价/);
 assert.doesNotMatch(text,/itpay-rail-booking|itpay-rail-smart|itpay-rail-exact/);
 let en='';await runCatalogList(backend,{jsonOutput:true,locale:'en',output:s=>en+=s});assert.match(en,/Rail tickets/);
 if(process.env.ITPAY_CATALOG_EVIDENCE)writeFileSync(process.env.ITPAY_CATALOG_EVIDENCE,JSON.stringify({scope:'real renderer with candidate publication; no deployment',text,json:result,english:JSON.parse(en)},null,2));
});

test('formal Skill keeps service orchestration and railway guide owns its business rules',()=>{
 const skill=readFileSync(new URL('../skills/itpay/SKILL.md',import.meta.url),'utf8');
 const rail=readFileSync(new URL('../docs/agent/buyer/rail-booking.json',import.meta.url),'utf8');
 assert.match(rail,/services start itpay-rail/);
 assert.match(skill,/services purchase --input-json/);
 assert.match(skill,/explicit human consent only when it covers those unchanged facts/);
 assert.doesNotMatch(skill,/older pinned contract|legacy lock repair|quote → approve → cart/);
 assert.doesNotMatch(skill,/Fastest means|Raw legs support|seat-request or whole-journey|no-seat option|reuse_from/);
 assert.match(rail,/stated scope/);
 assert.match(rail,/overnight/);
 assert.match(rail,/eligible complete ticket plan/);
 assert.match(rail,/reuse matching real consent/);
 assert.doesNotMatch(rail,/restore_old_execution|exceptional_branches|approve_purchase|confirm_booking/);
});


test('actual V4 dev definition opens overview and retains exact adapter boundaries',async()=>{
 const {definition}=JSON.parse(readFileSync(new URL('./fixtures/rail-public-v4-dev.json',import.meta.url),'utf8'));
 const backend=new BackendClient(new HttpClient({baseURL:'http://127.0.0.1:1'}));let starts=0;
 backend.startServiceExecution=async input=>{starts++;assert.equal(input.service_id,'itpay-rail');return {overview_only:true,service_definition:definition};};
 let output='';await runServicesStart(backend,'itpay-rail',{jsonOutput:true,output:s=>output+=s});
 const view=JSON.parse(output);assert.equal(starts,1);assert.equal(view.status,'service_overview');assert.equal(view.result.definition_version,'scv_itpay_rail_public_v5_v4_dev_20261024');
 assert.deepEqual(view.result.operations.map((op:{operation_id:string})=>op.operation_id),definition.operations.map((op:{id:string})=>op.id));
 for(const operation of definition.operations){
 const identity={service_id:operation.binding.service_id,service_contract_version_id:operation.binding.service_contract_version_id,public_binding:{public_service_id:definition.service_id,service_definition_version:definition.definition_version,adapter_key:definition.adapter_key,operation_id:operation.id}};
 assert.equal(serviceAdapter(identity).supported,true);
 for(const unknown of ['scv_itpay_rail_public_v5_v4_dev_20261025','scv_itpay_rail_public_v999'])assert.equal(serviceAdapter({...identity,public_binding:{...identity.public_binding,service_definition_version:unknown}}).supported,false);
 assert.equal(errorServiceAdapter({...identity,code:'input_invalid',message:'fixture'},'itpay-rail')?.supported,true);
 assert.equal(errorServiceAdapter({...identity,code:'input_invalid',message:'fixture'},'unrelated-service')?.supported,false);
 }
 const exact=view.result.operations.find((op:{operation_id:string})=>op.operation_id==='query_exact');assert.deepEqual(exact.input_schema,definition.operations.find((op:{id:string})=>op.id==='query_exact').input_schema);assert.ok(exact.input_template);
 const purchase=view.result.operations.find((op:{operation_id:string})=>op.operation_id==='prepare_purchase');assert.equal(purchase.requires_continuation,true);assert.match(purchase.instruction,/continuation/);
 assert.match(view.instruction,/尚未创建执行或查询/);assert.match(view.instruction,/rail-booking/);
});
