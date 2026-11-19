import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {HubClient,HUB_CONTRACT_REVISION} from '@itpay/hub-client';

test('API SDK is the fixed immutable build package, not copied vendor source',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 const manifestPath='../dependencies/itpay-hub-client-0.1.0-integration.27929b1259ec.source.json';
 const m=JSON.parse(readFileSync(new URL(manifestPath,import.meta.url),'utf8'));
 const bytes=readFileSync(new URL('../dependencies/'+m.tarball,import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),m.sha256);
 assert.equal(m.source_commit,'27929b1259ecbad5774db15efe96b650d92d0d8b');
 assert.equal(m.contract_revision,HUB_CONTRACT_REVISION);
 assert.equal(m.contract_bundle_digest,'sha256:653d9af028fe85471984255e8cdaf47f857bccf313395c951be429d65b8aadec');
 assert.equal(m.sha256,'e8527cd40681bf729bc25ddd5002e20510417ef1a908aec560091b0f59a3cc69');
 assert.equal(pkg.devDependencies['@itpay/hub-client'],'file:dependencies/'+m.tarball);
 const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(lock.packages['node_modules/@itpay/hub-client'].integrity,m.integrity);
 assert.equal(m.license,'UNLICENSED');
 assert.equal(existsSync(new URL('../src/vendor/hub-client.ts',import.meta.url)),false);
 const methods=Object.getOwnPropertyNames(HubClient.prototype);
 for(const name of ['walletRefundIntent','walletRefundStatus','getRequest','getRun','serviceAction','servicePurchaseReview','servicePurchaseConfirm','servicePurchaseResume','serviceAftercare','getAPIPaymentRequest','adminTool','listCommerceTransactions']) assert.ok(methods.includes(name),name);
});
