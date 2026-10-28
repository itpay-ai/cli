import { sellerSessionToken } from '../src/sell/auth.js';
import { authStatePath } from '../src/state/auth_storage.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentAuth} from '../src/state/account_auth.js';

test('Agent login binds the signed device after Web completion without storing an account bearer', async () => {
  const home=mkdtempSync(join(tmpdir(),'itpay-agent-login-'));
  const base='https://dev.itpay.ai', env={HOME:home};
  let completed=false, bound=false, binds=0,stage="email_verification_required";
  const backend={
    async agentAccountStatus() {return {status:bound?'authenticated':'login_required'};},
    async bindAgentAccount(input: {dashboard_auth_session_id:string;start_token:string}) {
      assert.deepEqual(input,{dashboard_auth_session_id:'das',start_token:'start'});
      assert.equal(completed,true); binds++; bound=true; return {status:'authenticated'};
    },
  };
  const fetcher: typeof fetch=async (input, init) => {
    const url=String(input);
    assert.equal(url.includes('/claim'),false);
    if (init?.method==='POST') return Response.json({dashboard_auth_session_id:'das',poll_token:'poll',start_url:base+'/auth/start?start_token=start'});
    return Response.json({status:completed?'completed':stage});
  };
  try {
    assert.equal((await agentAuth('status',base,backend,env,fetcher) as any).status,'login_required');
    await agentAuth('login',base,backend,env,fetcher);
    const path=authStatePath(base,env,'agent-login');
    assert.equal(statSync(path).mode&0o777,0o600);
    assert.equal((await agentAuth('status',base,backend,env,fetcher) as any).status,'auth_pending');
    const historical=await agentAuth('status',base,backend,env,fetcher) as any;
    assert.match(historical.instruction,/普通登录只需一种有效身份/);
    stage='merge_confirmation_required';
    const merge=await agentAuth('status',base,backend,env,fetcher) as any;
    assert.match(merge.instruction,/这不是付款确认/);
    assert.equal(merge.status,'auth_pending');
    assert.equal(existsSync(path),true);
    assert.equal(binds,0);
    completed=true;
    assert.equal((await agentAuth('status',base,backend,env,fetcher) as any).status,'authenticated');
    assert.equal(existsSync(path),false);
    assert.equal(sellerSessionToken(base,env),undefined);
    await agentAuth('status',base,backend,env,fetcher);
    assert.equal(binds,1);
    assert.equal((await agentAuth('status','https://app.itpay.ai',{...backend, async agentAccountStatus(){return {status:'login_required'};}},env,fetcher) as any).status,'login_required');
  } finally {rmSync(home,{recursive:true,force:true});}
});


test('known missing Agent Type is not swallowed into auth_status_unknown',async()=>{
 const {AgentTypeRequiredError}=await import('../src/state/agent_type.js');
 await assert.rejects(()=>agentAuth('login','https://v4-dev.itpay.ai',{
  agentAccountStatus:async()=>{throw new AgentTypeRequiredError();},bindAgentAccount:async()=>{throw Error('must not bind');},
 }),AgentTypeRequiredError);
});
