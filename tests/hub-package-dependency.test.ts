import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {HubClient,HUB_CONTRACT_REVISION} from '@itpay/hub-client';

test('API SDK is the fixed immutable build package, not copied vendor source',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 const manifestPath='../dependencies/itpay-hub-client-0.1.0-integration.2136dfa6d451.source.json';
 const m=JSON.parse(readFileSync(new URL(manifestPath,import.meta.url),'utf8'));
 const bytes=readFileSync(new URL('../dependencies/'+m.tarball,import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),m.sha256);
 assert.equal(m.source_commit,'2136dfa6d451046356b459d773cda23bcc084ae3');
 assert.equal(m.contract_revision,HUB_CONTRACT_REVISION);
 assert.equal(m.contract_bundle_digest,'sha256:26780b15d9152bf397007f4be9c226d0c4b077ef3f4139b027b7d3175017a52a');
 assert.equal(m.sha256,'6cc7b35531ea54c40915f3625de47c4081e2c37640e03ba75bbee5a4d92dc2dc');
 assert.equal(pkg.devDependencies['@itpay/hub-client'],'file:dependencies/'+m.tarball);
 const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(lock.packages['node_modules/@itpay/hub-client'].integrity,m.integrity);
 assert.equal(m.license,'UNLICENSED');
 assert.equal(existsSync(new URL('../src/vendor/hub-client.ts',import.meta.url)),false);
 const methods=Object.getOwnPropertyNames(HubClient.prototype);
 for(const name of ['walletRefundIntent','walletRefundStatus','getRequest','getRun','serviceAction','servicePurchaseReview','servicePurchaseConfirm','servicePurchaseResume','serviceAftercare','getAPIPaymentRequest','adminTool','listCommerceTransactions']) assert.ok(methods.includes(name),name);
});
