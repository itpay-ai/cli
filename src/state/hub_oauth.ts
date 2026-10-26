// `itpay api connect` — one browser OAuth/PKCE authorization binds this CLI
// profile to a Hub account session (A03/F-R11). The access token is stored
// 0600 under the hub-credentials profile; refresh tokens let the CLI keep
// the connection alive without re-login. Secrets never hit argv/stdout.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface HubOAuthConfig {
  authorizeURL: string;   // e.g. http://localhost:24444/oauth2/auth
  tokenURL: string;       // e.g. http://localhost:24444/oauth2/token
  clientID: string;       // public client, e.g. itpay-cli-local
  resource: string;       // hub base URL (RFC8707 audience)
  scope: string;          // e.g. "openid itpay.hub"
}

export function hubOAuthConfig(env: NodeJS.ProcessEnv = process.env): HubOAuthConfig {
  const issuer = (env.ITPAY_HUB_OAUTH_ISSUER ?? "http://localhost:24444").replace(/\/+$/, "");
  return {
    authorizeURL: `${issuer}/oauth2/auth`,
    tokenURL: `${issuer}/oauth2/token`,
    clientID: env.ITPAY_HUB_OAUTH_CLIENT ?? "itpay-cli-local",
    resource: (env.ITPAY_HUB_URL ?? "http://localhost:18090").replace(/\/+$/, ""),
    scope: env.ITPAY_HUB_OAUTH_SCOPE ?? "openid offline_access itpay.hub",
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface ConnectResult {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresIn: number;
}

// runConnectFlow starts a loopback listener, returns the authorize URL for
// the caller to present, and resolves with exchanged tokens after the user
// approves in the browser.
export async function runConnectFlow(cfg: HubOAuthConfig, timeoutMs = 300_000): Promise<{ authorizeURL: string; done: Promise<ConnectResult> }> {
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  const server = createServer();
  const done = new Promise<ConnectResult>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("connect timed out waiting for browser authorization"));
    }, timeoutMs);
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const finish = (ok: boolean, msg: string) => {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>ItPay</title><body style="font-family:system-ui;padding:3em;text-align:center"><h2>${msg.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")}</h2><p>可以关闭此页面，回到终端继续。</p></body>`);
      };
      (async () => {
        if (u.pathname !== "/callback") return finish(false, "无效的回调");
        if (u.searchParams.get("state") !== state) return finish(false, "state 不匹配");
        if (u.searchParams.get("error")) {
          clearTimeout(timer); server.close(); finish(false, "授权被拒绝"); reject(new Error("authorization_required: consent denied")); return;
        }
        const code = u.searchParams.get("code");
        if (!code) { clearTimeout(timer); server.close(); finish(false,"缺少 code"); reject(new Error("missing code")); return; }
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
          client_id: cfg.clientID,
          code_verifier: verifier,
          resource: cfg.resource,
        });
        const tok = await fetch(cfg.tokenURL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
          signal: AbortSignal.timeout(10_000),
        });
        if (!tok.ok) { clearTimeout(timer); server.close(); finish(false,"token 交换失败"); reject(new Error(`token endpoint ${tok.status}`)); return; }
        const t = await tok.json() as { access_token: string; refresh_token?: string; expires_in: number };
        clearTimeout(timer);
        server.close();
        finish(true, "ItPay 已连接");
        resolvePromise({ accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in });
      })().catch((e) => {
        clearTimeout(timer);
        server.close();
        reject(e);
      });
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const port = (server.address() as AddressInfo).port;
  const authorizeURL = `${cfg.authorizeURL}?` + new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientID,
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    scope: cfg.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: cfg.resource,
  }).toString();
  return { authorizeURL, done };
}
