import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentAuth, sellerAuthPath, sellerSessionToken} from '../src/state/account_auth.js';

test('Agent login binds the signed device after Web completion without storing an account bearer', async () => {
  const home=mkdtempSync(join(tmpdir(),'itpay-agent-login-'));
  const base='https://dev.itpay.ai', env={HOME:home};
  let completed=false, bound=false, binds=0;
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
    return Response.json({status:completed?'completed':'email_verification_required'});
  };
  try {
    assert.equal((await agentAuth('status',base,backend,env,fetcher) as any).status,'login_required');
    await agentAuth('login',base,backend,env,fetcher);
    const path=sellerAuthPath(base,env,'agent-login');
    assert.equal(statSync(path).mode&0o777,0o600);
    assert.equal((await agentAuth('status',base,backend,env,fetcher) as any).status,'email_verification_required');
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
