import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {readHubCredentialSelection} from '../src/commands/hub.js';

test('credential flags accept reference files and reject secrets, extra fields and mixed modes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'itpay-byok-parse-'));
 try{
  const mapping={api:{credential_id:'uck_fixture',expected_version:'cred_version'}};
  const file=join(dir,'references.json');writeFileSync(file,JSON.stringify(mapping));
  assert.deepEqual(readHubCredentialSelection(undefined,'@'+file),{source_credentials:mapping});
  assert.deepEqual(readHubCredentialSelection('uck_fixture'),{credential_id:'uck_fixture'});
  for(const args of [['uck_fixture',JSON.stringify(mapping)],['Bearer real-key',undefined],[undefined,'{"api":{"Authorization":"secret"}}'],[undefined,'[]'],[undefined,'{}'],[undefined,'{"api":{"credential_id":"uck_fixture","expected_version":"cred_version","key":"secret"}}']] as [string|undefined,string|undefined][]){assert.throws(()=>readHubCredentialSelection(...args),/invalid_input/)}
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('actual CLI sends and replays original BYOK references and detects selection changes before POST',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'itpay-byok-command-'));const requests:{body:any;key:unknown}[]=[];
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/operations/op/runs'){
   let raw='';for await(const chunk of req)raw+=chunk;requests.push({body:JSON.parse(raw),key:req.headers['idempotency-key']});
   if(req.headers['idempotency-key']==='cli-req-blocked'){res.writeHead(402);res.end(JSON.stringify({intent_id:'blocked-original',blocking_reason:'insufficient_balance'}));return}
   res.end(JSON.stringify({run_id:'original',operation_id:'op',publication_id:'pub',execution_state:'succeeded',settlement_state:'settled'}));return;
  }
  if(req.url==='/v1/intents/blocked-original/continue'){res.end(JSON.stringify({run:{run_id:'original',execution_state:'succeeded',settlement_state:'settled'}}));return}
  if(req.url==='/v1/runs/original'){res.end(JSON.stringify({run_id:'original',execution_state:'succeeded',settlement_state:'settled'}));return}
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();if(!addr||typeof addr==='string')throw Error('port required');
 const invoke=(args:string[])=>new Promise<{code:number|null;output:string}>((resolveRun,reject)=>{
  const child=spawn(process.execPath,['--import','tsx',resolve('src/main.ts'),'hub',...args],{cwd:process.cwd(),env:{...process.env,ITPAY_STATE_DIR:dir,ITPAY_HUB_URL:'http://127.0.0.1:'+addr.port,ITPAY_HUB_KEY:'itk_fixture_cli_byok',ITPAY_HUB_TOKEN:''},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',reject);child.on('exit',code=>resolveRun({code,output}));
 });
 try{
  const common=['run','op','--publication','pub','--input','{}','--request-id','same','--json'];
  const first=await invoke([...common,'--source-credentials','{"api":{"credential_id":"uck_fixture","expected_version":"cred_v1"}}']);
  assert.equal(first.code,0,first.output);assert.equal(requests.length,1);assert.deepEqual(requests[0]?.body.source_credentials,{api:{credential_id:'uck_fixture',expected_version:'cred_v1'}});assert.equal(requests[0]?.key,'cli-req-same');
  const replay=await invoke([...common,'--source-credentials','{"api":{"credential_id":"uck_fixture","expected_version":"cred_v1"}}']);assert.equal(replay.code,0,replay.output);assert.equal(requests.length,1);
  const conflict=await invoke([...common,'--credential-id','uck_changed']);assert.match(conflict.output,/idempotency_conflict/);assert.equal(requests.length,1);
  const legacy=await invoke(['run','op','--publication','pub','--input','{}','--request-id','legacy','--credential-id','uck_fixture','--json']);assert.equal(legacy.code,0,legacy.output);assert.equal(requests[1]?.body.credential_id,'uck_fixture');
  const blocked=await invoke(['run','op','--publication','pub','--input','{}','--request-id','blocked','--credential-id','uck_original','--json']);assert.equal(blocked.code,0,blocked.output);assert.equal(requests[2]?.body.credential_id,'uck_original');
  const resumed=await invoke(['resume','blocked','--json']);assert.equal(resumed.code,0,resumed.output);assert.equal(requests.length,3,'402 continuation must resume the retained intent without another admission');
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})}
});
