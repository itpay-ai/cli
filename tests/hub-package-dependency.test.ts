import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {HubClient,HUB_CONTRACT_REVISION} from '@itpay/hub-client';

test('API SDK is the fixed immutable build package, not copied vendor source',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 const manifestPath='../dependencies/itpay-hub-client-0.1.0-integration.7286bd58df4a.source.json';
 const m=JSON.parse(readFileSync(new URL(manifestPath,import.meta.url),'utf8'));
 const bytes=readFileSync(new URL('../dependencies/'+m.tarball,import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),m.sha256);
 assert.equal(m.source_commit,'7286bd58df4a6b43c78addf3293d01a261cfa8fe');
 assert.equal(m.contract_revision,HUB_CONTRACT_REVISION);
 assert.equal(m.contract_bundle_digest,'sha256:2c7ac58c57de2c413cb7c62b64fc1b782f61c1a33dd0cc66862d7562eaeca9d7');
 assert.equal(m.sha256,'585441be72d94b836b72ebbfa98efaebd19e0661f8fcffcf1b64a0611e8277a1');
 assert.equal(pkg.devDependencies['@itpay/hub-client'],'file:dependencies/'+m.tarball);
 const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(lock.packages['node_modules/@itpay/hub-client'].integrity,m.integrity);
 assert.equal(m.license,'UNLICENSED');
 assert.equal(existsSync(new URL('../src/vendor/hub-client.ts',import.meta.url)),false);
 const methods=Object.getOwnPropertyNames(HubClient.prototype);
 for(const name of ['getRequest','getRun','serviceAction','servicePurchaseReview','servicePurchaseConfirm','servicePurchaseResume','serviceAftercare','getAPIPaymentRequest','adminTool','listCommerceTransactions']) assert.ok(methods.includes(name),name);
});
