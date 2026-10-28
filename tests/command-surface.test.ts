import test from 'node:test';
import assert from 'node:assert/strict';
import {Command} from 'commander';
import {registerAPICommands} from '../src/commands/api_commands.js';
import {spawnSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
test('api and hub are one registration object, with original Services entry intact',()=>{
 const program=new Command();registerAPICommands(program);
 assert.equal(program.commands.length,1);
 const api=program.commands[0]!;assert.equal(api.name(),'api');assert.deepEqual(api.aliases(),['hub']);
 for(const cmd of ['connect','discover','inspect','run','resume','tasks','wallet','admin']) assert.ok(api.commands.some(c=>c.name()===cmd),cmd);
 for(const group of ['api','hub','services']) {
  const p=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','src/main.ts',group,'--help'],{cwd:root,encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/Usage:/);
  if(group!=='services'){assert.match(p.stdout,/discover/);assert.doesNotMatch(p.stdout,/service_execution_id|rail-booking/)}
  else assert.match(p.stdout,/purchase/);
 }
});

// Exercise the actual registered API boundary, not a second CLI implementation.
// Every endpoint is loopback and all payment/identity facts are synthetic.

test('registered API commands keep original requests, safe errors and Services identity across processes',async()=>{
 const home=mkdtempSync(join(tmpdir(),'itpay-api-command-contract-'));
 const sentinel=join(home,'services-identity-sentinel');writeFileSync(sentinel,'unchanged');
 const money={currency:'CNY',scale:6,amount_atoms:'1000000'};
 const descriptor={operation_id:'op-fixture',api_id:'api-fixture',display_name:'Fixture',kind:'metered_api',effect_class:'read_only',status:'published',current_publication_id:'pub-fixture',price_card:{mode:'free',amount_atoms:'0',unit:'call'},input_schema:{type:'object',properties:{}}};
 const run={run_id:'run-original',execution_state:'succeeded',settlement_state:'settled',actual_charge:money};
 let deny=false;const writes:Array<{url:string;key:string|undefined;body:unknown}>=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;
  res.setHeader('Content-Type','application/json');
  if(deny){res.writeHead(403);res.end(JSON.stringify({error:{code:'forbidden',message:'Fixture scope denied'}}));return;}
  if(req.method==='POST')writes.push({url:req.url??'',key:req.headers['idempotency-key'] as string|undefined,body:raw?JSON.parse(raw):null});
  const path=(req.url??'').split('?')[0];
  if(path==='/v1/discover'){res.end(JSON.stringify({items:[{...descriptor,publication_id:'pub-fixture'}],snapshot_id:'saved'}));return;}
  if(path==='/v1/operations/op-fixture'){res.end(JSON.stringify(descriptor));return;}
  if(path==='/v1/me'){res.end(JSON.stringify({buyer_id:'synthetic-buyer',consumer_id:'oauth:itpay-cli-local'}));return;}
  if(path==='/v1/me/wallet'){res.end(JSON.stringify({available:money,held:money}));return;}
  if(path==='/v1/me/usage'){res.end(JSON.stringify({gross_atoms:'0',refunded_atoms:'0',net_atoms:'0',held_atoms:'0'}));return;}
  if(path==='/v1/me/wallet/transactions'){res.end(JSON.stringify({items:[]}));return;}
  if(path==='/v1/topup-skus'){res.end(JSON.stringify({items:[{sku_id:'fixture-sku',display:'Fixture',credit:money}]}));return;}
  if(path==='/v1/me/topups'||path==='/v1/me/topups/top-original'){res.end(JSON.stringify({topup_id:'top-original',status:'payment_pending',payer_currency:'CNY',payer_minor_amount:'100'}));return;}
  if(path==='/v1/operations/op-fixture/runs'||path==='/v1/runs/run-original'){res.end(JSON.stringify(run));return;}
  if(path==='/v1/intents/intent-original/continue'){res.end(JSON.stringify({intent_id:'intent-original',status:'succeeded',run}));return;}
  res.writeHead(404);res.end(JSON.stringify({error:{code:'not_found',message:'Unknown fixture route '+path}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();if(!address||typeof address==='string')throw Error('fixture listener required');
 const base='http://127.0.0.1:'+address.port;
 const invoke=(args:string[],stdin='')=>new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,['--import','tsx','src/main.ts','api',...args,'--json'],{cwd:root,env:{...process.env,HOME:home,ITPAY_STATE_DIR:home,ITPAY_HUB_URL:base,ITPAY_HUB_KEY:'itk_synthetic_contract',ITPAY_HUB_TOKEN:''},stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.end(stdin);
 });
 try{
  const happy=[['discover'],['inspect','op-fixture'],['wallet'],['usage'],['transactions'],['topups'],['topup','fixture-sku','--channel','wechat','--mode','native'],['topup-status','top-original'],['doctor'],['run','op-fixture','--publication','pub-fixture','--input','{}','--request-id','logical-original'],['resume','logical-original'],['run-status','run-original'],['continue','intent-original'],['tasks'],['credentials','import']];
  for(const args of happy){const p=await invoke(args,args[0]==='credentials'?'itk_synthetic_import_key':'');assert.equal(p.code,0,args.join(' ')+': '+p.out+p.err);assert.ok(JSON.parse(p.out));assert.ok(!p.out.includes('itk_synthetic_contract'));}
  const admission=writes.filter(x=>x.url==='/v1/operations/op-fixture/runs');assert.equal(admission.length,1);assert.ok(admission[0]!.key);assert.deepEqual(admission[0]!.body,{expected_publication_id:'pub-fixture',input:{}});
  const topup=writes.find(x=>x.url==='/v1/me/topups');assert.ok(topup?.key);assert.deepEqual(topup?.body,{sku_id:'fixture-sku',payer_currency:'CNY',channel:'wechat',mode:'native'});
  deny=true;
  for(const args of [['discover'],['inspect','op-fixture'],['wallet'],['usage'],['transactions'],['topups'],['topup','fixture-sku'],['topup-status','top-original'],['continue','intent-original'],['run-status','run-original'],['run','op-fixture','--publication','pub-fixture','--input','{}','--request-id','denied-original'],['resume','missing-original'],['credentials','import']]){
   const p=await invoke(args,args[0]==='credentials'?'bad key':'');assert.equal(p.code,1,args.join(' ')+': '+p.out+p.err);const envelope=JSON.parse(p.out);assert.equal(envelope.status,'error');assert.ok(envelope.error.code);assert.ok(!p.out.includes('itk_synthetic_contract'));
  }
  assert.equal(readFileSync(sentinel,'utf8'),'unchanged');
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true});}
});

test('API connect uses synthetic PKCE callback and verifies the exact resource and consumer',async()=>{
 const home=mkdtempSync(join(tmpdir(),'itpay-api-oauth-contract-'));
 let resource='';let exchanges=0;
 const issuer=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/oauth2/token'){
   let raw='';for await(const b of req)raw+=b;const form=new URLSearchParams(raw);
   assert.equal(form.get('grant_type'),'authorization_code');assert.equal(form.get('code'),'synthetic-code');assert.equal(form.get('resource'),resource);assert.ok(form.get('code_verifier'));exchanges++;
   res.end(JSON.stringify({access_token:'synthetic-oauth-access',refresh_token:'synthetic-oauth-refresh',expires_in:300}));return;
  }
  if(req.url==='/v1/me'){assert.equal(req.headers.authorization,'Bearer synthetic-oauth-access');res.end(JSON.stringify({buyer_id:'fixture-buyer',consumer_id:'oauth:fixture-public-cli'}));return;}
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>(r=>issuer.listen(0,'127.0.0.1',r));const addr=issuer.address();if(!addr||typeof addr==='string')throw Error('fixture listener');resource='http://127.0.0.1:'+addr.port;
 try{
  const child=spawn(process.execPath,['--import','tsx','src/main.ts','api','connect','--json'],{cwd:root,env:{...process.env,HOME:home,ITPAY_STATE_DIR:home,ITPAY_HUB_URL:resource,ITPAY_HUB_OAUTH_ISSUER:resource,ITPAY_HUB_OAUTH_CLIENT:'fixture-public-cli',ITPAY_HUB_TOKEN:'',ITPAY_HUB_KEY:''},stdio:['ignore','pipe','pipe']});
  let output='',diagnostic='';child.stdout.on('data',b=>output+=b);
  const authorized=new Promise<void>((resolve,reject)=>{let started=false;child.stderr.on('data',b=>{diagnostic+=b;const match=diagnostic.match(/Open to authorize ItPay: (http[^\s]+)/);if(!match||started)return;started=true;(async()=>{const auth=new URL(match[1]!);assert.equal(auth.searchParams.get('resource'),resource);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');const callback=new URL(auth.searchParams.get('redirect_uri')!);callback.searchParams.set('state',auth.searchParams.get('state')!);callback.searchParams.set('code','synthetic-code');const response=await fetch(callback);assert.equal(response.status,200);resolve();})().catch(reject);});});
  const exited=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  await authorized;assert.equal(await exited,0,diagnostic);const envelope=JSON.parse(output);assert.equal(envelope.status,'connected');assert.equal(envelope.result.subject,'fixture-buyer');assert.equal(envelope.next.command,'itpay api doctor --json');assert.equal(exchanges,1);assert.ok(!output.includes('synthetic-oauth-access'));assert.ok(!output.includes('synthetic-oauth-refresh'));
 }finally{await new Promise<void>(r=>issuer.close(()=>r()));rmSync(home,{recursive:true,force:true});}
});
