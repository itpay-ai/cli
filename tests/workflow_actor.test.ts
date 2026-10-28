import assert from 'node:assert/strict';
import test from 'node:test';
import type {ServiceExecutionReadModel} from '../src/client/types.js';
import {BackendClient} from '../src/client/backend.js';
import {HttpClient} from '../src/client/http.js';
import {runServicesAction} from '../src/commands/services.js';
import {workflowEnvelope} from '../src/services/shared/workflow.js';
import {railWorkflowEnvelope} from '../src/services/rail/review.js';
import {startMockBackend} from './mock_backend.js';

test('owner-projected actor travels from either returned template into the original HTTP action',async()=>{
 const mock=await startMockBackend();
 try{
  const client=new BackendClient(new HttpClient({baseURL:mock.url}));
  const base=await client.getServiceExecution('se_original');
  for(const render of [workflowEnvelope,railWorkflowEnvelope]){
   for(const submissionActor of ['agent','human',undefined] as const){
    const input={choices:{origin:'origin_1',destination:'destination_1'},choice_statement:'用户明确选择原目标',choice_source:'chat',workflow_revision:8,candidate_set_hash:'original-candidates'};
    const model={...base,workflow_entry:{capability_id:'itpay_service',input_schema:{}},workflow:{status:'human_action',current_step:'confirm_location',revision:8,steps:{},human_action:{action_type:'workflow:confirm_location',...(submissionActor?{submission_actor:submissionActor}:{}),input_schema:{type:'object',required:Object.keys(input),properties:Object.fromEntries(Object.entries(input).map(([k,v])=>[k,{type:typeof v==='number'?'integer':typeof v==='object'?'object':'string'}]))},context:{}}}} as ServiceExecutionReadModel;
    const envelope=render(model)!;
    const template=envelope.interaction!.input_template as {command:string;file_content:Record<string,unknown>};
    const actor=template.command.match(/--actor-type (agent|human)(?: |$)/)?.[1];
    assert.equal(actor,submissionActor??'human');
    const before=mock.requests.length;
    let output='';await runServicesAction(client,'se_original','workflow:confirm_location',input,{actorType:actor,status:'approved',jsonOutput:true,output:s=>output+=s});
    const writes=mock.requests.slice(before).filter(r=>r.method==='POST');
    assert.equal(writes.length,1);assert.equal(writes[0]!.path,'/v1/service-executions/se_original/actions');
    assert.equal(writes[0]!.body?.actor_type,submissionActor??'human');assert.deepEqual(writes[0]!.body?.input_snapshot,input);
    assert.ok(output);assert.equal(mock.requests.slice(before).some(r=>/\/quotes|\/checkouts|\/runs/.test(r.path)),false);
   }
  }
 }finally{await mock.close();}
});
