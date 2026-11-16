import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {HubClient,HUB_CONTRACT_REVISION} from '@itpay/hub-client';

test('API SDK is the fixed immutable build package, not copied vendor source',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 const manifestPath='../dependencies/itpay-hub-client-0.1.0-integration.eeca7df57174.source.json';
 const m=JSON.parse(readFileSync(new URL(manifestPath,import.meta.url),'utf8'));
 const bytes=readFileSync(new URL('../dependencies/'+m.tarball,import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),m.sha256);
 assert.equal(m.source_commit,'eeca7df571743f571dc59f6ece024e50180db591');
 assert.equal(m.contract_revision,HUB_CONTRACT_REVISION);
 assert.equal(m.contract_bundle_digest,'sha256:15b64b70994cdcecb0fa61375b7463753d451e0eb50923f9b1696a11be746df0');
 assert.equal(m.sha256,'f2e1d2efb895d1709d4a6c0a3cfc0da6946c742e2c54d83cfa4c2c296434ee94');
 assert.equal(pkg.devDependencies['@itpay/hub-client'],'file:dependencies/'+m.tarball);
 const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(lock.packages['node_modules/@itpay/hub-client'].integrity,m.integrity);
 assert.equal(m.license,'UNLICENSED');
 assert.equal(existsSync(new URL('../src/vendor/hub-client.ts',import.meta.url)),false);
 const methods=Object.getOwnPropertyNames(HubClient.prototype);
 for(const name of ['walletRefundIntent','walletRefundStatus','getRequest','getRun','serviceAction','servicePurchaseReview','servicePurchaseConfirm','servicePurchaseResume','serviceAftercare','getAPIPaymentRequest','adminTool','listCommerceTransactions']) assert.ok(methods.includes(name),name);
});
