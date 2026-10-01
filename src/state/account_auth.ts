import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { writeLocalPNG } from '../render/qr.js';
import { TaskJournal } from './task_journal.js';
import { taskJournalPath } from './config.js';
import type { CommandAction, CommandEnvelope } from '../commands/guidance.js';

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

// AUTH01: dashboard session stages stay distinct — the human must know exactly
// what the official page still needs instead of a generic "pending".
const ACTIVE_SESSION_STAGES = ['created', 'waiting_provider', 'email_verification_required', 'merge_confirmation_required'] as const;

function stageInstruction(stage: string): string {
  if (stage === 'email_verification_required') {
    return '钱包授权已完成，官方页还需要完成联系方式验证（邮箱或手机，以页面实际提供的方式为准）。完成后继续原查询，不用重说行程。';
  }
  if (stage === 'merge_confirmation_required') {
    return '官方页需要用户确认账号合并决定后才能完成登录；不要替用户选择，也不要新建授权请求。';
  }
  return '用户仍在官方页面完成登录；保留当前 handoff，不要生成新二维码或新请求。';
}

// AUTH07: distinct outcomes stay distinct — a technical failure is never
// reported as a user denial, and a missing session is its own state.
const TERMINAL_SESSION_STATES: Record<string, { status: string; instruction: string }> = {
  expired: {
    status: 'auth_expired',
    instruction: '授权请求已过期。重新运行 itpay auth login 生成新请求；之前的查询输入在服务端保留，可恢复。',
  },
  failed: {
    status: 'auth_failed',
    instruction: '官方授权因技术原因未完成（不是用户拒绝）。重新运行 itpay auth login 生成新请求。',
  },
  cancelled: {
    status: 'auth_cancelled',
    instruction: '用户在官方页取消了授权；停止登录。只有用户明确重新要求授权时才发起新的登录。',
  },
  denied: {
    status: 'auth_denied',
    instruction: '官方授权被拒绝；停止登录，不自动创建新请求。只有用户明确重新要求授权时才重新登录。',
  },
};

class AuthRequestError extends Error {
  constructor(readonly httpStatus: number, message: string) {
    super(message);
    this.name = 'AuthRequestError';
  }
}

// AUTH03: transport/read uncertainty never maps to "denied" or a new session —
// the stored session stays on disk and the caller retries the same poll.
function authStatusUnknown(sessionID: string | undefined): CommandEnvelope {
  return {
    status: 'auth_status_unknown',
    result: sessionID ? { dashboard_auth_session_id: sessionID } : {},
    instruction: '读取官方授权状态时遇到网络或服务端临时故障；原授权请求已保留。稍后重读同一状态，不要新建授权、不要清除本地登记。',
    next: { command: 'itpay auth status --json', reason: '稍后重读同一授权状态', poll_after_ms: 5000 } as CommandAction,
    recovery: [],
  };
}

function sessionGone(env: NodeJS.ProcessEnv, purpose: string, baseURL: string, sessionID: string | undefined): CommandEnvelope {
  rmSync(sellerAuthPath(baseURL, env, purpose), { force: true });
  return {
    status: 'auth_session_missing',
    result: sessionID ? { dashboard_auth_session_id: sessionID } : {},
    instruction: '之前的授权请求在服务端已不存在。重新运行 itpay auth login 生成新请求。',
    next: { command: 'itpay auth login --json', reason: '重新发起官方授权' },
    recovery: [],
  };
}

// AUTH04: a successful bind resumes the SAME task that paused for login —
// from the local task journal, never a placeholder and never a guess at the
// latest order.
function authenticatedEnvelope(env: NodeJS.ProcessEnv, phoneVerified: boolean): CommandEnvelope {
  const paused = new TaskJournal(taskJournalPath(env)).pausedTasks()
    .filter((task) => task.stage === 'login_required' || task.stage === 'quota_paused');
  const resumable = paused.filter((task) => typeof task.resume_command === 'string');
  const result: Record<string, unknown> = { bound: true, phone_verified: phoneVerified };
  let instruction = '登录与绑定已完成，告知用户可继续之前的查询；已注册账号查询不消耗试用次数，仍受正常限流。';
  let next: CommandAction | null = null;
  if (resumable.length === 1) {
    next = { command: resumable[0]!.resume_command!, reason: '恢复登录前暂停的同一查询' };
  } else if (resumable.length > 1) {
    result.paused_executions = resumable.map((task) => ({
      service_execution_id: task.service_execution_id,
      ...(task.service_id ? { service_id: task.service_id } : {}),
      resume_command: task.resume_command,
    }));
    instruction += ' 有多个暂停的查询：只恢复与当前用户目标对应的那一个，不要一次恢复全部。';
  } else {
    instruction += ' 当前没有待恢复的暂停查询；不构造恢复命令。';
  }
  return { status: 'authenticated', result, instruction, next, recovery: [] };
}

async function accountAuth(action: 'login' | 'status' | 'logout', baseURL: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch, backend?: BindingClient): Promise<unknown> {
  const purpose = backend ? 'agent-login' : 'seller';
  const command = backend ? 'itpay auth status' : 'itpay sell auth status';
  if (backend) {
    try {
      const current = await backend.agentAccountStatus();
      if (current.status === 'authenticated') return authenticatedEnvelope(env, current.phone_verified === true);
    } catch (error) {
      if (error instanceof AuthRequestError) throw error;
      // AUTH03: even the binding-status probe can hit transport failure; the
      // truthful state is "unknown", never an implicit unbound or a fresh login.
      return authStatusUnknown(undefined);
    }
  }
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetcher(baseURL + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new AuthRequestError(response.status, `ItPay authorization failed (${response.status}); retry login if expired`);
    return response;
  }
  function pollOpenSession(state: Login): Promise<{ status: string; expires_at?: string }> {
    return request(`/v1/dashboard/auth-sessions/${encodeURIComponent(state.sessionID!)}?poll_token=${encodeURIComponent(state.pollToken!)}`)
      .then((response) => response.json() as Promise<{ status: string; expires_at?: string }>);
  }
  async function bindSavedSession(state: Login): Promise<CommandEnvelope> {
    const bound = await backend!.bindAgentAccount({ dashboard_auth_session_id: state.sessionID!, start_token: state.startToken! });
    if (bound.status !== 'authenticated') throw new Error('Agent binding did not complete');
    rmSync(sellerAuthPath(baseURL, env, purpose), { force: true });
    return authenticatedEnvelope(env, bound.phone_verified === true);
  }
  if (action === 'login') {
    if (backend) {
      const open = read(baseURL, env, purpose);
      if (open?.sessionID && open.pollToken && open.startToken) {
        try {
          const current = await pollOpenSession(open);
          // AUTH02: a completed-but-unbound session binds in place; never
          // create a second auth session for the same login.
          if (current.status === 'completed') return await bindSavedSession(open);
          if ((ACTIVE_SESSION_STAGES as readonly string[]).includes(current.status)) {
            const url = open.authURL ?? '';
            const qr = url ? await writeLocalPNG(url).catch(() => undefined) : undefined;
            return {
              status: 'auth_pending',
              result: {
                dashboard_auth_session_id: open.sessionID,
                stage: current.status,
                expires_at: current.expires_at,
                methods: ['phone', 'email', 'alipay', 'wechat'],
              },
              // SEC01: the handoff URL carries one-time credentials — it goes
              // to the human only, never into logs, prompts, or PR material.
              handoff: {
                url,
                contains_credentials: true,
                ...(qr ? { qr_local_path: qr.filePath, markdown: `![ItPay 官方授权二维码](${qr.filePath})` } : {}),
              },
              instruction: `${stageInstruction(current.status)} 沿用同一链接或二维码；不要生成新请求。`,
              next: { command: 'itpay auth status --json', reason: '用户完成页面登录后确认绑定', poll_after_ms: 5000 },
              recovery: [],
            };
          }
          const terminal = TERMINAL_SESSION_STATES[current.status];
          if (terminal) {
            rmSync(sellerAuthPath(baseURL, env, purpose), { force: true });
            // Fall through to a fresh session only after a definitive
            // terminal state; anything else keeps the stored session.
          } else {
            return authStatusUnknown(open.sessionID);
          }
        } catch (error) {
          if (error instanceof AuthRequestError && (error.httpStatus === 404 || error.httpStatus === 410)) {
            rmSync(sellerAuthPath(baseURL, env, purpose), { force: true });
            // The explicit login call may open one fresh session now. Status
            // remains read-only and still reports the missing old session.
          } else {
            return authStatusUnknown(open.sessionID);
          }
        }
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
          stage: 'created',
          expires_at: result.expires_at,
          methods: ['phone', 'email', 'alipay', 'wechat'],
        },
        handoff: {
          url: url.href,
          contains_credentials: true,
          ...(qr ? { qr_local_path: qr.filePath, markdown: `![ItPay 官方授权二维码](${qr.filePath})` } : {}),
        },
        instruction: '把官方授权页或二维码交给用户。用户在页面内选择手机号验证码、邮箱或钱包完成登录；不要替用户输入手机号或验证码，start_token 不要写入聊天记录或日志。',
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
  if (!state?.sessionID || !state.pollToken || !state.startToken) {
    // AUTH07: a bare `status` with no session is its own truthful state, not a
    // failure and not an implicit login.
    if (!backend) return { status: 'login_required' };
    return {
      status: 'login_required',
      result: {},
      instruction: '当前设备尚未绑定账号，也没有进行中的授权请求。需要时运行 itpay auth login 发起官方登录。',
      next: { command: 'itpay auth login --json', reason: '需要账号绑定时发起官方授权' },
      recovery: [],
    };
  }
  let progress: { status: string; expires_at?: string };
  try {
    progress = await pollOpenSession(state);
  } catch (error) {
    if (error instanceof AuthRequestError && (error.httpStatus === 404 || error.httpStatus === 410)) {
      return sessionGone(env, purpose, baseURL, state.sessionID);
    }
    return authStatusUnknown(state.sessionID);
  }
  if (progress.status !== 'completed') {
    if (backend) {
      const terminal = TERMINAL_SESSION_STATES[progress.status];
      if (terminal) {
        rmSync(sellerAuthPath(baseURL, env, purpose), { force: true });
        return {
          status: terminal.status,
          result: { dashboard_auth_session_id: state.sessionID, stage: progress.status },
          instruction: terminal.instruction,
          next: ['denied', 'cancelled'].includes(progress.status) ? null : { command: 'itpay auth login --json', reason: '需要登录时重新发起官方授权' },
          recovery: [],
        };
      }
      return {
        status: 'auth_pending',
        result: {
          dashboard_auth_session_id: state.sessionID,
          stage: progress.status,
          ...(progress.expires_at ? { expires_at: progress.expires_at } : {}),
        },
        instruction: stageInstruction(progress.status),
        next: { command: 'itpay auth status --json', reason: '轮询同一授权请求', poll_after_ms: 5000 },
        recovery: [],
      };
    }
    return { status: progress.status, instruction: 'Finish login and email verification in the browser.' };
  }
  if (backend) {
    try {
      return await bindSavedSession(state);
    } catch (error) {
      if (error instanceof AuthRequestError) throw error;
      // Binding outcome unknown: keep the session so a retry can still bind
      // the same completed login instead of creating a new one.
      return authStatusUnknown(state.sessionID);
    }
  }
  const claimed = await request(`/v1/dashboard/auth-sessions/${encodeURIComponent(state.sessionID)}/claim?start_token=${encodeURIComponent(state.startToken)}`, { method: 'POST' });
  const token = /(?:^|[, ]+)itpay_buyer_session=([^;]+)/.exec(claimed.headers.get('set-cookie') ?? '')?.[1];
  const session = await claimed.json() as { expires_at?: string };
  if (!token || !session.expires_at || !(Date.parse(session.expires_at) > Date.now())) throw new Error('Incomplete Seller session');
  save({ baseURL, sessionToken: token, expiresAt: session.expires_at }, env);
  return { status: 'authenticated', base_url: baseURL, expires_at: session.expires_at };
}
