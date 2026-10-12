import { rmSync } from 'node:fs';
import { authStatePath, readAuthState, saveAuthState } from '../state/auth_storage.js';
export function sellerAuthPath(baseURL:string,env=process.env,purpose="seller"):string{return authStatePath(baseURL,env,purpose);}
export function sellerSessionToken(baseURL:string,env=process.env):string|undefined{
 const state=readAuthState(baseURL,env,"seller");
 return state?.expiresAt && Date.parse(state.expiresAt)>Date.now()?state.sessionToken:undefined;
}
export async function sellerAuth(action:'login'|'status'|'logout',baseURL:string,env=process.env,fetcher:typeof fetch=fetch):Promise<unknown>{
 const purpose="seller";
 const command="itpay sell auth status";
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetcher(baseURL + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error( `ItPay authorization failed (${response.status}); retry login if expired`);
    return response;
  }

 if(action==='logout'){
  const token=sellerSessionToken(baseURL,env);
  if(token)await request('/v1/me/logout',{method:'POST',headers:{Authorization:`Bearer ${token}`}});
  rmSync(sellerAuthPath(baseURL,env),{force:true});return {status:'logged_out'};
 }
 if(action==='login'){
    const response = await request('/v1/dashboard/auth-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ return_to: '/seller' }) });
    const result = await response.json() as { dashboard_auth_session_id: string; start_url: string; poll_token: string; expires_at?: string };
    const url = new URL(result.start_url, baseURL);
    const sameOrigin = url.origin === new URL(baseURL).origin;
    const alipay = url.origin === 'https://openauth.alipay.com' && url.pathname === '/oauth2/publicAppAuthorize.htm' && !url.username && !url.password;
    const local = response.headers.get('X-ItPay-Environment') === 'local_simulation'
      && new URL(baseURL).protocol === 'http:' && new URL(baseURL).hostname === '127.0.0.1'
      && url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password;
    if (!sameOrigin && !alipay && !local) throw new Error('Unexpected authorization origin');
    const fragment = new URLSearchParams(url.hash.replace(/^#dashboard-auth\?/, ''));
    const state = url.searchParams.get('state')?.split('.');
    const startToken = alipay
      ? (state?.length === 2 && state[0] === result.dashboard_auth_session_id ? state[1] : undefined)
      : url.searchParams.get('start_token') || fragment.get('start_token');
    if (!startToken || !result.poll_token || !result.dashboard_auth_session_id) throw new Error('Incomplete authorization response');
    saveAuthState({ baseURL, sessionID: result.dashboard_auth_session_id, pollToken: result.poll_token, startToken, authURL: url.href }, env, purpose);
    return { status: 'authorization_required', authorization_url: url.href, instruction: `Complete ItPay login in the browser, then run ${command}.` };
 }
 const state=readAuthState(baseURL,env,"seller");
 if(sellerSessionToken(baseURL,env))return {status:'authenticated',base_url:baseURL,expires_at:state?.expiresAt};
 if(!state?.sessionID || !state.pollToken || !state.startToken)return {status:'login_required'};
 const progress=await (await request(`/v1/dashboard/auth-sessions/${encodeURIComponent(state.sessionID)}?poll_token=${encodeURIComponent(state.pollToken)}`)).json() as {status:string};
 if(progress.status!=='completed')return {status:progress.status,instruction:'Finish login and email verification in the browser.'};
  const claimed = await request(`/v1/dashboard/auth-sessions/${encodeURIComponent(state.sessionID)}/claim?start_token=${encodeURIComponent(state.startToken)}`, { method: 'POST' });
  const token = /(?:^|[, ]+)itpay_buyer_session=([^;]+)/.exec(claimed.headers.get('set-cookie') ?? '')?.[1];
  const session = await claimed.json() as { expires_at?: string };
  if (!token || !session.expires_at || !(Date.parse(session.expires_at) > Date.now())) throw new Error('Incomplete Seller session');
  saveAuthState({ baseURL, sessionToken: token, expiresAt: session.expires_at }, env,"seller");
  return { status: 'authenticated', base_url: baseURL, expires_at: session.expires_at };
}
