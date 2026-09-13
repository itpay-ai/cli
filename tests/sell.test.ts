import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELL_OPERATIONS, sellRequest } from '../src/sell/contract.js';
import { localAction } from '../src/sell/local.js';
import { consumePlatformGate, enforcePlatformGate, GateRequiredError, recordApproval } from '../src/sell/gates.js';
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
test('Seller gates block until approved and are consumed after the gated action', async () => {
    const home = mkdtempSync(join(tmpdir(), 'itpay-gates-'));
    const env = { ...process.env, HOME: home };
    const config = { baseURL: 'http://seller-gate-test.invalid' } as never;
    const backend = {} as never;
    const input = { service_id: 'gated-demo', public_name: 'Gated Demo' };
    const baseArgs = {
        command: 'services create',
        merchantId: 'm',
        input,
        request: { method: 'POST' as const, path: '/v1/seller/organizations/m/service-drafts', body: input },
        backend,
        config,
    };
    try {
        await assert.rejects(() => enforcePlatformGate(baseArgs, env), (error: unknown) => {
            assert.ok(error instanceof GateRequiredError);
            assert.equal(error.block.gate, 'g1');
            assert.match(error.block.approve_command, /itpay sell gates approve --gate g1/);
            return true;
        });
        await assert.rejects(
            () => recordApproval({ gate: 'g1', merchantId: 'm', input, nonInteractive: true, confirmed: false, backend }, env),
            /--note/);
        const { entry } = await recordApproval({ gate: 'g1', merchantId: 'm', input, note: 'human said yes', nonInteractive: true, confirmed: false, backend }, env);
        assert.equal(entry.fingerprint.startsWith('itpay-sell-gate.v1:g1:'), true);
        const receipt = await enforcePlatformGate(baseArgs, env);
        assert.equal(receipt?.bypassed, false);
        consumePlatformGate(receipt!, { merchantId: 'm' }, env);
        await assert.rejects(() => enforcePlatformGate(baseArgs, env), GateRequiredError);
        // Changed content must not match the old approval.
        const changed = { ...baseArgs, input: { service_id: 'gated-demo', public_name: 'Changed Name' }, request: { method: 'POST' as const, path: baseArgs.request.path, body: { service_id: 'gated-demo', public_name: 'Changed Name' } } };
        await assert.rejects(() => enforcePlatformGate(changed, env), GateRequiredError);
        // G5 cannot be approved before G4 evidence is accepted.
        await assert.rejects(() => recordApproval({ gate: 'g5', merchantId: 'm', draftId: 'd', input: { expected_revision: 1, pricing: {} }, note: 'x', nonInteractive: true, confirmed: false, backend }, env), /G4/);
    }
    finally { rmSync(home, { recursive: true, force: true }); }
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
