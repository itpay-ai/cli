export interface HubOAuthConfig {
  tokenURL: string;       // e.g. http://localhost:24444/oauth2/token
  clientID: string;       // public client, e.g. itpay-cli-local
  resource: string;       // hub base URL (RFC8707 audience)
  scope: string;          // e.g. "openid itpay.hub"
}

export function hubOAuthConfig(env: NodeJS.ProcessEnv = process.env): HubOAuthConfig {
  // An explicitly selected official dev Hub has one canonical issuer.
  // Do not infer API identity from the independent Services environment.
  const devHub=(env.ITPAY_HUB_URL??"").replace(/\/+$/,"")==="https://dev.itpay.ai";
  const issuer = (env.ITPAY_HUB_OAUTH_ISSUER ?? (devHub?"https://auth-v4-dev.itpay.ai":"http://localhost:24444")).replace(/\/+$/, "");
  return {
    tokenURL: `${issuer}/oauth2/token`,
    clientID: env.ITPAY_HUB_OAUTH_CLIENT ?? "itpay-cli-local",
    resource: (env.ITPAY_HUB_URL ?? "http://localhost:18090").replace(/\/+$/, ""),
    scope: env.ITPAY_HUB_OAUTH_SCOPE ?? "openid offline_access itpay.hub",
  };
}

export interface ConnectResult {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresIn: number;
}
