import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sellerAuth, sellerAuthPath, sellerSessionToken } from '../src/state/account_auth.js';
import { resolveBackendURL, qualifyBackendCommand, cartSessionPath, DEV_BASE_URL } from '../src/state/config.js';

test('Seller login uses the standard browser flow and never exposes the claimed token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'itpay-seller-'));
  const env = { HOME: home };
  const base = DEV_BASE_URL;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/auth-sessions')) return Response.json({ dashboard_auth_session_id: 'auth_1', poll_token: 'poll_fixture', start_url: base + '/auth/start?start_token=start_fixture' });
    if (url.includes('/claim?')) return Response.json({ expires_at: '2099-01-01T00:00:00Z' }, { headers: { 'Set-Cookie': 'itpay_buyer_session=secret_fixture; Path=/; HttpOnly' } });
    if (url.endsWith('/logout')) return new Response(null, { status: 204 });
    return Response.json({ status: 'completed' });
  };
  try {
    assert.equal((await sellerAuth('login', base, env, fetcher) as any).status, 'authorization_required');
    const status = await sellerAuth('status', base, env, fetcher);
    assert.equal((status as any).status, 'authenticated');
    assert.equal(JSON.stringify(status).includes('secret_fixture'), false);
    assert.equal(sellerSessionToken(base, env), 'secret_fixture');
    assert.equal(sellerSessionToken('https://app.itpay.ai', env), undefined);
    assert.equal(statSync(sellerAuthPath(base, env)).mode & 0o777, 0o600);
    await sellerAuth('logout', base, env, fetcher);
    assert.equal(sellerSessionToken(base, env), undefined);
    assert.equal(calls.length, 4);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Seller login rejects redirecting a session to a different origin', async () => {
  const fetcher: typeof fetch = async () => Response.json({ dashboard_auth_session_id: 'x', poll_token: 'x', start_url: 'https://evil.invalid/?start_token=x' });
  await assert.rejects(sellerAuth('login', DEV_BASE_URL, {}, fetcher), /origin/);
});

test('Seller login accepts official Alipay state and dashboard fragment tokens, rejecting mismatched sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'itpay-wallet-auth-'));
  const env = { HOME: directory };
  const oauth = 'https://openauth.alipay.com/oauth2/publicAppAuthorize.htm';
  let startURL = oauth + '?state=auth_1.start_fixture';
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith('/auth-sessions')) return Response.json({ dashboard_auth_session_id: 'auth_1', poll_token: 'poll_fixture', start_url: startURL });
    if (String(input).includes('/claim?start_token=start_fixture')) return Response.json({ expires_at: '2099-01-01T00:00:00Z' }, { headers: { 'Set-Cookie': 'itpay_buyer_session=secret_fixture; Path=/; HttpOnly' } });
    return Response.json({ status: 'completed' });
  };
  try {
    for (const value of [startURL, DEV_BASE_URL + '/#dashboard-auth?dashboard_auth_session_id=auth_1&start_token=start_fixture']) {
      startURL = value;
      assert.equal((await sellerAuth('login', DEV_BASE_URL, env, fetcher) as any).authorization_url, value);
      assert.equal((await sellerAuth('status', DEV_BASE_URL, env, fetcher) as any).status, 'authenticated');
    }
    for (const state of ['wrong_session.start_fixture', 'auth_1.', 'auth_1.start.extra']) {
      startURL = oauth + '?state=' + state;
      await assert.rejects(sellerAuth('login', DEV_BASE_URL, env, fetcher), /Incomplete/);
    }
    for (const value of ['http://openauth.alipay.com/oauth2/publicAppAuthorize.htm', 'https://openauth.alipay.com.evil.invalid/oauth2/publicAppAuthorize.htm', 'https://openauth.alipay.com/unexpected', 'https://user@openauth.alipay.com/oauth2/publicAppAuthorize.htm']) {
      startURL = value + '?state=auth_1.start_fixture';
      await assert.rejects(sellerAuth('login', DEV_BASE_URL, env, fetcher), /origin/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Public CLI supports official dev and isolates its state from production', () => {
  const home = mkdtempSync(join(tmpdir(), 'itpay-dev-'));
  try {
    const env = { HOME: home, ITPAY_BACKEND_URL: DEV_BASE_URL };
    assert.equal(resolveBackendURL(env), DEV_BASE_URL);
    assert.equal(qualifyBackendCommand('itpay sell status', env), 'ITPAY_BACKEND_URL=https://dev.itpay.ai itpay sell status');
    assert.notEqual(cartSessionPath(env), cartSessionPath({ HOME: home }));
    assert.throws(() => resolveBackendURL({ ITPAY_BACKEND_URL: 'https://evil.invalid', ITPAY_CLI_DEV: '1' }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
