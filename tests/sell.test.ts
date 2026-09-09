import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELL_OPERATIONS, sellRequest } from '../src/sell/contract.js';
import { localAction } from '../src/sell/local.js';
test('Sell operations cannot select arbitrary endpoints or silently add request fields', () => {
    const op = SELL_OPERATIONS.find(o => o.command === 'submission submit')!;
    assert.throws(() => sellRequest(op, {}, {}), /merchant_id/);
    assert.throws(() => sellRequest(op, { merchant_id: 'm', draft_id: 'd' }, { expected_revision: 1, terms_version: 'x', confirmations: [], admin: true }), /Unsupported field/);
    const req = sellRequest(op, { merchant_id: 'm', draft_id: 'a/b' }, { expected_revision: 1, terms_version: 'x', confirmations: [] });
    assert.equal(req.path, '/v1/seller/organizations/m/service-drafts/a%2Fb/submit');
    assert.equal(SELL_OPERATIONS.some(op => op.path.includes('/admin/')), false);
});
test('Local init and credential binding preserve existing projects and keep secret values out', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'itpay-sell-'));
    try {
        await localAction('init', directory, { serviceId: 'demo', name: 'Demo' });
        await assert.rejects(() => localAction('init', directory, {}), /already exists/);
        const binding = join(directory, 'binding.json');
        writeFileSync(binding, JSON.stringify({ api_key: 'ITPAY_TEST_SECRET' }));
        await localAction('credentials bind', directory, { profile: 'demo', file: binding });
        assert.match(readFileSync(join(directory, '.itpay-sell', 'credentials.json'), 'utf8'), /ITPAY_TEST_SECRET/);
        writeFileSync(binding, JSON.stringify({ api_key: 'sk-secret-value' }));
        await assert.rejects(() => localAction('credentials bind', directory, { profile: 'demo', file: binding }), /environment variable/);
        assert.equal(JSON.parse(readFileSync(join(directory, 'service.json'), 'utf8')).service_id, 'demo');
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
test('Version deletion sends its revision in the strict JSON body', () => {
 const op=SELL_OPERATIONS.find(o=>o.command==='workflow versions delete-platform')!;
 const request=sellRequest(op,{merchant_id:'m',draft_id:'d',version_id:'v'},{expected_revision:3});
 assert.equal(request.method,'DELETE');
 assert.equal(request.path.includes('?'),false);
 assert.deepEqual(request.body,{expected_revision:3});
});
test('Init rejects an existing workflow before writing service settings', async () => {
 const directory=mkdtempSync(join(tmpdir(),'itpay-sell-existing-'));
 try {
  writeFileSync(join(directory,'workflow.yaml'),'user workflow');
  await assert.rejects(()=>localAction('init',directory,{}),/already exists/);
  assert.equal(readFileSync(join(directory,'workflow.yaml'),'utf8'),'user workflow');
  assert.throws(()=>readFileSync(join(directory,'service.json')),/ENOENT/);
 } finally {rmSync(directory,{recursive:true,force:true});}
});
