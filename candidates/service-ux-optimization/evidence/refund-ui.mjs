// Isolated intercepted API, real React pages; no transaction writes.
import assert from 'node:assert/strict';
import {chromium} from '/Users/tzz/.codex/worktrees/service-ux-optimization/itpay_compose/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs';
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
let state='manual',service='company';let writes=0;
const refund=()=>({refund_request_id:'rr_ui',order_id:'ord_ui',status:state==='manual'?'accepted':state==='pending'?'provider_pending':state==='unknown'?'failed':'succeeded',decision_mode:state==='manual'?'manual':'automatic',failure_class:state==='unknown'?'outcome_unknown':undefined,access_locked:true,can_cancel:state==='manual',amount_minor:200,currency:'CNY',created_at:'2026-10-09T01:00:00Z'});
await page.addInitScript(()=>sessionStorage.setItem('itpay-v3-web-runtime-v1',JSON.stringify({state:{sessionToken:'synthetic_ui_only',sessionScope:'account',sessionIssuedAt:new Date().toISOString(),sessionExpiresAt:'2099-01-01T00:00:00Z',locale:'zh-CN'},version:0})));
await page.route('**/v1/**',async route=>{const req=route.request();const path=new URL(req.url()).pathname;if(req.method()!=='GET'){writes++;throw new Error('unexpected write');}let result={email_verified:true,buyer_account_id:"ui_only"};
if(path.endsWith('/refunds'))result={refunds:[refund()]};
else if(path.includes('/refunds/'))result=refund();
else if(path.endsWith('/delivery-access'))result={delivery_mode:'vault_artifact',artifacts:[{vault_artifact_id:'va_ui',vault_status:'revealable'}]};
else if(path.endsWith('/rail'))result=service==='rail'?{rail:true,status:{state:'issued',issued_legs:1,total_legs:1,message:'Synthetic issued fixture',legs:[]},legs:[]}:{rail:false};
else if(path.endsWith('/ord_ui'))result={order_id:'ord_ui',order_code:'UI-TEST',status:state==='success'?'refunded':'delivered',amount_minor:200,currency:'CNY',paid_at:'2026-10-09T01:00:00Z',items:[{order_item_id:'oi_ui',title:service==='rail'?'模拟铁路整程':'企业综合报告',quantity:1,amount_minor:200,currency:'CNY'}],delivery_artifacts:[{delivery_artifact_id:'da_ui',status:'claimable',vault_artifact_id:'va_ui',vault_status:'revealable'}]};
await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});});
try {const observations=[];for(service of ['company','rail'])for(state of ['manual','pending','unknown','success']){
await page.goto('http://127.0.0.1:5189/orders/ord_ui');await page.getByText(service==='rail'?'模拟铁路整程':'企业综合报告',{exact:true}).first().waitFor({timeout:5000}).catch(async e=>{console.error(await page.locator('body').innerText(),errors,await page.evaluate(()=>sessionStorage.getItem('itpay-v3-web-runtime-v1')));throw e});
const expected=state==='success'?'退款已完成':state==='unknown'?'退款尚未确认成功':'退款处理中';await page.getByText(expected,{exact:false}).first().waitFor();const body=await page.locator('body').innerText();
assert.equal(await page.getByRole('button',{name:/申请.*退款|安全查看|领取/}).count(),0);
if(state==='success'){assert.doesNotMatch(body,/退款处理中|当前允许取消|可进入退款详情查看或取消/);}
if(state==='unknown')assert.match(body,/沿原申请等待平台对账/);
observations.push({service,state,expected,claimOrRefundButtons:0});
}
assert.equal(writes,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({observations,writes,pageErrors:errors},null,2));}finally{await browser.close();}
