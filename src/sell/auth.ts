import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';

type Login = { baseURL: string; sessionToken?: string; expiresAt?: string; sessionID?: string; pollToken?: string; startToken?: string };
export function sellerAuthPath(baseURL: string, env = process.env): string {
  return resolve(env.HOME || homedir(), '.itpay-v3', `seller-${createHash('sha256').update(baseURL).digest('hex').slice(0, 16)}.json`);
}
function read(baseURL: string, env = process.env): Login | undefined {
  const path = sellerAuthPath(baseURL, env);
  if (!existsSync(path)) return;
  const state = JSON.parse(readFileSync(path, 'utf8')) as Login;
  if (state.baseURL !== baseURL) throw new Error('Seller session backend mismatch');
  return state;
}
function save(state: Login, env = process.env) {
  const path = sellerAuthPath(state.baseURL, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}
export function sellerSessionToken(baseURL: string, env = process.env): string | undefined {
  const state = read(baseURL, env);
  return state?.expiresAt && Date.parse(state.expiresAt) > Date.now() ? state.sessionToken : undefined;
}
export async function sellerAuth(action: 'login' | 'status' | 'logout', baseURL: string, env = process.env, fetcher: typeof fetch = fetch): Promise<unknown> {
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetcher(baseURL + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Seller authorization failed (${response.status}); retry login if expired`);
    return response;
  }
  if (action === 'login') {
    const response = await request('/v1/dashboard/auth-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'alipay', return_to: '/seller' }) });
    const result = await response.json() as { dashboard_auth_session_id: string; start_url: string; poll_token: string };
    const url = new URL(result.start_url, baseURL);
    if (url.origin !== new URL(baseURL).origin) throw new Error('Unexpected authorization origin');
    const startToken = url.searchParams.get('start_token');
    if (!startToken || !result.poll_token || !result.dashboard_auth_session_id) throw new Error('Incomplete authorization response');
    save({ baseURL, sessionID: result.dashboard_auth_session_id, pollToken: result.poll_token, startToken }, env);
    return { status: 'authorization_required', authorization_url: url.href, instruction: 'Complete ItPay login in the browser, then run itpay sell auth status.' };
  }
  const state = read(baseURL, env);
  if (action === 'logout') {
    const token = sellerSessionToken(baseURL, env);
    if (token) await request('/v1/me/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    rmSync(sellerAuthPath(baseURL, env), { force: true });
    return { status: 'logged_out' };
  }
  if (sellerSessionToken(baseURL, env)) return { status: 'authenticated', base_url: baseURL, expires_at: state?.expiresAt };
  if (!state?.sessionID || !state.pollToken || !state.startToken) return { status: 'login_required' };
  const path = `/v1/dashboard/auth-sessions/${encodeURIComponent(state.sessionID)}`;
  const progress = await (await request(`${path}?poll_token=${encodeURIComponent(state.pollToken)}`)).json() as { status: string };
  if (progress.status !== 'completed') return { status: progress.status, instruction: 'Finish login and email verification in the browser.' };
  const claimed = await request(`${path}/claim?start_token=${encodeURIComponent(state.startToken)}`, { method: 'POST' });
  const token = /(?:^|[, ]+)itpay_buyer_session=([^;]+)/.exec(claimed.headers.get('set-cookie') ?? '')?.[1];
  const session = await claimed.json() as { expires_at?: string };
  if (!token || !session.expires_at || !(Date.parse(session.expires_at) > Date.now())) throw new Error('Incomplete Seller session');
  save({ baseURL, sessionToken: token, expiresAt: session.expires_at }, env);
  return { status: 'authenticated', base_url: baseURL, expires_at: session.expires_at };
}
