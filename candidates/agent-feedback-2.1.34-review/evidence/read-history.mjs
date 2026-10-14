// Isolated database errors through the unchanged installed candidate CLI.
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {startMockBackend} from '../../../tests/mock_backend.ts';
import {BackendClient} from '../install/node_modules/@itpay/cli/dist/src/client/backend.js';
import {HttpClient,HttpError} from '../install/node_modules/@itpay/cli/dist/src/client/http.js';
import {loadConfig} from '../install/node_modules/@itpay/cli/dist/src/state/config.js';
import {runServicesRun} from '../install/node_modules/@itpay/cli/dist/src/commands/services.js';
import {CommandContractError,writeCommandEnvelope} from '../install/node_modules/@itpay/cli/dist/src/commands/guidance.js';
const dir='/Users/tzz/.codex/worktrees/local-ux-lab/itpay_compose/docs/reviews/agent-feedback-followup-20261003/evidence/history-review';
const mock=await startMockBackend();
try {
 const client=new BackendClient(new HttpClient({baseURL:mock.url}));const config=loadConfig({ITPAY_API_BASE_URL:mock.url});
 for(const name of ['unrelated-raw-refresh','related-raw-unknown']) {
  const body=JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
  client.startServiceExecution=async()=>{throw new HttpError(409,body,'expired');};
  for(const jsonOutput of [true,false]) {
   let output='';const options={jsonOutput,output:s=>output+=s};
   try {await runServicesRun(client,config,'itpay-rail-booking',{passengers:1,selections:[{token:'rsel_alt_a',seat_type:'M'},{token:'rsel_alt_b',seat_type:'M'}]},options);assert.fail('expected expiry');}
   catch(error) {assert.ok(error instanceof CommandContractError);writeCommandEnvelope({status:'error',error:{code:error.code,message:error.message},...(error.result?{result:error.result}:{}),instruction:error.instruction,next:null,recovery:error.recovery,...(error.interaction?{interaction:error.interaction}:{})},options);}
   assert.ok(Buffer.byteLength(output)<12288);
   if(jsonOutput) {const value=JSON.parse(output);if(name==='unrelated-raw-refresh') {assert.ok(value.interaction);assert.equal(value.result.selection_expiry.safe_new_query,true);}else{assert.equal(value.interaction,undefined);assert.match(value.error.message,/无法排除/);assert.equal(value.result.selection_expiry.safe_new_query,false);}}
   writeFileSync(`${dir}/${name}-cli.${jsonOutput?'json':'txt'}`,output);
   console.log(name,jsonOutput?'JSON':'text',Buffer.byteLength(output),'bytes');
  }
 }
}finally{await mock.close();}
