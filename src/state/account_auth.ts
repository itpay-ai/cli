import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { writeLocalPNG } from '../render/qr.js';

type BindingClient = { agentAccountStatus(): Promise<{status: string; phone_verified?: boolean}>; bindAgentAccount(input: {dashboard_auth_session_id: string; start_token: string}): Promise<{status: string; phone_verified?: boolean}> };
type Login = { baseURL: string; sessionToken?: string; expiresAt?: string; sessionID?: string; pollToken?: string; startToken?: string; authURL?: string };
export function sellerAuthPath(baseURL: string, env = process.env, purpose = "seller"): string {
  return resolve(env.HOME || homedir(), '.itpay-v3', `${purpose}-${createHash('sha256').update(baseURL).digest('hex').slice(0, 16)}.json`);
}
function read(baseURL: string, env = process.env, purpose = "seller"): Login | undefined {
  const path = sellerAuthPath(baseURL, env, purpose);
  if (!existsSync(path)) return;
  const state = JSON.parse(readFileSync(path, 'utf8')) as Login;
  if (state.baseURL !== baseURL) throw new Error('Seller session backend mismatch');
  return state;
}
function save(state: Login, env = process.env, purpose = "seller") {
  const path = sellerAuthPath(state.baseURL, env, purpose);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}
export function sellerSessionToken(baseURL: string, env = process.env): string | undefined {
  const state = read(baseURL, env);
  return state?.expiresAt && Date.parse(state.expiresAt) > Date.now() ? state.sessionToken : undefined;
}
export function sellerAuth(action: 'login' | 'status' | 'logout', baseURL: string, env = process.env, fetcher: typeof fetch = fetch): Promise<unknown> {
  return accountAuth(action, baseURL, env, fetcher);
}
export function agentAuth(action: 'login' | 'status', baseURL: string, backend: BindingClient, env = process.env, fetcher: typeof fetch = fetch): Promise<unknown> {
  return accountAuth(action, baseURL, env, fetcher, backend);
}
async function accountAuth(action: 'login' | 'status' | 'logout', baseURL: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch, backend?: BindingClient): Promise<unknown> {
  const purpose = backend ? 'agent-login' : 'seller';
  const command = backend ? 'itpay auth status' : 'itpay sell auth status';
  if (backend) {
    const current = await backend.agentAccountStatus();
    if (current.status === 'authenticated') return {
      status: 'authenticated',
      result: { bound: true, phone_verified: current.phone_verified === true },
      instruction: '设备已绑定账号，可继续之前的查询或购买；登录不附带任何额外授权。',
      next: { command: 'itpay services run <service_id> --execution <pending_execution_id> --json', reason: '恢复被额度暂停的原执行' },
      recovery: [],
    };
  }
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetcher(baseURL + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`ItPay authorization failed (${response.status}); retry login if expired`);
    return response;
  }
  if (action === 'login') {
    if (backend) {
      const open = read(baseURL, env, purpose);
      if (open?.sessionID && open.pollToken && open.startToken) {
        try {
          const current = await (await request(`/v1/dashboard/auth-sessions/${encodeURIComponent(open.sessionID)}?poll_token=${encodeURIComponent(open.pollToken)}`)).json() as { status: string; expires_at?: string };
          if (['created', 'waiting_provider', 'email_verification_required', 'merge_confirmation_required'].includes(current.status)) {
            const url = open.authURL ?? '';
            const qr = url ? await writeLocalPNG(url).catch(() => undefined) : undefined;
            return {
              status: 'auth_pending',
              result: { dashboard_auth_session_id: open.sessionID, expires_at: current.expires_at, methods: ['phone', 'email', 'alipay', 'wechat'] },
              handoff: { url, ...(qr ? { qr_local_path: qr.filePath, markdown: `![ItPay 官方授权二维码](${qr.filePath})` } : {}) },
              instruction: '已有进行中的官方授权请求，沿用同一链接或二维码；不要生成新请求。用户在页面内选择手机号验证码、邮箱或钱包完成登录。',
              next: { command: 'itpay auth status --json', reason: '用户完成页面登录后确认绑定', poll_after_ms: 5000 },
              recovery: [],
            };
          }
        } catch { /* fall through to a fresh request */ }
      }
    }
    const response = await request('/v1/dashboard/auth-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ return_to: backend ? '/' : '/seller' }) });
    const result = await response.json() as { dashboard_auth_session_id: string; start_url: string; poll_token: string; expires_at?: string };
    const url = new URL(result.start_url, baseURL);
    const sameOrigin = url.origin === new URL(baseURL).origin;
    const alipay = url.origin === 'https://openauth.alipay.com' && url.pathname === '/oauth2/publicAppAuthorize.htm' && !url.username && !url.password;
    if (!sameOrigin && !alipay) throw new Error('Unexpected authorization origin');
    const fragment = new URLSearchParams(url.hash.replace(/^#dashboard-auth\?/, ''));
    const state = url.searchParams.get('state')?.split('.');
    const startToken = alipay
      ? (state?.length === 2 && state[0] === result.dashboard_auth_session_id ? state[1] : undefined)
      : url.searchParams.get('start_token') || fragment.get('start_token');
    if (!startToken || !result.poll_token || !result.dashboard_auth_session_id) throw new Error('Incomplete authorization response');
    save({ baseURL, sessionID: result.dashboard_auth_session_id, pollToken: result.poll_token, startToken, authURL: url.href }, env, purpose);
    if (backend) {
      const qr = await writeLocalPNG(url.href).catch(() => undefined);
      return {
        status: 'auth_pending',
        result: {
          dashboard_auth_session_id: result.dashboard_auth_session_id,
          expires_at: result.expires_at,
          methods: ['phone', 'email', 'alipay', 'wechat'],
        },
        handoff: {
          url: url.href,
          ...(qr ? { qr_local_path: qr.filePath, markdown: `![ItPay 官方授权二维码](${qr.filePath})` } : {}),
        },
        instruction: '把官方授权页或二维码交给用户。用户在页面内选择手机号验证码、邮箱或钱包完成登录；不要替用户输入手机号或验证码，start_token 不要写入聊天记录。',
        next: { command: 'itpay auth status --json', reason: '用户完成页面登录后确认绑定', poll_after_ms: 5000 },
        recovery: [],
      };
    }
    return { status: 'authorization_required', authorization_url: url.href, instruction: `Complete ItPay login in the browser, then run ${command}.` };
  }
  const state = read(baseURL, env, purpose);
  if (action === 'logout') {
    const token = sellerSessionToken(baseURL, env);
    if (token) await request('/v1/me/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    rmSync(sellerAuthPath(baseURL, env), { force: true });
    return { status: 'logged_out' };
  }
  if (!backend && sellerSessionToken(baseURL, env)) return { status: 'authenticated', base_url: baseURL, expires_at: state?.expiresAt };
  if (!state?.sessionID || !state.pollToken || !state.startToken) return { status: 'login_required' };
  const path = `/v1/dashboard/auth-sessions/${encodeURIComponent(state.sessionID)}`;
  const progress = await (await request(`${path}?poll_token=${encodeURIComponent(state.pollToken)}`)).json() as { status: string };
  if (progress.status !== 'completed') {
    if (backend) {
      if (progress.status === 'expired') {
        rmSync(sellerAuthPath(baseURL, env, purpose), { force: true });
        return {
          status: 'auth_expired',
          result: { dashboard_auth_session_id: state.sessionID },
          instruction: '授权请求已过期。重新运行 itpay auth login 生成新请求；之前的查询输入在服务端保留，可恢复。',
          next: { command: 'itpay auth login --json', reason: '重新发起官方授权' },
          recovery: [],
        };
      }
      if (progress.status === 'failed' || progress.status === 'cancelled' || progress.status === 'denied') {
        rmSync(sellerAuthPath(baseURL, env, purpose), { force: true });
        return {
          status: progress.status === 'failed' ? 'auth_denied' : `auth_${progress.status}`,
          result: { dashboard_auth_session_id: state.sessionID },
          instruction: '官方授权未通过或被取消。重新运行 itpay auth login 生成新请求。',
          next: { command: 'itpay auth login --json', reason: '重新发起官方授权' },
          recovery: [],
        };
      }
      return {
        status: 'auth_pending',
        result: { dashboard_auth_session_id: state.sessionID },
        instruction: '用户仍在官方页面完成登录；保留当前 handoff，不要生成新二维码或新请求。',
        next: { command: 'itpay auth status --json', reason: '轮询同一授权请求', poll_after_ms: 5000 },
        recovery: [],
      };
    }
    return { status: progress.status, instruction: 'Finish login and email verification in the browser.' };
  }
  if (backend) {
    const result = await backend.bindAgentAccount({dashboard_auth_session_id: state.sessionID, start_token: state.startToken});
    if (result.status !== 'authenticated') throw new Error('Agent binding did not complete');
    rmSync(sellerAuthPath(baseURL, env, purpose), {force: true});
    return {
      status: 'authenticated',
      result: { bound: true, phone_verified: result.phone_verified === true },
      instruction: '登录与绑定已完成，告知用户可继续之前的查询；已注册账号查询不消耗试用次数，仍受正常限流。',
      next: { command: 'itpay services run <service_id> --execution <pending_execution_id> --json', reason: '恢复被额度暂停的原查询' },
      recovery: [],
    };
  }
  const claimed = await request(`${path}/claim?start_token=${encodeURIComponent(state.startToken)}`, { method: 'POST' });
  const token = /(?:^|[, ]+)itpay_buyer_session=([^;]+)/.exec(claimed.headers.get('set-cookie') ?? '')?.[1];
  const session = await claimed.json() as { expires_at?: string };
  if (!token || !session.expires_at || !(Date.parse(session.expires_at) > Date.now())) throw new Error('Incomplete Seller session');
  save({ baseURL, sessionToken: token, expiresAt: session.expires_at }, env);
  return { status: 'authenticated', base_url: baseURL, expires_at: session.expires_at };
}
