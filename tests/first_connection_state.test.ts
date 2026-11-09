import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareAgentConnection,servicesConnectionRoot,saveAgentConnection} from '../src/state/agent_connection.js';

test('Services connection metadata isolates Backends without replacing the shared device key',()=>{
 const original=mkdtempSync(join(tmpdir(),'itpay-scoped-consent-'));
 try {
  const a='https://backend-a.example.test',b='https://backend-b.example.test';
  const rootA=servicesConnectionRoot(original,a);
  const stateA=prepareAgentConnection(rootA,a,'muse',{surface:'services',prepared:true,services_directory:original})!;
  stateA.connection_id='acn_original_a';stateA.buyer_id='buyer_a';saveAgentConnection(join(rootA,'connection.json'),stateA);
  const key=readFileSync(join(original,'device','device-private.pem'),'utf8');
  const rootB=servicesConnectionRoot(original,b);assert.notEqual(rootA,rootB);
  const stateB=prepareAgentConnection(rootB,b,'muse',{surface:'services',prepared:true,services_directory:original})!;
  assert.equal(stateB.services_directory,original);assert.equal(stateB.connection_id,undefined);
  assert.equal(readFileSync(join(original,'device','device-private.pem'),'utf8'),key);
  assert.equal(prepareAgentConnection(rootA,a,'muse')!.connection_id,'acn_original_a');
  assert.equal(prepareAgentConnection(rootA,a,'muse')!.buyer_id,'buyer_a');
  // The first deployed wrapper saved at the shared root. Keep it in place for A.
  saveAgentConnection(join(original,'connection.json'),stateA);
  assert.equal(servicesConnectionRoot(original,a),original);
  assert.equal(servicesConnectionRoot(original,b),rootB);
  assert.equal(prepareAgentConnection(original,a,'muse')!.connection_id,'acn_original_a');
 }finally{rmSync(original,{recursive:true,force:true})}
});
