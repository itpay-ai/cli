// Installed Buyer artifact, three processes, synthetic OAuth/API only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export async function verifyHubPackaged(packageRoot,scratch){
 const home=join(scratch,'api-home'),state=join(home,'state');mkdirSync(state,{recursive:true});
 const identityPath=join(state,'device-identity-sentinel');writeFileSync(identityPath,'Services identity stays untouched');
 const metadata=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
 assert.deepEqual(metadata.itpayCommands,['services','api']);
 const entry=join(packageRoot,'bin/itp.mjs');
 for(const group of ['api','hub','services']){const p=spawnSync(process.execPath,[entry,group,'--help'],{encoding:'utf8',env:{...process.env,HOME:home,ITPAY_STATE_DIR:state}});assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/Usage:/);if(group!=='services')assert.match(p.stdout,/discover/);else assert.match(p.stdout,/purchase/)}
 let refreshCalls=0,walletCalls=0;
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/oauth2/token'){
   let body='';for await(const chunk of req)body+=chunk;
   const form=new URLSearchParams(body);assert.equal(form.get('refresh_token'),'synthetic-refresh-old');assert.equal(form.get('resource'),base);refreshCalls++;
   await new Promise(r=>setTimeout(r,100));res.end(JSON.stringify({access_token:'synthetic-access-new',refresh_token:'synthetic-refresh-new',expires_in:300,token_type:'Bearer'}));return;
  }
  assert.equal(req.headers.authorization,'Bearer synthetic-access-new');
  if(req.url==='/v1/me'){res.end(JSON.stringify({buyer_id:'buyer-packaged',consumer_id:'oauth:itpay-cli-local'}));return;}
  if(req.url==='/v1/me/wallet'){walletCalls++;res.end(JSON.stringify({available:{currency:'CNY',scale:6,amount_atoms:'199490000'},held:{currency:'CNY',scale:6,amount_atoms:'0'}}));return;}
  res.writeHead(404);res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const env={...process.env,HOME:home,ITPAY_STATE_DIR:state,ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base,ITPAY_HUB_OAUTH_CLIENT:'itpay-cli-local'};
  delete env.ITPAY_HUB_TOKEN;delete env.ITPAY_HUB_KEY;
  const suffix=createHash('sha256').update(base).digest('hex').slice(0,12);
  const profile={base_url:base,access_token:'synthetic-access-old',refresh_token:'synthetic-refresh-old',expires_at:new Date(Date.now()-30000).toISOString(),refresh_after:new Date(Date.now()-60000).toISOString(),subject:'buyer-packaged',consumer_id:'oauth:itpay-cli-local',client_id:'itpay-cli-local',token_url:base+'/oauth2/token',created_at:new Date().toISOString()};
  writeFileSync(join(state,`hub-credentials.${suffix}.json`),JSON.stringify({schema_version:'itpay.hub_credentials.v1',profiles:{default:profile}}),{mode:0o600});
  const outputs=await Promise.all(['api','hub','api'].map(group=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[entry,group,'wallet','--json'],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('exit',code=>code===0?resolve(stdout):reject(new Error(`installed API CLI failed: ${stderr}`)));
  })));
  for(const output of outputs){const value=JSON.parse(output);assert.ok(value);assert.ok(output.includes('199490000'));assert.ok(!output.includes('synthetic-access'));}
  assert.equal(refreshCalls,1);assert.equal(walletCalls,3);assert.equal(readFileSync(identityPath,'utf8'),'Services identity stays untouched');
  return {boundary:'synthetic OAuth/API, installed Buyer bundle; not natural UX or payment E2E',processes:3,refresh_calls:refreshCalls,wallet_calls:walletCalls,services_identity:'unchanged',api_alias:'same implementation'};
 }finally{await new Promise(r=>server.close(r));}
}
