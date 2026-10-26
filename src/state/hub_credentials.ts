// Hub credential profiles (A03/F01): a developer key is imported ONCE via
// hidden stdin — never argv, never stdout, never logs — and stored under
// 0600 per environment. Env vars remain an explicit override only.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withAsyncFileLock, withFileLock } from "./file_lock.js";
import { hubOAuthConfig } from "./hub_oauth.js";
import { homedir } from "node:os";

interface HubCredentialsFile {
  schema_version: "itpay.hub_credentials.v1";
  profiles: Record<string, {
    base_url: string;
    key_prefix?: string | undefined;
    api_key?: string | undefined;
    access_token?: string | undefined;
    refresh_token?: string | undefined;
    expires_at?: string | undefined;
    refresh_after?: string | undefined;
    subject?: string | undefined;
    consumer_id?: string | undefined;
    token_url?: string | undefined;
    client_id?: string | undefined;
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
    base_url: baseURL, key_prefix: apiKey.slice(0, 14), api_key: apiKey,
    created_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
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
function storeHubSessionUnlocked(accessToken: string, refreshToken: string | undefined, expiresIn: number, subject: string | undefined, baseURL: string, env: NodeJS.ProcessEnv = process.env, consumerID?: string): void {
  const path = hubCredentialsPath(env);
  const file = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as HubCredentialsFile
    : { schema_version: "itpay.hub_credentials.v1" as const, profiles: {} };
  const issuedAt = Date.now();
  const margin = Math.min(30_000, Math.max(100, expiresIn * 100));
  file.profiles["default"] = {
    base_url: baseURL,
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    expires_at: new Date(issuedAt + expiresIn * 1000).toISOString(),
    refresh_after: new Date(issuedAt + expiresIn * 1000 - margin).toISOString(),
    ...(subject ? { subject } : {}),
    consumer_id: consumerID ?? `oauth:${hubOAuthConfig(env).clientID}`,
    client_id: hubOAuthConfig(env).clientID,
    token_url: hubOAuthConfig(env).tokenURL,
    created_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

// Stored bearer token — a connected session credential.
export function storedHubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = hubCredentialsPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as HubCredentialsFile;
    const p = file.profiles["default"];
    if (!p?.access_token) return undefined;
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

export async function connectedHubToken(env: NodeJS.ProcessEnv = process.env, rejectedToken?: string): Promise<string> {
 return withAsyncFileLock(`${hubCredentialsPath(env)}.refresh.lock`, async () => {
  const p = storedHubProfile(env);
  if (!p?.access_token || !p.subject) throw new Error("authorization_required: reconnect ItPay");
  // Share a still-fresh rotation across processes, including short-lived tokens.
  // A 401 only forces rotation if no other process already replaced that token.
  const refreshAt = p.refresh_after ? Date.parse(p.refresh_after) : Date.parse(p.expires_at ?? "") - 30_000;
  if (p.access_token !== rejectedToken && refreshAt > Date.now()) return p.access_token;
  const cfg = hubOAuthConfig(env);
  if (!p.refresh_token || p.base_url !== cfg.resource || p.token_url !== cfg.tokenURL || p.client_id !== cfg.clientID) {
   throw new Error("authorization_required: connection configuration changed");
  }
  const response = await fetch(p.token_url, {
   method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
   body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.refresh_token, client_id: p.client_id, resource: cfg.resource }),
   signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("authorization_required: connection refresh rejected");
  const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string };
  if (!token.access_token || token.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(token.expires_in) || token.expires_in! <= 0) {
   throw new Error("authorization_required: invalid refresh response");
  }
  const who = await fetch(`${cfg.resource}/v1/me`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!who.ok) throw new Error("authorization_required: refreshed identity rejected");
  const identity = await who.json() as { buyer_id?: string; consumer_id?: string };
  if (identity.buyer_id !== p.subject || (identity.consumer_id && identity.consumer_id !== p.consumer_id)) {
   throw new Error("authorization_required: refreshed identity changed");
  }
  storeHubSessionUnlocked(token.access_token, token.refresh_token ?? p.refresh_token, token.expires_in!, p.subject, cfg.resource, env, p.consumer_id);
  return token.access_token;
 });
}

export function importHubKey(apiKey: string, baseURL: string, env: NodeJS.ProcessEnv = process.env): { key_prefix: string } {
 return withFileLock(`${hubCredentialsPath(env)}.refresh.lock`, () => importHubKeyUnlocked(apiKey, baseURL, env));
}
export function storeHubSession(accessToken: string, refreshToken: string | undefined, expiresIn: number, subject: string | undefined, baseURL: string, env: NodeJS.ProcessEnv = process.env, consumerID?: string): void {
 withFileLock(`${hubCredentialsPath(env)}.refresh.lock`, () => storeHubSessionUnlocked(accessToken, refreshToken, expiresIn, subject, baseURL, env, consumerID));
}
