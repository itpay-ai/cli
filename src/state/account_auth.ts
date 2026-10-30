import { AgentTypeRequiredError } from "./agent_type.js";
import { HttpError } from '../client/http.js';
import { HttpTransportError } from '../client/transport.js';
import { DeviceAuthorizationError, DeviceStateError } from './device_authority.js';
import { rmSync } from 'node:fs';
import { authStatePath, readAuthState as read, saveAuthState as save, type Login } from './auth_storage.js';
import { downloadBrandQRToTmp } from '../render/ide.js';
import { TaskJournal } from './task_journal.js';
import { taskJournalPath } from './config.js';
import type { CommandAction, CommandEnvelope } from '../commands/guidance.js';
type BindingClient = {
    agentAccountStatus(): Promise<{
        status: string;
        phone_verified?: boolean;
    }>;
    bindAgentAccount(input: {
        dashboard_auth_session_id: string;
        start_token: string;
    }): Promise<{
        status: string;
        phone_verified?: boolean;
    }>;
};
export function agentAuth(action: 'login' | 'status', baseURL: string, backend: BindingClient, env = process.env, fetcher: typeof fetch = fetch, options: {
    readOnlyStatus?: boolean;
} = {}): Promise<unknown> {
    return accountAuth(action, baseURL, env, fetcher, backend, options.readOnlyStatus === true && action === 'status');
}
// AUTH01: dashboard session stages stay distinct — the human must know exactly
// what the official page still needs instead of a generic "pending".
const ACTIVE_SESSION_STAGES = ['created', 'waiting_provider', 'email_verification_required', 'merge_confirmation_required'] as const;
function stageInstruction(stage: string): string {
    if (stage === 'email_verification_required') {
        return '官方页返回显式或历史身份验证状态；按页面当前要求完成验证。普通登录只需一种有效身份，不要求补齐邮箱和手机。完成后恢复原执行。';
    }
    if (stage === 'merge_confirmation_required') {
        return '官方页需要用户核对两侧账号证明及主账号，再明确确认或取消合并；这不是付款确认。不要替用户同意，不自动重启原服务或授权请求。';
    }
    return '用户仍在官方页面完成登录；保留当前 handoff，不要生成新二维码或新请求。';
}
// AUTH07: distinct outcomes stay distinct — a technical failure is never
// reported as a user denial, and a missing session is its own state.
const TERMINAL_SESSION_STATES: Record<string, {
    status: string;
    instruction: string;
}> = {
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
function authStatusUnknown(sessionID: string | undefined, error?: unknown, failureStage = "authorization_status_read"): CommandEnvelope {
    // These errors have definite compatibility/identity/state facts. Let the
    // command boundary report them rather than turning them into polling.
    if ((error instanceof HttpError && error.status < 500)
        || (error instanceof AuthRequestError && error.httpStatus < 500)
        || error instanceof DeviceAuthorizationError || error instanceof DeviceStateError || error instanceof AgentTypeRequiredError)
        throw error;
    const hostFailure = error && typeof error === "object" && "code" in error
        && (error.code === "CODEBUDDY_BROKER_DENY" || error.code === "CODEBUDDY_BROKER_OUTCOME_UNKNOWN");
    const failure = error instanceof HttpTransportError
        ? { category: error.code, attempts: error.attempts, source: "network_transport" }
        : error instanceof HttpError || error instanceof AuthRequestError
            ? { category: "http_server_error", http_status: error instanceof HttpError ? error.status : error.httpStatus, source: "http_response" }
            : hostFailure ? { category: "host_operation_unavailable", source: "host_broker" }
                : { category: "authorization_status_unavailable", source: "unclassified" };
    return {
        status: 'auth_status_unknown',
        result: { ...failure, failure_stage: failureStage, ...(sessionID ? { dashboard_auth_session_id: sessionID } : {}) },
        instruction: hostFailure || failure.source === 'unclassified'
            ? '本轮授权检查未完成，底层原因尚未确定；保留设备和已有授权，请维护方核对当前失败阶段及宿主结果，不自动登录、换身份或盲目重复修改。'
            : sessionID
                ? '读取官方授权状态失败；原授权请求已保留。稍后重读同一状态，不要新建授权、不要清除本地登记。'
                : '本轮账号绑定检查未完成，设备与绑定状态尚未确认；没有保存的授权请求。结束本轮，网络或服务恢复后可重新检查，不发起登录。',
        next: sessionID && !hostFailure && failure.source !== 'unclassified' ? { command: 'itpay auth status --json', reason: '稍后重读同一授权状态', poll_after_ms: 5000 } : null,
        recovery: [],
    };
}
function sessionGone(env: NodeJS.ProcessEnv, purpose: string, baseURL: string, sessionID: string | undefined): CommandEnvelope {
    rmSync(authStatePath(baseURL, env, purpose), { force: true });
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
    }
    else if (resumable.length > 1) {
        result.paused_executions = resumable.map((task) => ({
            service_execution_id: task.service_execution_id,
            ...(task.service_id ? { service_id: task.service_id } : {}),
            resume_command: task.resume_command,
        }));
        instruction += ' 有多个暂停的查询：只恢复与当前用户目标对应的那一个，不要一次恢复全部。';
    }
    else {
        instruction += ' 当前没有待恢复的暂停查询；不构造恢复命令。';
    }
    return { status: 'authenticated', result, instruction, next, recovery: [] };
}
async function accountAuth(action: 'login' | 'status', baseURL: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch, backend: BindingClient, readOnlyStatus = false): Promise<unknown> {
    const purpose = 'agent-login';
    const command = 'itpay auth status';
    {
        try {
            const current = await backend.agentAccountStatus();
            if (current.status !== 'authenticated' && current.status !== 'login_required')
                throw new Error('Unexpected account binding status');
            // Preparation must not poll, bind or consume a saved browser authorization.
            if (readOnlyStatus)
                return { status: current.status, result: { bound: current.status === 'authenticated' }, instruction: '设备账号状态已读取。', next: null, recovery: [] };
            if (current.status === 'authenticated')
                return authenticatedEnvelope(env, current.phone_verified === true);
        }
        catch (error) {
            if (error instanceof AuthRequestError || error instanceof AgentTypeRequiredError)
                throw error;
            // AUTH03: even the binding-status probe can hit transport failure; the
            // truthful state is "unknown", never an implicit unbound or a fresh login.
            return authStatusUnknown(readOnlyStatus ? undefined : read(baseURL, env, purpose)?.sessionID, error, "account_binding_probe");
        }
    }
    async function request(path: string, init: RequestInit = {}) {
        const response = await fetcher(baseURL + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok)
            throw new AuthRequestError(response.status, `ItPay authorization failed (${response.status}); retry login if expired`);
        return response;
    }
    async function officialLoginCard(sessionID: string, startToken: string) {
        const cardURL = `${baseURL}/v1/dashboard/auth-sessions/${encodeURIComponent(sessionID)}/card.png?start_token=${encodeURIComponent(startToken)}`;
        return downloadBrandQRToTmp(cardURL, 'auth', sessionID, {fetchImpl: fetcher, baseURL, caption: 'ItPay 官方账号登录卡'});
    }
    function pollOpenSession(state: Login): Promise<{
        status: string;
        expires_at?: string;
    }> {
        return request(`/v1/dashboard/auth-sessions/${encodeURIComponent(state.sessionID!)}?poll_token=${encodeURIComponent(state.pollToken!)}`)
            .then((response) => response.json() as Promise<{
            status: string;
            expires_at?: string;
        }>);
    }
    async function bindSavedSession(state: Login): Promise<CommandEnvelope> {
        const bound = await backend.bindAgentAccount({ dashboard_auth_session_id: state.sessionID!, start_token: state.startToken! });
        if (bound.status !== 'authenticated')
            throw new Error('Agent binding did not complete');
        rmSync(authStatePath(baseURL, env, purpose), { force: true });
        return authenticatedEnvelope(env, bound.phone_verified === true);
    }
    if (action === 'login') {
        {
            const open = read(baseURL, env, purpose);
            if (open?.sessionID && open.pollToken && open.startToken) {
                try {
                    const current = await pollOpenSession(open);
                    // AUTH02: a completed-but-unbound session binds in place; never
                    // create a second auth session for the same login.
                    if (current.status === 'completed')
                        return await bindSavedSession(open);
                    if ((ACTIVE_SESSION_STAGES as readonly string[]).includes(current.status)) {
                        const url = open.authURL ?? '';
                        const qr = url ? await officialLoginCard(open.sessionID!, open.startToken!) : undefined;
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
                                ...(qr?.ok && qr.attach ? { qr_local_path: qr.attach.localPath, markdown: `![ItPay 官方授权卡](${qr.attach.localPath})` } : {image_status: "unavailable"}),
                                purpose: "login",
                            },
                            instruction: `${stageInstruction(current.status)} 沿用同一链接或二维码；不要生成新请求。`,
                            next: { command: 'itpay auth status --json', reason: '用户完成页面登录后确认绑定', poll_after_ms: 5000 },
                            recovery: [],
                        };
                    }
                    const terminal = TERMINAL_SESSION_STATES[current.status];
                    if (terminal) {
                        rmSync(authStatePath(baseURL, env, purpose), { force: true });
                        // Fall through to a fresh session only after a definitive
                        // terminal state; anything else keeps the stored session.
                    }
                    else {
                        return authStatusUnknown(open.sessionID);
                    }
                }
                catch (error) {
                    if (error instanceof AuthRequestError && (error.httpStatus === 404 || error.httpStatus === 410)) {
                        rmSync(authStatePath(baseURL, env, purpose), { force: true });
                        // The explicit login call may open one fresh session now. Status
                        // remains read-only and still reports the missing old session.
                    }
                    else {
                        return authStatusUnknown(open.sessionID, error);
                    }
                }
            }
        }
        const response = await request('/v1/dashboard/auth-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ return_to: '/' }) });
        const result = await response.json() as {
            dashboard_auth_session_id: string;
            start_url: string;
            poll_token: string;
            expires_at?: string;
        };
        const url = new URL(result.start_url, baseURL);
        const sameOrigin = url.origin === new URL(baseURL).origin;
        const alipay = url.origin === 'https://openauth.alipay.com' && url.pathname === '/oauth2/publicAppAuthorize.htm' && !url.username && !url.password;
        const local = response.headers.get('X-ItPay-Environment') === 'local_simulation'
            && new URL(baseURL).protocol === 'http:' && new URL(baseURL).hostname === '127.0.0.1'
            && url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password;
        if (!sameOrigin && !alipay && !local)
            throw new Error('Unexpected authorization origin');
        const fragment = new URLSearchParams(url.hash.replace(/^#dashboard-auth\?/, ''));
        const state = url.searchParams.get('state')?.split('.');
        const startToken = alipay
            ? (state?.length === 2 && state[0] === result.dashboard_auth_session_id ? state[1] : undefined)
            : url.searchParams.get('start_token') || fragment.get('start_token');
        if (!startToken || !result.poll_token || !result.dashboard_auth_session_id)
            throw new Error('Incomplete authorization response');
        save({ baseURL, sessionID: result.dashboard_auth_session_id, pollToken: result.poll_token, startToken, authURL: url.href }, env, purpose);
        {
            const qr = await officialLoginCard(result.dashboard_auth_session_id, startToken);
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
                    ...(qr?.ok && qr.attach ? { qr_local_path: qr.attach.localPath, markdown: `![ItPay 官方授权卡](${qr.attach.localPath})` } : {image_status: "unavailable"}),
                                purpose: "login",
                },
                instruction: '展示官方授权卡及原官方链接；图片不可用时只展示原链接，不自行编码二维码。用户在页面内选择手机号验证码、邮箱或钱包完成登录；不要替用户输入手机号或验证码，start_token 不要写入聊天记录或日志。',
                next: { command: 'itpay auth status --json', reason: '用户完成页面登录后确认绑定', poll_after_ms: 5000 },
                recovery: [],
            };
        }
        return { status: 'authorization_required', authorization_url: url.href, instruction: `Complete ItPay login in the browser, then run ${command}.` };
    }
    const state = read(baseURL, env, purpose);
    if (!state?.sessionID || !state.pollToken || !state.startToken) {
        return {
            status: 'login_required',
            result: {},
            instruction: '当前设备尚未绑定账号，也没有进行中的授权请求。需要时运行 itpay auth login 发起官方登录。',
            next: { command: 'itpay auth login --json', reason: '需要账号绑定时发起官方授权' },
            recovery: [],
        };
    }
    let progress: {
        status: string;
        expires_at?: string;
    };
    try {
        progress = await pollOpenSession(state);
    }
    catch (error) {
        if (error instanceof AuthRequestError && (error.httpStatus === 404 || error.httpStatus === 410)) {
            return sessionGone(env, purpose, baseURL, state.sessionID);
        }
        return authStatusUnknown(state.sessionID, error);
    }
    if (progress.status !== 'completed') {
        {
            const terminal = TERMINAL_SESSION_STATES[progress.status];
            if (terminal) {
                rmSync(authStatePath(baseURL, env, purpose), { force: true });
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
    {
        try {
            return await bindSavedSession(state);
        }
        catch (error) {
            if (error instanceof AuthRequestError)
                throw error;
            // Binding outcome unknown: keep the session so a retry can still bind
            // the same completed login instead of creating a new one.
            return authStatusUnknown(state.sessionID, error);
        }
    }
}
