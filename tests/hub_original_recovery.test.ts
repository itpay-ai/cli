import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {hubTasksDir} from '../src/state/hub_tasks.js';

test('lost admission response resumes frozen body/key across processes and keeps known runs read-only',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'itpay-original-recovery-'));
 const posts:{body:unknown;key:unknown}[]=[];let sends=0;let reads=0;
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/operations/op/runs'){
   let raw='';for await(const c of req)raw+=c;
   posts.push({body:JSON.parse(raw),key:req.headers['idempotency-key']});
   if(posts.length===1){sends++;req.socket.destroy();return}
   res.end(JSON.stringify({run_id:'run-original',operation_id:'op',publication_id:'pub-original',execution_state:'unknown',settlement_state:'reconciling'}));return;
  }
  if(req.url==='/v1/runs/run-original'){reads++;res.end(JSON.stringify({run_id:'run-original',execution_state:'unknown',settlement_state:'reconciling'}));return}
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('local port required');
 const env={...process.env,ITPAY_STATE_DIR:dir,ITPAY_HUB_URL:`http://127.0.0.1:${address.port}`,ITPAY_HUB_KEY:'itk_synthetic_n3',ITPAY_HUB_TOKEN:''};
 const invoke=(args:string[],extra:NodeJS.ProcessEnv={})=>new Promise<{code:number|null;output:string}>((done,reject)=>{
  const child=spawn(process.execPath,['--import','tsx',resolve('src/main.ts'),'api',...args],{cwd:process.cwd(),env:{...env,...extra},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',reject);child.on('exit',code=>done({code,output}));
 });
 try{
  const refs={source:{credential_id:'uck_original',expected_version:'cred_original'}};
  const first=await invoke(['run','op','--publication','pub-original','--input','{"nested":{"x":42}}','--max-charge','12345','--source-credentials',JSON.stringify(refs),'--request-id','original','--json']);
  assert.equal(first.code,1);assert.match(first.output,/original/);assert.doesNotMatch(first.output,/itk_synthetic_n3/);
  assert.equal(posts.length,1,'transport failure must not cause automatic POST retry');
  const envelope=JSON.parse(first.output);assert.equal(envelope.result.request_id,'original');assert.match(envelope.next.command,/api resume original/);
  const recovered=await Promise.all([invoke(['resume','original','--json']),invoke(['resume','original','--json'])]);
  for(const result of recovered){assert.equal(result.code,0,result.output);assert.match(result.output,/run-original/)}
  assert.equal(sends,1,'fixture models one accepted logical run, not a new provider send');
  for(const post of posts){assert.deepEqual(post,posts[0]);assert.deepEqual((post.body as any).max_charge,{currency:'CNY',scale:6,amount_atoms:'12345'});assert.deepEqual((post.body as any).source_credentials,refs);assert.equal(post.key,'cli-req-original')}
  const count=posts.length;
  const known=await invoke(['resume','original','--json']);assert.equal(known.code,0,known.output);assert.equal(posts.length,count);assert.ok(reads>=1,'known unknown run must use GET only');
  const disconnected=await invoke(['run','op','--publication','pub-original','--input','{}','--json'],{ITPAY_STATE_DIR:join(dir,'unconnected'),ITPAY_HUB_KEY:''});assert.equal(disconnected.code,1);const auth=JSON.parse(disconnected.output);assert.equal(auth.error.code,'authorization_required');assert.match(auth.next.command,/api connect/);assert.equal(posts.length,count);
  const foreign=await invoke(['resume','original','--json'],{ITPAY_HUB_KEY:'itk_other_synthetic'});assert.equal(foreign.code,1);assert.equal(posts.length,count);
  // A damaged ledger cannot silently change the original cap/input and send.
  const file=join(hubTasksDir(env),'original.json');const original=JSON.parse(readFileSync(file,'utf8'));
  delete original.run_id;original.max_charge_atoms='99999';writeFileSync(file,JSON.stringify(original),{mode:0o600});
  const damaged=await invoke(['resume','original','--json']);assert.equal(damaged.code,1);assert.match(damaged.output,/idempotency_conflict/);assert.equal(JSON.parse(damaged.output).next,null);assert.equal(posts.length,count);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})}
});
