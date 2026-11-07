import test from 'node:test';
import assert from 'node:assert/strict';
import {HttpError} from '../src/client/http.js';
import {hubFailureInstruction,writeCommandEnvelope} from '../src/commands/hub_guidance.js';

test('metadata failures report actual class while original requests retain their reader',()=>{
 assert.match(hubFailureInstruction(new HttpError(0,{code:'request_timeout',message:'timeout'},''),'fallback'),/读取超时/);
 assert.match(hubFailureInstruction(new HttpError(404,{code:'not_found',message:'missing'},''),'fallback'),/不存在或不可见/);
 assert.match(hubFailureInstruction(new HttpError(403,{code:'forbidden',message:'denied'},''),'fallback'),/权限或授权范围不足/);
 assert.match(hubFailureInstruction(new HttpError(0,{code:'request_timeout',message:'Request outcome is unknown'},''),'fallback'),/提交结果未知/);
 let output='';writeCommandEnvelope({status:'unknown',result:{request_id:'original'},instruction:'保留原请求',next:{command:'itpay api status original',reason:'read original'},recovery:[]},{jsonOutput:true,output:s=>output+=s});
 const frame=JSON.parse(output);assert.match(frame.instruction,/不换路重发/);assert.equal(frame.next,null);
});
