import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {hubOAuthConfig} from '../src/state/hub_oauth.js';
import {importHubKey} from '../src/state/hub_credentials.js';
import {writeCommandEnvelope} from '../src/commands/hub_guidance.js';

test('only an explicitly selected official dev API Hub supplies its canonical issuer',()=>{
 const local=hubOAuthConfig({});assert.equal(local.resource,'http://localhost:18090');assert.equal(local.tokenURL,'http://localhost:24444/oauth2/token');
 assert.equal(hubOAuthConfig({ITPAY_BACKEND_URL:'https://v4-dev.itpay.ai'}).resource,local.resource,'Services selection cannot switch API identity');
 const dev=hubOAuthConfig({ITPAY_HUB_URL:'https://market-v4-dev.itpay.ai/'});
 assert.equal(dev.resource,'https://market-v4-dev.itpay.ai');assert.equal(dev.tokenURL,'https://auth-v4-dev.itpay.ai/oauth2/token');assert.equal(dev.clientID,'itpay-cli-local');
 assert.equal(hubOAuthConfig({ITPAY_HUB_URL:dev.resource,ITPAY_HUB_OAUTH_ISSUER:'https://explicit.example'}).tokenURL,'https://explicit.example/oauth2/token');
 assert.equal(hubOAuthConfig({ITPAY_HUB_URL:'https://unrelated.example'}).tokenURL,local.tokenURL,'do not guess another host issuer');
});

test('public recovery context never serializes credentials or unsafe URL userinfo/query',()=>{
 const names=['ITPAY_HUB_URL','ITPAY_HUB_TOKEN','ITPAY_HUB_KEY','ITPAY_STATE_DIR'];const before=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 try{
  process.env.ITPAY_HUB_URL='https://user:PRIVATE-PASS@hub.example/?token=PRIVATE-TOKEN';process.env.ITPAY_HUB_TOKEN='PRIVATE-TOKEN';process.env.ITPAY_HUB_KEY='PRIVATE-KEY';process.env.ITPAY_STATE_DIR='/tmp/safe';
  let out='';writeCommandEnvelope({status:'error',instruction:'preserve original',next:{command:'itpay api resume original',reason:'same request'},recovery:[]},{jsonOutput:true,output:s=>out+=s});
  assert.equal(JSON.parse(out).next,null);assert.doesNotMatch(out,/PRIVATE|user:/);
 }finally{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name]}}
});

test('copied API next works in a clean shell with stored credentials and quoted state path',async()=>{
 const root=mkdtempSync(join(tmpdir(),"itpay-onboard-"));const state=join(root,"state ' $() space");const bin=join(root,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'itpay'),`#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const r=spawnSync(${JSON.stringify(process.execPath)},['--import','tsx',${JSON.stringify(resolve('src/main.ts'))},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o700});
 const calls:string[]=[];
 const server=createServer((req,res)=>{
  calls.push(req.url??'');assert.equal(req.headers['x-itpay-key'],'itk_stored_synthetic');res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/discover'){res.end(JSON.stringify({items:[{operation_id:'op',api_id:'api',kind:'metered_api',display_name:'query',effect_class:'read_only',status:'published'}]}));return}
  if(req.url==='/v1/operations/op'){res.end(JSON.stringify({operation_id:'op',api_id:'api',kind:'metered_api',display_name:'query',effect_class:'read_only',status:'published',current_publication_id:'pub',input_schema:{type:'object',required:['query'],properties:{query:{type:'string'}}}}));return}
  res.writeHead(404);res.end('{}');
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('port required');
 const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ITPAY_')));
 const env={...clean,PATH:bin+':'+process.env.PATH,ITPAY_HUB_URL:`http://127.0.0.1:${address.port}`,ITPAY_STATE_DIR:state,ITPAY_AGENT_TYPE:'codex-desktop'};
 importHubKey('itk_stored_synthetic',env.ITPAY_HUB_URL,env);
 const invoke=(command:string,actual:NodeJS.ProcessEnv)=>new Promise<{code:number|null;output:string}>((done,reject)=>{const child=spawn('/bin/sh',['-c',command],{cwd:process.cwd(),env:actual,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',reject);child.on('exit',code=>done({code,output}));});
 try{
  const first=await invoke('itpay api discover --query query --json',env);assert.equal(first.code,0,first.output);const next=JSON.parse(first.output).next.command;
  assert.match(next,/ITPAY_HUB_URL=/);assert.match(next,/ITPAY_STATE_DIR=/);assert.match(next,/--agent-type codex-desktop/);assert.doesNotMatch(next,/itk_stored_synthetic|HUB_TOKEN|HUB_KEY/);
  const copied=await invoke(next,{...clean,PATH:env.PATH});assert.equal(copied.code,0,copied.output);assert.equal(JSON.parse(copied.output).result.operation_id,'op');assert.match(JSON.parse(copied.output).next.command,/api run --help$/,'input preparation must be executable without guessing input');assert.doesNotMatch(copied.output,/<JSON>/);const help=await invoke(JSON.parse(copied.output).next.command,{...clean,PATH:env.PATH});assert.equal(help.code,0,help.output);assert.match(help.output,/Usage:/);assert.deepEqual(calls,['/v1/discover','/v1/operations/op']);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true})}
});
