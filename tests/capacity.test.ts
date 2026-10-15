import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BackendClient} from '../src/client/backend.js';
import {HttpClient,HttpError} from '../src/client/http.js';
import {runServicesRun} from '../src/commands/services/lifecycle.js';
import {servicesNextEnvelope} from '../src/services/presentation.js';
import {serviceAdapterKey} from '../src/services/registry.js';
import type {CLIConfig} from '../src/state/config.js';
import type {ServiceExecutionReadModel} from '../src/client/types.js';
import {startMockBackend} from './mock_backend.js';

test('accepted capacity wait keeps one task and cannot be mistaken for empty trains',async()=>{
 const mock=await startMockBackend();
 try{
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const base=await backend.getServiceExecution('se_demo');
  const id=base.execution.service_execution_id;
  delete base.execution.public_binding;
  delete base.purchase_preparation;
  delete base.purchase_review;
  delete base.current_delivery;
  delete base.rail_planning;
  delete base.rail_booking;
  const model:ServiceExecutionReadModel={...base,
   execution:{...base.execution,service_id:'fixture-query',service_contract_version_id:'fixture-v1',status:'started'},
   current_result_items:[],payment_bindings:[],refunds:[],
   workflow:{status:'queued',current_step:'query',revision:1,steps:{}},
   scheduling:{accepted:true,state:'queued',execution_id:id,reason:'provider_capacity',retry_after_ms:1000}};
  const out=servicesNextEnvelope(model);
  assert.equal(out.status,'queued');assert.equal(out.result?.accepted,true);
  assert.equal(out.next?.command,`itpay services next ${id} --timeout 60 --json`);
  assert.doesNotMatch(JSON.stringify(out),/services run|没有直达|扩大|WorkBuddy.*占用/);
  const wrong=servicesNextEnvelope({...model,scheduling:{...model.scheduling!,execution_id:'another-task'}});
  assert.notEqual(wrong.status,'queued');
 }finally{await mock.close();}
});

test('unaccepted query has no invented read ID and preserves a complete original retry template',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'itpay-capacity-'));
 const backend=new BackendClient(new HttpClient({baseURL:'https://dev.itpay.ai'}));
 let sends=0,output='';
 backend.startServiceExecution=async()=>{sends++;throw new HttpError(429,{code:'query_capacity_not_accepted',message:'capacity full',accepted:false,reason:'query_capacity_full',retry_after_ms:1000},'capacity full');};
 backend.getServiceExecution=async()=>{throw new Error('must not read a nonexistent execution');};
 const original=process.stdout.write;
 process.stdout.write=(chunk)=>{output+=String(chunk);return true;};
 const input={endpoints:{origin:{text:'武汉站',type:'station'},destination:{text:'从江站',type:'station'}},travel_date:'2030-10-09',passengers:1};
 const config:CLIConfig={baseURL:'https://dev.itpay.ai',environment:'development',checkoutCurrency:'CNY',idempotencyKey:'fixture',ideImageAttach:false};
 try{
  await runServicesRun(backend,config,'itpay-rail',input,{operationID:'query_smart',jsonOutput:true,env:{...process.env,ITPAY_CLI_HOME:directory}});
 }finally{process.stdout.write=original;rmSync(directory,{recursive:true,force:true});}
 const out=JSON.parse(output);
 assert.equal(sends,1);assert.equal(out.status,'not_accepted');assert.equal(out.result.accepted,false);
 assert.equal(out.next,null);assert.equal(out.result.service_execution_id,undefined);
 assert.doesNotMatch(output,/services get|services next/);
 assert.match(out.interaction.input_template.command,/--operation query_smart/);
 assert.deepEqual(out.interaction.input_template.file_content,{input});
});

test('capacity publication uses explicit registered rail identities only',()=>{
 assert.equal(serviceAdapterKey({service_id:'itpay-rail-smart',service_contract_version_id:'scv_itpay_rail_smart_v6_capacity_20261015'}),'rail.v1');
 assert.equal(serviceAdapterKey({service_id:'itpay-rail-smart',service_contract_version_id:'scv_itpay_rail_smart_fake_capacity'}),'unsupported');
 assert.equal(serviceAdapterKey({service_id:'fixture',service_contract_version_id:'generic'}),'schema.v1');
});

test('accepted scheduling controls both command waits and the final same-execution action',async()=>{
 const {runServicesNext}=await import('../src/commands/services/lifecycle.js');
 const mock=await startMockBackend();
 const directory=mkdtempSync(join(tmpdir(),'itpay-capacity-delay-'));
 const original=process.stdout.write;
 let output='';
 try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const base=await backend.getServiceExecution('se_demo');
  const id=base.execution.service_execution_id;
  delete base.execution.public_binding;delete base.purchase_preparation;delete base.purchase_review;
  delete base.current_delivery;delete base.rail_planning;delete base.rail_booking;
  const queued:ServiceExecutionReadModel={...base,
   execution:{...base.execution,service_id:'fixture-query',service_contract_version_id:'fixture-v1',status:'started'},
   current_result_items:[],payment_bindings:[],refunds:[],
   workflow:{status:'queued',current_step:'query',revision:1,steps:{}},
   scheduling:{accepted:true,state:'queued',execution_id:id,reason:'provider_capacity',retry_after_ms:8000}};
  queued.workflow_entry={capability_id:'fixture',input_schema:{}};
  const done:ServiceExecutionReadModel={...queued,execution:{...queued.execution,status:'completed'},};
  delete done.workflow;delete done.scheduling;
  process.stdout.write=(chunk)=>{output+=String(chunk);return true;};
  const env={...process.env,ITPAY_CLI_HOME:directory};
  await runServicesNext(backend,id,{initialModel:queued,timeoutSeconds:0,jsonOutput:true,env});
  assert.equal(JSON.parse(output).next.poll_after_ms,8000);
  for(const command of ['next','run']) {
   output='';let reads=0;const delays:number[]=[];
   backend.getServiceExecution=async()=>{reads++;return command==='run'&&reads===1?queued:done;};
   const options={timeoutSeconds:10,jsonOutput:true,env,pollIntervalMS:1500,sleep:async(ms:number)=>{delays.push(ms);}};
   if(command==='next') await runServicesNext(backend,id,{...options,initialModel:queued});
   else await runServicesRun(backend,{baseURL:mock.url,environment:'development',checkoutCurrency:'CNY',idempotencyKey:'fixture',ideImageAttach:false},'fixture-query',undefined,{...options,executionID:id});
   assert.deepEqual(delays,[8000]);
  }
 } finally {process.stdout.write=original;rmSync(directory,{recursive:true,force:true});await mock.close();}
});

test('rejected input on an existing execution retains that execution in its retry template',async()=>{
 const mock=await startMockBackend();
 const directory=mkdtempSync(join(tmpdir(),'itpay-capacity-resume-'));
 const original=process.stdout.write;let output='';
 try {
  const backend=new BackendClient(new HttpClient({baseURL:mock.url}));
  const base=await backend.getServiceExecution('se_demo');
  const id=base.execution.service_execution_id;
  delete base.execution.public_binding;
  base.execution.service_id='fixture-query';base.execution.service_contract_version_id='fixture-v1';base.execution.status='started';
  base.workflow={status:'running',current_step:'query',revision:1,steps:{}};
  base.workflow_entry={capability_id:'fixture',input_schema:{}};
  backend.getServiceExecution=async()=>base;
  backend.startServiceExecution=async()=>{throw new Error('must not create an execution');};
  backend.advanceServiceExecution=async()=>{throw new HttpError(429,{code:'query_capacity_not_accepted',message:'capacity full',accepted:false,reason:'query_capacity_full',retry_after_ms:8000},'capacity full');};
  process.stdout.write=(chunk)=>{output+=String(chunk);return true;};
  const input={query:'original'};
  await runServicesRun(backend,{baseURL:mock.url,environment:'development',checkoutCurrency:'CNY',idempotencyKey:'fixture',ideImageAttach:false},'fixture-query',input,{executionID:id,jsonOutput:true,env:{...process.env,ITPAY_CLI_HOME:directory}});
  const out=JSON.parse(output);
  assert.equal(out.result.execution_created,true);assert.equal(out.result.service_execution_id,id);
  assert.ok(out.interaction.input_template.command.includes(`--execution ${id}`));
  assert.deepEqual(out.interaction.input_template.file_content,input);
 }finally{process.stdout.write=original;rmSync(directory,{recursive:true,force:true});await mock.close();}
});
