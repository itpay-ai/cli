import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePurchaseConfirmation} from '../src/commands/services/purchase.js';
import {purchaseContract} from '../src/services/shared/purchase_contract.generated.js';
const input=()=>({review_ref:'review-fixture',request_key:'request-fixture',user_approved:true,user_answer:'按已披露条件在官方页核对后付款',price_policy:{mode:'confirm_on_official_page',currency:'test-currency'}});
test('PA confirmation preserves published parser boundaries and actionable fields',()=>{
 assert.equal(parsePurchaseConfirmation(input()).price_policy.currency,'test-currency');
 for(const key of ['a'.repeat(200),'😀'.repeat(100)])assert.equal(parsePurchaseConfirmation({...input(),request_key:key}).request_key,key);
 for(const key of ['a'.repeat(201),'😀'.repeat(101)])assert.throws(()=>parsePurchaseConfirmation({...input(),request_key:key}));
 for(const value of [false,'true',1])assert.throws(()=>parsePurchaseConfirmation({...input(),user_approved:value}));
 for(const mode of Object.keys(purchaseContract.modes)){
  const policy={mode,currency:'CNY',...(mode==='exact'?{amount_minor:0}:mode==='capped'?{maximum_minor:9007199254740991}:{})};
  assert.equal(parsePurchaseConfirmation({...input(),price_policy:policy}).price_policy.mode,mode);
 }
 for(const price_policy of [{mode:'exact',currency:'CNY',amount_minor:1,maximum_minor:2},{mode:'capped',currency:'CNY',maximum_minor:9007199254740992},{mode:'confirm_on_official_page',currency:'CNY',quote_id:'q'}])assert.throws(()=>parsePurchaseConfirmation({...input(),price_policy}));
 try{parsePurchaseConfirmation({...input(),price_policy:{mode:'guessed',currency:'CNY'}});assert.fail('accepted guessed mode');}
 catch(error){assert.match(JSON.stringify(error),/price_policy.mode/);assert.match(JSON.stringify(error),/request_sent/);}
});
