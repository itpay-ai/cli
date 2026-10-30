import test from 'node:test';
import assert from 'node:assert/strict';
import {HttpClient} from '../src/client/http.js';
import {BackendClient} from '../src/client/backend.js';
import {renderTerminal} from '../src/render/terminal.js';
import {agentAuth} from '../src/state/account_auth.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfSkAAAAASUVORK5CYII=','base64');
test('official purchase PNG uses the existing signed device request and rejects non-images',async()=>{
 let signedPath='',bad=false;
 const http=new HttpClient({baseURL:'https://app.itpay.ai',requestAuthorizer:async({path})=>{signedPath=path;return {'X-Fixture-Proof':'signed'}},fetchImpl:async(_url,init)=>{
  assert.equal((init?.headers as Record<string,string>)['X-Fixture-Proof'],'signed');assert.equal(init?.redirect,'error');
  return new Response(bad?'not a PNG':png,{headers:{'Content-Type':'image/png'}});
 }});
 const backend=new BackendClient(http);
 assert.deepEqual(Buffer.from(await backend.getServicePurchaseCard('se_original')),png);
 assert.equal(signedPath,'/v1/service-executions/se_original/purchase/card.png');
 bad=true;await assert.rejects(()=>backend.getServicePurchaseCard('se_original'),/invalid official PNG/);
});
test('terminal image failure preserves original URL and next without synthesizing a QR',async()=>{
 let output='';await renderTerminal({kind:'checkout_qr',host:'terminal',summary:'original',url:'https://app.itpay.ai/checkout/chk_original',preferredQRSources:[],platform:{text:'official checkout',links:[],buttons:[],blocks:[]},afterActionCommand:'itpay services get se_original --json'},{format:'terminal',isTTY:false,output:line=>{output+=line}});
 assert.match(output,/https:\/\/app.itpay.ai\/checkout\/chk_original/);assert.match(output,/itpay services get se_original --json/);assert.doesNotMatch(output,/[█▀▄]|QR file:/);
});
test('login downloads original official card; repeated login reuses the same session even if image fails',async()=>{
 const home=mkdtempSync(join(tmpdir(),'itpay-b1-card-'));let posts=0,images=0,fail=false;
 const base='https://app.itpay.ai';const backend={agentAccountStatus:async()=>({status:'login_required'}),bindAgentAccount:async()=>{throw Error('must not bind')}};
 const fetcher:typeof fetch=async(url,init)=>{
  if(String(url).includes('/card.png?')){images++;assert.match(String(url),/das_original\/card.png\?start_token=original$/);return fail?new Response('unavailable',{status:503}):new Response(png,{headers:{'Content-Type':'image/png'}})}
  if(init?.method==='POST'){posts++;return Response.json({dashboard_auth_session_id:'das_original',poll_token:'poll',start_url:base+'/signin?dashboard_auth_session_id=das_original&start_token=original'})}
  return Response.json({status:'created'});
 };
 try {const first:any=await agentAuth('login',base,backend,{HOME:home},fetcher);assert.match(first.handoff.markdown,/官方授权卡/);assert.equal(first.handoff.purpose,'login');fail=true;const second:any=await agentAuth('login',base,backend,{HOME:home},fetcher);assert.equal(second.handoff.url,first.handoff.url);assert.equal(second.handoff.image_status,'unavailable');assert.equal(second.next.command,'itpay auth status --json');assert.equal(posts,1);assert.equal(images,2)}finally{rmSync(home,{recursive:true,force:true})}
});

test('official PNG fallback retains the exact original credential',async()=>{
 const {fallbackCardPNGURL}=await import('../src/services/shared/platform.js');
 const card=new URL(fallbackCardPNGURL('https://app.itpay.ai','chk_original','token+original'));
 assert.equal(card.pathname,'/v1/checkouts/chk_original/card.png');assert.equal(card.searchParams.get('display_token'),'token+original');
});
