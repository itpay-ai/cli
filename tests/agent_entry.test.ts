import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {actualAgentType,agentRoot} from '../src/commands/agent.js';
import {saveAgentTask,attachAgentRequest} from '../src/state/agent_task.js';
test('runtime context selects independent host roots without adopting a different old identity',()=>{
 const argv=process.argv;process.argv=['node','itpay'];
 try{
  assert.equal(actualAgentType({CODEX_THREAD_ID:'thread'}),'codex-desktop');
  assert.equal(actualAgentType({ITPAY_AGENT_TYPE:'muse',CODEX_THREAD_ID:'thread'}),'codex-desktop');
  process.argv=['node','itpay','--agent-type','dot'];assert.equal(actualAgentType({ITPAY_AGENT_TYPE:'codex-cli',CODEX_THREAD_ID:'thread'}),'dot');process.argv=['node','itpay'];
  assert.throws(()=>actualAgentType({CODEX_THREAD_ID:'one',DOT_SESSION_ID:'two'}),/host_context_required/);
  for(const type of ['dot','muse','workbuddy'])assert.equal(actualAgentType({ITPAY_AGENT_TYPE:type}),type);
  assert.notEqual(agentRoot('dot',{HOME:'/tmp/agent'}),agentRoot('muse',{HOME:'/tmp/agent'}));
  assert.notEqual(agentRoot('dot',{HOME:'/tmp/agent',ITPAY_BACKEND_URL:'https://dev.itpay.ai'}),agentRoot('dot',{HOME:'/tmp/agent'}));
 }finally{process.argv=argv;}
});
test('next arbitrary reply resumes the task and original request; explicit new intent retains its receipt',()=>{
 const root=mkdtempSync(join(tmpdir(),'itpay-agent-entry-'));
 try{
  const task=saveAgentTask(root,'free earthquake query','api',undefined);
  const selector=join(root,'api','api-profile.json');mkdirSync(join(root,'api'));
  attachAgentRequest(selector,'req_original');
  assert.equal(saveAgentTask(root,undefined,undefined,undefined).request_id,'req_original');
  assert.throws(()=>attachAgentRequest(selector,'req_replacement'),/task_conflict/);
  assert.throws(()=>saveAgentTask(root,'different','api',undefined),/task_conflict/);
  const second=saveAgentTask(root,'independent new query','api',undefined,true);
  assert.notEqual(second.id,task.id);
  assert.equal(JSON.parse(readFileSync(join(root,'tasks',task.id+'.json'),'utf8')).request_id,'req_original');
  chmodSync(join(root,'task.json'),0o644);assert.throws(()=>saveAgentTask(root,undefined,undefined,undefined),/private regular/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
