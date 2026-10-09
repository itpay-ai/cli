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
  if(process.env.ITPAY_REWORK_MAIN){entry=join(work,'packed-entry.mjs');writeFileSync(entry,readFileSync(resolve('tests/cli_test_entry.ts'),'utf8').replace('await import("../src/main.js");',`await import(${JSON.stringify(process.env.ITPAY_REWORK_MAIN)});`));}
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
  await assert.rejects(runServicesRun(backend,loadConfig({}),'ordinary',{endpoints:{},review:{},search:{}}),error=>{assert(error instanceof HttpError);return true;});
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
