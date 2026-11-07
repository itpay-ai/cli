import test from 'node:test';
import assert from 'node:assert/strict';
import {hubOAuthConfig} from '../src/state/hub_oauth.js';
import {writeCommandEnvelope} from '../src/commands/hub_guidance.js';

test('only an explicitly selected official dev API Hub supplies its canonical issuer',()=>{
 const local=hubOAuthConfig({});assert.equal(local.resource,'http://localhost:18090');assert.equal(local.tokenURL,'http://localhost:24444/oauth2/token');
 assert.equal(hubOAuthConfig({ITPAY_BACKEND_URL:'https://dev.itpay.ai'}).resource,local.resource,'Services selection cannot switch API identity');
 const dev=hubOAuthConfig({ITPAY_HUB_URL:'https://dev.itpay.ai/'});
 assert.equal(dev.resource,'https://dev.itpay.ai');assert.equal(dev.tokenURL,'https://auth-v4-dev.itpay.ai/oauth2/token');assert.equal(dev.clientID,'itpay-cli-local');
 assert.equal(hubOAuthConfig({ITPAY_HUB_URL:dev.resource,ITPAY_HUB_OAUTH_ISSUER:'https://explicit.example'}).tokenURL,'https://explicit.example/oauth2/token');
 assert.equal(hubOAuthConfig({ITPAY_HUB_URL:'https://unrelated.example'}).tokenURL,local.tokenURL,'do not guess another host issuer');
});

test('public recovery context never serializes credentials or unsafe URL userinfo/query',()=>{
 const names=['ITPAY_HUB_URL','ITPAY_HUB_TOKEN','ITPAY_HUB_KEY','ITPAY_STATE_DIR'];const before=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 try{
  process.env.ITPAY_HUB_URL='https://user:PRIVATE-PASS@hub.example/?token=PRIVATE-TOKEN';process.env.ITPAY_HUB_TOKEN='PRIVATE-TOKEN';process.env.ITPAY_HUB_KEY='PRIVATE-KEY';process.env.ITPAY_STATE_DIR='/tmp/safe';
  let out='';writeCommandEnvelope({status:'error',instruction:'preserve original',next:{command:'itpay api status original',reason:'same request'},recovery:[]},{jsonOutput:true,output:s=>out+=s});
  assert.equal(JSON.parse(out).next,null);assert.doesNotMatch(out,/PRIVATE|user:/);
 }finally{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name]}}
});
