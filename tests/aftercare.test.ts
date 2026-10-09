import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BackendClient} from '../src/client/backend.js';
import {HttpClient} from '../src/client/http.js';
import {loadConfig} from '../src/state/config.js';
import type {RailAftercareView,RailAftercareDirectory} from '../src/client/types.js';
import {railAftercareEnvelope,railAftercareList,railAftercareCreate,railAftercareRespond} from '../src/services/rail/aftercare.js';
import {runAftercareList,runAftercareGet,runAftercareCreate,runAftercareRespond} from '../src/commands/aftercare.js';
import {CommandContractError} from '../src/services/shared/envelope.js';
const view:RailAftercareView={can_cancel:true,execution_identity:{service_id:'itpay-rail-booking',service_contract_version_id:'scv_itpay_rail_booking_v4'},case:{case_id:'case_test',order_id:'order_test',status:'requested',revision:1,request:{operation:'refund',targets:[{leg_index:1,passenger_index:0}],reason:'Only the second leg',scope_revision:1,user_confirmed_scope:true},proposal_revision:0,confirmed_proposal_revision:0,history:[],created_at:'2030-01-01T00:00:00Z',updated_at:'2030-01-01T00:00:00Z'},journey:{passengers:1,fact_rule:'Known issuance is not current validity',legs:[]},instruction:'Manual intake'};
const directory:RailAftercareDirectory={execution_identity:view.execution_identity,order_id:'order_test',journey:view.journey,cases:[view],available_targets:view.case.request.targets,input_templates:{refund:{...view.case.request,user_confirmed_scope:false},change:{...view.case.request,operation:'change',user_confirmed_scope:false,change:{constraints:''}}},instruction:'No final refund promise.'};
test('aftercare scope and current consent templates remain false and terminal states stop',()=>{
 const envelope=railAftercareList(directory,'order_test');const templates=JSON.parse(JSON.stringify(envelope.interaction?.input_templates));assert.equal(templates.refund.input.user_confirmed_scope,false);
 for(const status of ['requested','needs_input','awaiting_confirmation','processing','completed','cancelled','rejected'] as const){
  const result=railAftercareEnvelope({...view,case:{...view.case,status,revision:3,proposal_revision:2},can_cancel:status==='requested'});
  if(status==='awaiting_confirmation'){assert.equal(result.interaction?.input_template?.input?.user_approved,false);assert.equal(result.interaction?.input_template?.input?.proposal_revision,2);}
  if(['completed','cancelled','rejected','needs_input','awaiting_confirmation'].includes(status))assert.equal(result.next,null);
  if(status==='requested')assert.ok(result.interaction?.cancel_template);
 }
});
test('aftercare commands use locked adapter and preserve the request idempotency key',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'itpay-aftercare-unit-'));
 try{
  const backend=new BackendClient(new HttpClient({baseURL:'http://127.0.0.1:1'}));const keys:string[]=[];
  backend.listRailAftercare=async()=>directory;backend.getRailAftercare=async()=>view;
  backend.createRailAftercare=async(_order,input,key)=>{keys.push(key);assert.deepEqual(input.targets,view.case.request.targets);return view};
  backend.respondRailAftercare=async(_id,input)=>{assert.equal(input.expected_revision,1);return view};backend.cancelRailAftercare=async()=>({...view,can_cancel:false,case:{...view.case,status:'cancelled'}});
  const config=loadConfig({ITPAY_STATE_DIR:dir});
  assert.equal((await runAftercareList(backend,'order_test')).status,'aftercare_directory');assert.equal((await runAftercareGet(backend,'case_test')).status,'requested');
  await runAftercareCreate(backend,config,'order_test',view.case.request);await railAftercareCreate(backend,config,'order_test',view.case.request);assert.equal(keys[0],keys[1]);
  await runAftercareRespond(backend,'case_test',{expected_revision:1,additional_information:'Clarified'});assert.equal((await runAftercareRespond(backend,'case_test',{expected_revision:1,reason:'Cancel'},true)).status,'cancelled');
  await assert.rejects(railAftercareCreate(backend,config,'order_test',{...view.case.request,user_confirmed_scope:false}),CommandContractError);
  await assert.rejects(railAftercareRespond(backend,'case_test',{expected_revision:0}),CommandContractError);
  backend.listRailAftercare=async()=>({...directory,execution_identity:{service_id:'ordinary',service_contract_version_id:'ordinary-v1'}});
  await assert.rejects(runAftercareList(backend,'order_test'),error=>error instanceof CommandContractError&&error.code==='aftercare_unsupported');
 }finally{await rm(dir,{recursive:true,force:true})}
});
