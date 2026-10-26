import test from 'node:test';
import assert from 'node:assert/strict';
import {renderBlockedTask} from '../src/commands/hub.js';

test('blocked task presents the official per-payment QR and preserves original task',async()=>{
 const target='https://pay.example.test/payment-requests/original?token=fixture';
 let output='';const original=process.stdout.write;
 process.stdout.write=((chunk: string)=>{output+=chunk;return true}) as typeof process.stdout.write;
 try{await renderBlockedTask({request_id:'original-task',intent_id:'original-intent'},{intent_id:'original-intent',blocking_reason:'insufficient_balance',required_action:{kind:'display_qr',target,label:'扫码付款'},payment_request:{topup_id:'original-topup',payer_currency:'CNY',payer_minor_amount:'100'}},true)}finally{process.stdout.write=original}
 const envelope=JSON.parse(output);assert.equal(envelope.result.qr_kind,'official_checkout_link');assert.equal(envelope.result.request_id,'original-task');assert.equal(envelope.result.payment_request.topup_id,'original-topup');assert.ok(envelope.handoff.url===target);assert.equal(envelope.next.command,'itpay api resume original-task --json');
});
