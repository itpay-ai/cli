// Hub credential profiles (A03/F01): a developer key is imported ONCE via
// hidden stdin — never argv, never stdout, never logs — and stored under
// 0600 per environment. Env vars remain an explicit override only.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withAsyncFileLock, withFileLock } from "./file_lock.js";
import { hubOAuthConfig } from "./hub_oauth.js";
import { homedir } from "node:os";

interface HubCredentialsFile {
  schema_version: "itpay.hub_credentials.v1";
  profiles: Record<string, {
    base_url: string;
    selected_credential?: "api_key" | "oauth";
    key_prefix?: string | undefined;
    api_key?: string | undefined;
    access_token?: string | undefined;
    refresh_token?: string | undefined;
    expires_at?: string | undefined;
    refresh_after?: string | undefined;
    subject?: string | undefined;
    consumer_id?: string | undefined;
    device_approval_id?: string;
    authorization_id?: string;
    token_url?: string | undefined;
    client_id?: string | undefined;
    identity_verification_pending?: boolean;
    created_at: string;
  }>;
}

export function hubCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.ITPAY_STATE_DIR ? resolve(env.ITPAY_STATE_DIR) : resolve(env.HOME || homedir(), ".itpay-v3");
  const suffix = createHash("sha256").update(env.ITPAY_HUB_URL ?? "http://localhost:18090").digest("hex").slice(0, 12);
  return resolve(dir, `hub-credentials.${suffix}.json`);
}

function importHubKeyUnlocked(apiKey: string, baseURL: string, env: NodeJS.ProcessEnv = process.env): { key_prefix: string } {
  if (!/^itk_[A-Za-z0-9_-]{8,}$/.test(apiKey)) {
    throw new Error("invalid key format — expected an itk_ API key");
  }
  const path = hubCredentialsPath(env);
  const file = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as HubCredentialsFile
    : { schema_version: "itpay.hub_credentials.v1" as const, profiles: {} };
  file.profiles["default"] = {
    ...file.profiles.default, selected_credential: "api_key",
    base_url: baseURL, key_prefix: apiKey.slice(0, 14), api_key: apiKey,
    created_at: new Date().toISOString(),
  };
  saveHubProfileUnlocked(file.profiles["default"]!, env);
  return { key_prefix: apiKey.slice(0, 14) };
}

// Stored credential fallback — env vars (explicit overrides) win.
export function storedHubKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = hubCredentialsPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as HubCredentialsFile;
    return file.profiles["default"]?.api_key;
  } catch {
    return undefined;
  }
}

export function storedHubKeyPrefix(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = hubCredentialsPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as HubCredentialsFile;
    return file.profiles["default"]?.key_prefix;
  } catch {
    return undefined;
  }
}

// Store a connected OAuth session as the default profile (0600).
function storeHubSessionUnlocked(accessToken: string, refreshToken: string | undefined, expiresIn: number, subject: string | undefined, baseURL: string, env: NodeJS.ProcessEnv = process.env, consumerID?: string, device?: { device_approval_id: string; authorization_id: string }): void {
  const path = hubCredentialsPath(env);
  const file = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as HubCredentialsFile
    : { schema_version: "itpay.hub_credentials.v1" as const, profiles: {} };
  const issuedAt = Date.now();
  const margin = Math.min(30_000, Math.max(100, expiresIn * 100));
  file.profiles["default"] = {
    ...(file.profiles.default?.api_key ? {api_key:file.profiles.default.api_key,key_prefix:file.profiles.default.key_prefix} : {}),
    selected_credential: "oauth",
    base_url: baseURL,
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    expires_at: new Date(issuedAt + expiresIn * 1000).toISOString(),
    refresh_after: new Date(issuedAt + expiresIn * 1000 - margin).toISOString(),
    ...(subject ? { subject } : {}),
    consumer_id: consumerID ?? `oauth:${hubOAuthConfig(env).clientID}`,
    client_id: hubOAuthConfig(env).clientID,
    token_url: hubOAuthConfig(env).tokenURL,
    ...(device ?? {}),
    created_at: new Date().toISOString(),
  };
  saveHubProfileUnlocked(file.profiles["default"]!, env);
}

type HubProfile = HubCredentialsFile["profiles"][string];

// Same lock and atomic replacement for connected, pending and verified profiles.
function saveHubProfileUnlocked(profile: HubProfile, env: NodeJS.ProcessEnv): void {
  const path = hubCredentialsPath(env);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const file: HubCredentialsFile = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8")) as HubCredentialsFile
      : { schema_version: "itpay.hub_credentials.v1", profiles: {} };
    file.profiles.default = profile;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    // A successful issuer rotation cannot be undone by a failed local write.
    // Do not print credentials, automatically retry, or suggest another identity.
    throw new Error("credential_persistence_failed: could not save the original connection; stop and check private storage before retrying");
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or no temporary file */ }
  }
}

export async function probeHubIdentity(resource: string, accessToken: string): Promise<{ buyer_id?: string; consumer_id?: string; device_approval_id?: string; authorization_id?: string }> {
  let response: Response;
  try {
    response = await fetch(`${resource}/v1/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-ItPay-OAuth-Resource": resource },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("connection_verification_pending: identity check unavailable; preserve the original connection and references, do not reconnect");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("authorization_required: original connection identity rejected");
    throw new Error("connection_verification_pending: identity check unavailable; preserve the original connection and references, do not reconnect");
  }
  try {
    const identity: unknown = await response.json();
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error();
    const me = identity as { buyer_id?: unknown; consumer_id?: unknown; device_approval_id?: unknown; authorization_id?: unknown };
    if (typeof me.buyer_id !== "string" || !me.buyer_id || typeof me.consumer_id !== "string" || !me.consumer_id) throw new Error();
    return { buyer_id: me.buyer_id, consumer_id: me.consumer_id,
      ...(typeof me.device_approval_id === "string" ? { device_approval_id: me.device_approval_id } : {}),
      ...(typeof me.authorization_id === "string" ? { authorization_id: me.authorization_id } : {}),
    };
  } catch {
    throw new Error("connection_verification_pending: identity response invalid; preserve the original connection and references, do not reconnect");
  }
}

// Stored bearer token — a connected session credential.
export function storedHubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = hubCredentialsPath(env);
  if (!existsSync(path) || existsSync(path+".recovery.json")) return undefined;
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as HubCredentialsFile;
    const p = file.profiles["default"];
    if (!p?.access_token || p.identity_verification_pending) return undefined;
    if (p.expires_at && Date.parse(p.expires_at) <= Date.now()) return undefined;
    return p.access_token;
  } catch {
    return undefined;
  }
}


export function storedHubProfile(env: NodeJS.ProcessEnv = process.env): HubCredentialsFile["profiles"][string] | undefined {
 const path = hubCredentialsPath(env);
 if (!existsSync(path)) return undefined;
 // Corrupt credentials must not silently fall back to another identity.
 return (JSON.parse(readFileSync(path, "utf8")) as HubCredentialsFile).profiles.default;
}

// Select once for HTTP and local task scope. Never silently substitute an identity.
export function hubCredentialKind(env: NodeJS.ProcessEnv = process.env): "api_key" | "oauth" | "none" {
 if(env.ITPAY_HUB_KEY && env.ITPAY_HUB_TOKEN)throw new Error("credential_conflict: select one explicit API credential; do not combine Key and OAuth env overrides");
 if(env.ITPAY_HUB_KEY)return "api_key";
 if(env.ITPAY_HUB_TOKEN)return "oauth";
 const p=storedHubProfile(env);
 if(p?.selected_credential==="api_key" && p.api_key)return "api_key";
 return p?.access_token ? "oauth" : p?.api_key ? "api_key" : "none";
}

export async function connectedHubToken(env: NodeJS.ProcessEnv = process.env, rejectedToken?: string): Promise<string> {
 return withAsyncFileLock(`${hubCredentialsPath(env)}.refresh.lock`, async () => {
  if (existsSync(hubCredentialsPath(env)+".recovery.json")) throw new Error("connection_verification_pending: original recovery pending; only api connect may verify its original candidate, no business retry");
  const p = storedHubProfile(env);
  if (!p?.access_token || !p.subject) throw new Error("authorization_required: reconnect ItPay");
  const cfg = hubOAuthConfig(env);
  if (p.base_url !== cfg.resource || p.token_url !== cfg.tokenURL || p.client_id !== cfg.clientID || !p.consumer_id) {
   throw new Error("authorization_required: connection configuration changed");
  }
  // No fast path may return an unverified rotation or a different binding.
  const refreshAt = p.refresh_after ? Date.parse(p.refresh_after) : Date.parse(p.expires_at ?? "") - 30_000;
  if (!p.identity_verification_pending && p.access_token !== rejectedToken && refreshAt > Date.now()) return p.access_token;
  let candidate = p;
  if (!p.identity_verification_pending || !(Date.parse(p.expires_at ?? "") > Date.now())) {
   if (!p.refresh_token) throw new Error("authorization_required: reconnect the original ItPay connection");
   let response: Response;
   try {
    response = await fetch(p.token_url, {
     method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
     body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.refresh_token, client_id: p.client_id, resource: cfg.resource }),
     signal: AbortSignal.timeout(10_000),
    });
   } catch {
    throw new Error("connection_verification_pending: refresh outcome unknown; preserve the original connection and references, do not repeat authorization or business requests");
   }
   if (!response.ok) {
    // Only an explicit credential rejection establishes the need for consent.
    let rejected = response.status === 401 || response.status === 403;
    if (response.status === 400) {
     try {
      const problem = await response.json() as { error?: string };
      rejected = ["invalid_grant", "invalid_client", "unauthorized_client"].includes(problem?.error ?? "");
     } catch { /* A malformed rejection is not proof of expired consent. */ }
    }
    if (rejected) throw new Error("authorization_required: connection refresh rejected");
    throw new Error("connection_verification_pending: refresh unavailable; preserve the original connection and references");
   }
   let token: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown };
   try { token = await response.json() as typeof token; }
   catch { throw new Error("connection_verification_pending: invalid refresh response; preserve the original connection and references"); }
   if (!token || typeof token.access_token !== "string" || !token.access_token || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer" || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || (!Number.isFinite(Date.now() + token.expires_in * 1000) || Date.now() + token.expires_in * 1000 > 8.64e15) || (token.refresh_token !== undefined && (typeof token.refresh_token !== "string" || !token.refresh_token))) {
    throw new Error("connection_verification_pending: invalid refresh response; preserve the original connection and references");
   }
   const now = Date.now();
   candidate = {
    ...p, access_token: token.access_token, refresh_token: token.refresh_token ?? p.refresh_token,
    expires_at: new Date(now + token.expires_in * 1000).toISOString(),
    refresh_after: new Date(now + token.expires_in * 1000 - Math.min(30_000, Math.max(100, token.expires_in * 100))).toISOString(),
    identity_verification_pending: true,
   };
   // Save the rotation before any fallible identity/network operation.
   saveHubProfileUnlocked(candidate, env);
  }
  const identity = await probeHubIdentity(cfg.resource, candidate.access_token!);
  if (identity.buyer_id !== p.subject || identity.consumer_id !== p.consumer_id ||
    (p.device_approval_id !== undefined && (identity.device_approval_id !== p.device_approval_id || identity.authorization_id !== p.authorization_id))) {
   throw new Error("authorization_required: refreshed identity changed");
  }
  if (!(Date.parse(candidate.expires_at ?? "") > Date.now())) {
   throw new Error("connection_verification_pending: token expired during identity check; preserve the original connection and references");
  }
  delete candidate.identity_verification_pending;
  saveHubProfileUnlocked(candidate, env);
  return candidate.access_token!;
 });
}

export function importHubKey(apiKey: string, baseURL: string, env: NodeJS.ProcessEnv = process.env): { key_prefix: string } {
 return withFileLock(`${hubCredentialsPath(env)}.refresh.lock`, () => importHubKeyUnlocked(apiKey, baseURL, env));
}
export function storeHubSession(accessToken: string, refreshToken: string | undefined, expiresIn: number, subject: string | undefined, baseURL: string, env: NodeJS.ProcessEnv = process.env, consumerID?: string): void {
 withFileLock(`${hubCredentialsPath(env)}.refresh.lock`, () => storeHubSessionUnlocked(accessToken, refreshToken, expiresIn, subject, baseURL, env, consumerID));
}

// Explicit original-connection recovery. Rotated credentials are quarantined
// separately until both the owner recovery and /me prove the exact old binding.
export async function recoverHubConnection(env: NodeJS.ProcessEnv = process.env): Promise<void> {
 await withOriginalHubCandidate(env);
}
export async function readOriginalHubReceipt(requestKey:string,env:NodeJS.ProcessEnv=process.env):Promise<unknown> {
 if(!requestKey || requestKey.length>512 || /[\r\n\0]/.test(requestKey)) throw new Error("receipt_denied: exact original request key required");
 return withOriginalHubCandidate(env,requestKey);
}
async function withOriginalHubCandidate(env:NodeJS.ProcessEnv,receiptRequest?:string):Promise<unknown> {
 return withAsyncFileLock(`${hubCredentialsPath(env)}.refresh.lock`,async()=>{
  const original=storedHubProfile(env),cfg=hubOAuthConfig(env);
  if (!original?.subject || !original.consumer_id || !original.refresh_token || original.api_key || original.base_url!==cfg.resource || original.client_id!==cfg.clientID || original.token_url!==cfg.tokenURL || env.ITPAY_HUB_KEY || env.ITPAY_HUB_TOKEN) throw new Error("connection_recovery_denied: original OAuth binding and refresh proof required; preserve profile and tasks");
  const path=hubCredentialsPath(env)+".recovery.json";
  const binding={base_url:original.base_url,subject:original.subject,consumer_id:original.consumer_id,client_id:original.client_id,token_url:original.token_url};
  type Pending={binding:typeof binding;phase:"refresh_unknown"|"candidate";profile?:HubProfile};
  const save=(pending:Pending)=>{
   const tmp=path+"."+randomUUID()+".tmp";
   try {writeFileSync(tmp,JSON.stringify(pending),{flag:"wx",mode:0o600});renameSync(tmp,path);} finally {try{unlinkSync(tmp)}catch{}}
  };
  let pending:Pending|undefined;
  let refreshSource=original;
  if(existsSync(path)) {
   try {pending=JSON.parse(readFileSync(path,"utf8")) as Pending;}catch{throw new Error("connection_recovery_denied: private recovery material unreadable; preserve original profile");}
   if(!pending || typeof pending!=="object" || JSON.stringify(pending.binding)!==JSON.stringify(binding)) throw new Error("connection_recovery_denied: recovery binding changed; preserve original profile");
   if(pending.phase!=="candidate" || !pending.profile) throw new Error("connection_verification_pending: refresh outcome unknown; preserve private recovery material, do not repeat refresh or connect");
   if(!Object.entries(binding).every(([k,v])=>(pending!.profile as unknown as Record<string,unknown>)[k]===v)) throw new Error("connection_recovery_denied: private candidate binding mismatch; preserve original profile");
  }
  if (!pending || !(Date.parse(pending.profile?.expires_at??"")>Date.now())) {
   refreshSource=pending?.profile??original;
   if(!refreshSource.refresh_token) throw new Error("connection_recovery_denied: original refresh proof unavailable; preserve profile and candidate");
   save({binding,phase:"refresh_unknown",profile:refreshSource});
   let response:Response;
   try {response=await fetch(cfg.tokenURL,{method:"POST",redirect:"error",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshSource.refresh_token,client_id:cfg.clientID,resource:cfg.resource}),signal:AbortSignal.timeout(10_000)});} catch {throw new Error("connection_verification_pending: refresh outcome unknown; preserve original profile and private recovery material");}
   if(!response.ok) {
    let rejected=response.status===401||response.status===403;
    if(response.status===400){try{const problem=await response.json() as {error?:string};rejected=["invalid_grant","invalid_client","unauthorized_client"].includes(problem?.error??"")}catch{}}
    if(rejected) throw new Error("connection_recovery_denied: original refresh proof rejected; preserve profile and tasks, do not create a replacement connection");
    throw new Error("connection_verification_pending: refresh unavailable or outcome unknown; preserve original profile and private recovery material");
   }
   let t:{access_token?:unknown;refresh_token?:unknown;token_type?:unknown;expires_in?:unknown};
   try {t=await response.json() as typeof t;}catch {throw new Error("connection_verification_pending: invalid refresh response; preserve private recovery material");}
   if(!t || typeof t!=="object" || typeof t.access_token!=="string" || !t.access_token || typeof t.token_type!=="string" || t.token_type.toLowerCase()!=="bearer" || typeof t.expires_in!=="number" || !Number.isFinite(t.expires_in) || t.expires_in<=0 || Date.now()+t.expires_in*1000>8.64e15 || (t.refresh_token!==undefined && (typeof t.refresh_token!=="string" || !t.refresh_token))) throw new Error("connection_verification_pending: invalid refresh response; preserve private recovery material");
   const now=Date.now();
   pending={binding,phase:"candidate",profile:{...original,access_token:t.access_token,refresh_token:(t.refresh_token as string|undefined)??refreshSource.refresh_token,expires_at:new Date(now+t.expires_in*1000).toISOString(),refresh_after:new Date(now+t.expires_in*1000-Math.min(30_000,Math.max(100,t.expires_in*100))).toISOString(),identity_verification_pending:true}};
   save(pending);
  }
  const candidate=pending!.profile!;
  if(!Object.entries(binding).every(([k,v])=>(candidate as unknown as Record<string,unknown>)[k]===v)) throw new Error("connection_recovery_denied: private candidate binding mismatch; preserve original profile");
  if(!candidate.access_token || !(Date.parse(candidate.expires_at??"")>Date.now())) throw new Error("connection_recovery_denied: recovery candidate expired; preserve private proof and request owner review");
  if(receiptRequest!==undefined) {
   // Only this GET may use the quarantined same-binding candidate. Keep the
   // operational profile and recovery file untouched after a successful read.
   let response:Response;
   try {response=await fetch(cfg.resource+"/v1/requests/"+encodeURIComponent(receiptRequest),{method:"GET",redirect:"error",headers:{Authorization:"Bearer "+candidate.access_token,"X-ItPay-OAuth-Resource":cfg.resource,"X-ItPay-Receipt-Only":"1","X-ItPay-Expected-Buyer":binding.subject,"X-ItPay-Expected-Consumer":binding.consumer_id},signal:AbortSignal.timeout(10_000)});}catch{throw new Error("receipt_unavailable: original receipt unavailable; preserve profile and private candidate");}
   if(!response.ok) throw new Error("receipt_denied: original receipt rejected; preserve profile and private candidate");
   const result=await response.json() as {request_id?:unknown;read_only?:unknown;run?:{run_id?:unknown}};
   if(result?.request_id!==receiptRequest || result.read_only!==true || typeof result.run?.run_id!=="string") throw new Error("receipt_denied: invalid original receipt reply");
   return result;
  }
  let response:Response;
  try {response=await fetch(cfg.resource+"/v1/connection/recover",{method:"POST",redirect:"error",headers:{"Content-Type":"application/json",Authorization:"Bearer "+candidate.access_token,"X-ItPay-OAuth-Resource":cfg.resource},body:JSON.stringify({expected_buyer_id:binding.subject,expected_consumer_id:binding.consumer_id}),signal:AbortSignal.timeout(10_000)});}catch {throw new Error("connection_verification_pending: recovery outcome unknown; preserve original profile and candidate; retry only this recovery, never business");}
  if(response.status===409) throw new Error("connection_recovery_conflict: another active connection requires owner review; preserve original profile, tasks and candidate");
  if(response.status>=500 || response.status===404 || response.status===405) throw new Error("connection_verification_pending: paired recovery owner unavailable; preserve profile and candidate");
  if(!response.ok) throw new Error("connection_recovery_denied: owner rejected original binding; preserve profile, tasks and private candidate");
  let result:{buyer_id?:unknown;consumer_id?:unknown;status?:unknown};
  try {result=await response.json() as typeof result;}catch{throw new Error("connection_verification_pending: recovery reply invalid; preserve original profile and candidate");}
  if(!result || typeof result!=="object" || result.buyer_id!==binding.subject || result.consumer_id!==binding.consumer_id || result.status!=="recovered") throw new Error("connection_recovery_denied: owner recovery binding mismatch; preserve original profile");
  const identity=await probeHubIdentity(cfg.resource,candidate.access_token);
  if(identity.buyer_id!==binding.subject || identity.consumer_id!==binding.consumer_id) throw new Error("connection_recovery_denied: verified original identity mismatch; preserve profile and tasks");
  if(!(Date.parse(candidate.expires_at??"")>Date.now())) throw new Error("connection_verification_pending: candidate expired during verification; preserve original profile");
  delete candidate.identity_verification_pending;
  saveHubProfileUnlocked(candidate,env);
  unlinkSync(path);
 });
}

// Exchange and replace credentials under the same lock used for refresh.
// Browser polling takes place outside this lock.
export async function finishHubDeviceSession(
  original: { buyer_id: string; consumer_id: string } | undefined,
  approved: { buyer_id: string; consumer_id: string; device_approval_id: string; authorization_id: string },
  resource: string,
  exchange: () => Promise<import("./hub_oauth.js").ConnectResult | "slow_down" | "authorization_pending" | "exchange_unknown">,
  env: NodeJS.ProcessEnv = process.env,
  event: (name: string) => void = () => {},
  allowMissingOriginal = false,
): Promise<"saved" | "slow_down" | "authorization_pending" | "exchange_unknown"> {
  return withAsyncFileLock(hubCredentialsPath(env) + ".refresh.lock", async () => {
    const current = storedHubProfile(env);
    if (existsSync(hubCredentialsPath(env) + ".recovery.json") ||
      (original ? !(allowMissingOriginal && !current) && (current?.subject !== original.buyer_id || current?.consumer_id !== original.consumer_id) : Boolean(current))) {
      throw new Error("connection_recovery_denied: original local connection changed during Device authorization");
    }
    const tokens = await exchange();
    if (typeof tokens === "string") return tokens;
    event("auth.device_exchanged");
    const me = await probeHubIdentity(resource, tokens.accessToken);
    if (me.buyer_id !== approved.buyer_id || me.consumer_id !== approved.consumer_id ||
      me.device_approval_id !== approved.device_approval_id || me.authorization_id !== approved.authorization_id) {
      throw new Error("connection_recovery_denied: verified Device identity does not match the approved account and consumer");
    }
    event("auth.identity_verified");
    storeHubSessionUnlocked(tokens.accessToken, tokens.refreshToken, tokens.expiresIn, me.buyer_id, resource, env, me.consumer_id, { device_approval_id: approved.device_approval_id, authorization_id: approved.authorization_id });
    event("auth.connected");
    return "saved";
  });
}
