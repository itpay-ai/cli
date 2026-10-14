// Reproducible, synthetic engineering evidence; no real suppliers or payments.
import {writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {startMockBackend} from '../../../tests/mock_backend.ts';
import {BackendClient} from '../../../dist/src/client/backend.js';
import {HttpClient,HttpError} from '../../../dist/src/client/http.js';
import {loadConfig} from '../../../dist/src/state/config.js';
import {runServicesRun,runServicesNext,runServicesReadResult,runServicesCheckout} from '../../../dist/src/commands/services.js';
import {runSkillShow} from '../../../dist/src/commands/skill.js';
import {runInstall} from '../../../dist/src/commands/install.js';
import {CommandContractError,writeCommandEnvelope} from '../../../dist/src/commands/guidance.js';
const root=fileURLToPath(new URL('./outputs/',import.meta.url));mkdirSync(root,{recursive:true});
const mock=await startMockBackend();
try {
 const client=new BackendClient(new HttpClient({baseURL:mock.url}));const config=loadConfig({ITPAY_API_BASE_URL:mock.url});const base=await client.getServiceExecution('se_mock_next');
 const sizes={};
 async function capture(name,run){for(const jsonOutput of [true,false]){let output='';try{await run({jsonOutput,output:s=>output+=s});}catch(error){assert.ok(error instanceof CommandContractError);writeCommandEnvelope({status:'error',error:{code:error.code,message:error.message},...(error.result?{result:error.result}:{}),instruction:error.instruction,next:null,recovery:error.recovery,...(error.interaction?{interaction:error.interaction}:{})},{jsonOutput,output:s=>output+=s});}if(jsonOutput)JSON.parse(output);assert.ok(Buffer.byteLength(output)<32768,name);writeFileSync(`${root}/${name}.${jsonOutput?'json':'txt'}`,output);sizes[`${name}.${jsonOutput?'json':'txt'}`]=Buffer.byteLength(output);}}
 await capture('codex-skill',o=>runSkillShow('itpay',{...o,agentType:'codex-desktop'}));
 await capture('codex-cli-skill',o=>runSkillShow('itpay',{...o,agentType:'codex-cli'}));
 await capture('workbuddy-skill',o=>runSkillShow('itpay',{...o,agentType:'workbuddy'}));
 await capture('codex-install',o=>runInstall('codex-desktop',o));
 const linked=JSON.parse((await import('node:fs')).readFileSync(new URL('./review-db/related-purchase-error.json',import.meta.url),'utf8'));
 client.startServiceExecution=async()=>{throw new HttpError(409,linked,'expired');};
 await capture('related-purchase',o=>runServicesRun(client,config,'itpay-rail-booking',{passengers:1,selections:[{token:'rsel_alt_a',seat_type:'M'},{token:'rsel_alt_b',seat_type:'M'}]},o));
 const related=JSON.parse((await import('node:fs')).readFileSync(root+'/related-purchase.json','utf8'));assert.equal(related.interaction,undefined);assert.match(related.recovery[0].command,new RegExp(linked.selection_expiry.booking_execution_id));
 const query={endpoints:{origin:{kind:'area',text:'甲市某区'},destination:{kind:'place',text:'乙市已核验住宅'}},travel_date:'2030-10-01',passengers:2,priority:'fastest',arrive_before:'20:00'};
 for(const mode of ['fresh','existing','unknown','wrong-owner']){
 client.startServiceExecution=async()=>{throw new HttpError(409,mode==='wrong-owner'?{code:'selection_wrong_buyer',message:'selection belongs to another buyer'}:{code:'rail_selection_expired',message:'selection expired',...(mode==='unknown'?{}:{selection_expiry:{query_execution_id:'se_synthetic_query',query_service_id:'itpay-rail-smart',expired_at:'2030-10-01T00:00:00Z',query_input:query,safe_new_query:mode==='fresh',...(mode==='existing'?{booking_execution_id:'se_synthetic_purchase'}:{})}})},'expired');};
 await capture(`expiry-${mode}`,o=>runServicesRun(client,config,'itpay-rail-booking',{passengers:2,selections:[]},o));
 }
 const leg={train_code:'G_SYNTHETIC',from_station:'甲站',to_station:'乙站',departure:'2030-10-01 08:00',arrival:'2030-10-01 15:21'};
 const journey={journey_id:'j_synthetic',route_family_id:'rf_synthetic',qualification_status:'eligible',booking_support:'single_leg',passengers:2,rides:[leg],representative_metrics:{duration_basis:'rail',door_to_door_min:441,cost_basis:'rail_fare',estimated_total_cost:null},representative_offer:{offer_id:'o_synthetic',fare_minor:61900,service_fee_minor:400,rail_payable_minor:62300,currency:'CNY',ticket_offers:[{leg_index:0,seat_type:'O',seat_name:'二等座',passengers:2}]},booking_offer:{service_id:'itpay-rail-booking',selection_token:'rsel_synthetic'}};
 client.getRailJourneyDetail=async()=>({service_execution_id:'se_synthetic_query',plan_id:'p_synthetic',snapshot_id:'s_catalog',query_revision:1,journey});
 await capture('current-detail',o=>runServicesReadResult(client,'se_synthetic_query',{...o,snapshot:'s_catalog',journey:'j_synthetic'}));
 const currentDetail=client.getRailJourneyDetail;
 const wholeInput={passengers:2,selections:[{token:'rsel_synthetic_a',seat_type:'O'},{token:'rsel_synthetic_b',seat_type:'O'}]};
 const second={...leg,train_code:'D_SYNTHETIC',from_station:'乙站',to_station:'丙站',departure:'2030-10-01 16:00',arrival:'2030-10-01 17:00'};
 client.getRailJourneyDetail=async()=>({service_execution_id:'se_synthetic_query',plan_id:'p_synthetic',snapshot_id:'s_catalog',query_revision:1,journey:{...journey,booking_offer:undefined,booking_support:'journey',rides:[leg,second],ticket_plans:[{ticket_plan_ref:'tp_whole',qualification_status:'eligible',purchase_support:'journey',passenger_count:2,legs:[leg,second],booking_input:wholeInput}]}});
 await capture('whole-detail',o=>runServicesReadResult(client,'se_synthetic_query',{...o,snapshot:'s_catalog',journey:'j_synthetic'}));
 const whole=JSON.parse((await import('node:fs')).readFileSync(root+'/whole-detail.json','utf8'));assert.equal(whole.result.ticket_plans[0].booking_template.input_example.selections.length,2);

 client.getRailJourneyDetail=async()=>({service_execution_id:'se_synthetic_query',plan_id:'p_synthetic',snapshot_id:'s_historical',query_revision:1,journey:{...journey,booking_offer:undefined,booking_support:'separate_legs_only',ticket_plans:[{ticket_plan_ref:'tp_old',qualification_status:'eligible',purchase_support:'separate_legs_only',legs:[leg,leg],ticket_offers:[]}]}});
 await capture('historical-detail',o=>runServicesReadResult(client,'se_synthetic_query',{...o,snapshot:'s_historical',journey:'j_synthetic'}));client.getRailJourneyDetail=currentDetail;
 client.getServiceExecutionResultItemPage=async()=>({service_execution_id:'se_synthetic_query',plan_id:'p_synthetic',snapshot_id:'s_catalog',query_revision:1,page:{journey_page:{offset:0,limit:1,total:5,count:1,next_offset:1,qualification_counts:{eligible:5,ineligible:0,unknown:0}},journeys:[journey]}});
 await capture('saved-page',o=>runServicesReadResult(client,'se_synthetic_query',{...o,snapshot:'s_catalog',limit:1}));
 const saved=JSON.parse((await import('node:fs')).readFileSync(root+'/saved-page.json','utf8'));assert.equal(saved.result.total,5);assert.equal(saved.result.next_offset,1);assert.equal(saved.result.qualification_counts.eligible,5);
 for(const mode of ['paused','unchanged','ground-no-limit','ground-limit']){
 client.getServiceExecution=async()=>({...base,rail_planning:{readiness:'ready',snapshot_id:'s_recommend',catalog_snapshot_id:'s_catalog',query_input:mode==='ground-limit'?query:{...query,arrive_before:undefined},result_not_updated:mode==='unchanged',recommendation:mode.startsWith('ground')||mode==='unchanged'?undefined:journey,notices:mode==='paused'?[{code:'STANDING_LEG_PRESENT',scope:'query_candidates',message:'查询范围内其他候选含无座；当前推荐席别见方案。'}]:[],search:{expansion_status:mode.startsWith('ground')?'complete':'paused',reason:mode.startsWith('ground')?'ground_evidence_required':'direct_options_ready',counts:{journeys_total:8,journeys_eligible:5,journeys_direct:5,pairs_total:4,pairs_checked:2}}}});
 await capture(mode,o=>runServicesNext(client,'se_synthetic_query',o));
 }
 client.getServiceExecution=async()=>({...base,execution:{...base.execution,service_id:'itpay-rail-booking'},rail_booking:{state:'pending',issued_legs:0,message:'待付款',legs:[{leg_index:0,...leg,seat_name:'二等座',state:'pending',issued:false}]}});
 await capture('checkout',o=>runServicesCheckout(client,config,'se_mock_next','itpay_service',{...o,resume:true,host:'plain-chat',agentType:'workbuddy'}));
 writeFileSync(`${root}/sizes.json`,JSON.stringify(sizes,null,2)+'\n');console.log(`Read ${Object.keys(sizes).length} compiled text/JSON outputs; max ${Math.max(...Object.values(sizes))} bytes.`);
}finally{await mock.close();}
