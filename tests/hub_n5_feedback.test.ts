import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {HttpError} from '../src/client/http.js';
import {hubFailureInstruction,writeCommandEnvelope} from '../src/commands/hub_guidance.js';

test('metadata failures report actual class while original requests retain their reader',()=>{
 assert.match(hubFailureInstruction(new HttpError(0,{code:'request_timeout',message:'timeout'},''),'fallback'),/读取超时/);
 assert.match(hubFailureInstruction(new HttpError(404,{code:'not_found',message:'missing'},''),'fallback'),/不存在或不可见/);
 assert.match(hubFailureInstruction(new HttpError(403,{code:'forbidden',message:'denied'},''),'fallback'),/权限或授权范围不足/);
 assert.match(hubFailureInstruction(new HttpError(0,{code:'request_timeout',message:'Request outcome is unknown'},''),'fallback'),/提交结果未知/);
 let output='';writeCommandEnvelope({status:'unknown',result:{request_id:'original'},instruction:'保留原请求',next:{command:'itpay api resume original',reason:'read original'},recovery:[]},{jsonOutput:true,output:s=>output+=s});
 const frame=JSON.parse(output);assert.match(frame.instruction,/不换路重发/);assert.match(frame.next.command,/resume original/);
});

test('real inspect read timeout is not reported as unpublished and never submits a run',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'itpay-n5-feedback-'));let gets=0,posts=0;
 const server=createServer((req,res)=>{
  if(req.method==='POST')posts++;
  if(req.url==='/v1/operations/original'){gets++;return;}
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/runs/original') {res.end(JSON.stringify({run_id:'original',execution_state:'succeeded',settlement_state:'reconciling',delivery_state:'not_ready',result:null}));return;}
  res.writeHead(404);res.end(JSON.stringify({error:{code:'not_found',message:'missing'}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('loopback required');
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ITPAY_'))),ITPAY_STATE_DIR:dir,ITPAY_HUB_URL:`http://127.0.0.1:${address.port}`,ITPAY_HUB_KEY:'itk_synthetic_n5'};
 const invoke=(args:string[])=>new Promise<{code:number|null;output:string}>((done,reject)=>{
  const child=spawn(process.execPath,['--import','tsx',resolve('src/main.ts'),'api',...args,'--json'],{env,stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',reject);child.on('exit',code=>done({code,output}));
 });
 try {
  const timeout=await invoke(['inspect','original']);assert.equal(timeout.code,1,timeout.output);
  const failure=JSON.parse(timeout.output);assert.equal(failure.error.code,'request_timeout');assert.match(failure.error.message,/metadata read timed out/);assert.match(failure.instruction,/读取超时/);assert.doesNotMatch(failure.instruction,/可能未知或未发布/);
  const missing=JSON.parse((await invoke(['inspect','missing'])).output);assert.match(missing.instruction,/不存在或不可见/);
  const run=JSON.parse((await invoke(['run-status','original'])).output);assert.equal(run.result.delivery_state,'not_ready');assert.equal(run.result.actual_charge,null);assert.match(run.instruction,/费用回执未提供/);assert.doesNotMatch(run.instruction,/已按价格卡结算/);
  assert.equal(gets,1);assert.equal(posts,0);
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
