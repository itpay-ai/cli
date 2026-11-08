// Thin API configuration adapter over the fixed-version @itpay/hub-client package.
// Package provenance is locked in dependencies/*.source.json.
import {
  HubClient as SdkHubClient,
  HubApiError,
  type EffectClass,
  type ServiceKind,
  type AdmissionRequest as SdkAdmissionRequest,
  type ContinueIntentResponse,
  type DiscoverItem,
  type DiscoverRequest,
  type DiscoverResponse,
  type Me,
  type OperationDescriptor,
  type RunAdmissionResponse,
  type RunReceipt,
  type RequestStatus,
  type TopUpOrder,
  type TopUpSKU,
  type Usage,
  type Wallet,
  type WalletTransaction,
} from "@itpay/hub-client";
import { HttpError } from "./http.js";
import { connectedHubToken, storedHubProfile, storedHubToken, storedHubKey, hubCredentialKind } from "../state/hub_credentials.js";

export { HubApiError };
export type AdmissionRequest=SdkAdmissionRequest&{shown_event_id?:string};

export type {
  EffectClass,
  ServiceKind,
  ContinueIntentResponse,
  DiscoverItem,
  DiscoverRequest,
  DiscoverResponse,
  Me,
  OperationDescriptor,
  RunAdmissionResponse,
  RunReceipt,
  RequestStatus,
  TopUpOrder,
  TopUpSKU,
  Wallet,
  WalletTransaction,
};

export interface HubConfig {
  sessionEnv?: NodeJS.ProcessEnv | undefined;
  baseURL: string;                    // e.g. http://localhost:18090
  bearerToken?: string | undefined;   // OAuth access token with hub audience
  apiKey?: string | undefined;        // X-ItPay-Key
}

export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const profile = storedHubProfile(env);
  const kind=hubCredentialKind(env);
  const explicit = Boolean(env.ITPAY_HUB_TOKEN || env.ITPAY_HUB_KEY);
  return {
    sessionEnv: kind==="oauth" && !explicit && profile?.access_token ? env : undefined,
    baseURL: (env.ITPAY_HUB_URL ?? "http://localhost:18090").replace(/\/+$/, ""),
    // One explicit credential selection is shared with local task ownership.
    bearerToken: kind==="oauth" ? env.ITPAY_HUB_TOKEN || storedHubToken(env) : undefined,
    apiKey: kind==="api_key" ? env.ITPAY_HUB_KEY || storedHubKey(env) : undefined,
  };
}

// R03: loadHubConfig selects one credential and rejects conflicting explicit overrides.
function toSdkConfig(cfg: HubConfig): { baseUrl: string; resource: string; token?: string; apiKeyHeader?: "X-ItPay-Key" | "Authorization" } {
  // REST calls must select the same OAuth resource as the original profile, including allowed aliases.
  const base = { baseUrl: cfg.baseURL, resource: cfg.baseURL.replace(/\/+$/, "") };
  if (cfg.bearerToken) {
    return { ...base, token: cfg.bearerToken };
  }
  if (cfg.apiKey) {
    return { ...base, token: cfg.apiKey, apiKeyHeader: "X-ItPay-Key" };
  }
  return base;
}

export class HubClient {
  private sdk: SdkHubClient;

  constructor(private readonly cfg: HubConfig) {
    this.sdk = new SdkHubClient(toSdkConfig(cfg));
  }

  shelfGet<T>(path: string): Promise<T> {
    return this.wrap(async () => {
      const token = this.cfg.sessionEnv ? storedHubProfile(this.cfg.sessionEnv)?.access_token : this.cfg.bearerToken;
      const headers: Record<string,string> = {"Accept":"application/json", "X-ItPay-OAuth-Resource":this.cfg.baseURL};
      if(token) headers.Authorization="Bearer "+token;
      else if(this.cfg.apiKey) headers["X-ItPay-Key"]=this.cfg.apiKey;
      let response:Response;
      try {response=await fetch(this.cfg.baseURL+path,{headers,redirect:"error",signal:AbortSignal.timeout(10_000)});}
      catch(error){
        const timeout=error instanceof Error && ["AbortError","TimeoutError"].includes(error.name);
        throw new HttpError(0,{code:timeout?"request_timeout":"network_error",
          message:timeout?"catalog metadata read timed out":"catalog metadata unavailable"},"Hub metadata read failed");
      }
      const body=await response.json();
      if(!response.ok) {
        const problem=body as {error?:{code?:unknown;message?:unknown}};
        throw new HubApiError(response.status,{error:{
          code:typeof problem?.error?.code==="string"?problem.error.code:"invalid_response",
          message:typeof problem?.error?.message==="string"?problem.error.message:"catalog response unavailable"}});
      }
      return body as T;
    });
  }

  adminTool(action: string,args: Record<string, unknown>){return this.wrap(()=>this.sdk.adminTool(action,args));}
  discover(query: DiscoverRequest): Promise<DiscoverResponse> {
    return this.wrap(() => this.sdk.discover(query));
  }
  inspect(operationID: string): Promise<OperationDescriptor> {
    return this.wrap(() => this.sdk.inspect(operationID));
  }
  run(operationID: string, admission: AdmissionRequest, idempotencyKey: string): Promise<RunAdmissionResponse> {
    return this.wrap(() => this.sdk.run(operationID, admission, idempotencyKey));
  }
  runStatus(runID: string): Promise<RunReceipt> {
    return this.wrap(() => this.sdk.getRun(runID));
  }
  getRequest(requestID: string): Promise<RequestStatus> {
    return this.wrap(() => this.sdk.getRequest(requestID));
  }
  continueIntent(intentID: string, idempotencyKey: string): Promise<ContinueIntentResponse> {
    return this.wrap(() => this.sdk.continueIntent(intentID, idempotencyKey));
  }
  me(): Promise<Me> {
    return this.wrap(() => this.sdk.me());
  }
  usage(): Promise<Usage> {
    return this.wrap(() => this.sdk.usage());
  }
  wallet(): Promise<Wallet> {
    return this.wrap(() => this.sdk.wallet());
  }
  walletTransactions(): Promise<{ items: WalletTransaction[]; next_cursor?: string | undefined }> {
    return this.wrap(async()=>{const result=await this.sdk.walletTransactions();return {...result,items:result.items??[]}});
  }
  getAPIPaymentRequest(intentID:string){return this.wrap(()=>this.sdk.getAPIPaymentRequest(intentID));}
  topupSkus(): Promise<{ items: TopUpSKU[] }> {
    return this.wrap(() => this.sdk.topupSkus());
  }
  createTopup(body: ({ sku_id: string; payer_currency: string } | {amount_cny:string;payer_currency?:"CNY"}) & { continuation_id?: string;channel?:string;mode?:string }, idempotencyKey: string): Promise<TopUpOrder> {
    return this.wrap(() => this.sdk.createTopup(body, idempotencyKey));
  }
  topupChannels(currency: "CNY"|"USD"="CNY") {return this.wrap(()=>this.sdk.topupChannels(currency));}
  topupStatus(topupID: string): Promise<TopUpOrder> {
    return this.wrap(() => this.sdk.getTopup(topupID));
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      let token: string | undefined;
      if (this.cfg.sessionEnv) {
        token = await connectedHubToken(this.cfg.sessionEnv);
        this.sdk = new SdkHubClient(toSdkConfig({ ...this.cfg, bearerToken: token }));
      }
      try { return await fn(); }
      catch (err) {
        if (!(err instanceof HubApiError) || err.status !== 401 || err.envelope.error.code !== "unauthenticated" || !this.cfg.sessionEnv || !token) throw err;
        // Authentication failed before admission. Keep the same SDK call,
        // body and idempotency key; never retry transport or unknown outcomes.
        const refreshed = await connectedHubToken(this.cfg.sessionEnv, token);
        this.sdk = new SdkHubClient(toSdkConfig({ ...this.cfg, bearerToken: refreshed }));
        return await fn();
      }
    } catch (err) {
      if (err instanceof HubApiError) {
        throw new HttpError(err.status, {
          code: err.envelope.error.code,
          message: err.envelope.error.message,
          ...safeDetailsPayload(err.envelope.error.details),
        }, `hub request failed`);
      }
      throw err;
    }
  }
}


export interface PublicPriceChange { current_publication_id?:string; current_price?:{currency:"CNY";scale:6;amount_atoms:string};captured_atoms?:"0";held_atoms?:"0" }
export function safePriceChange(raw:unknown):PublicPriceChange|undefined {
 if(!raw || typeof raw!=="object")return undefined;
 const d=raw as Record<string,unknown>,p=d.current_price as Record<string,unknown>|undefined;
 const out:PublicPriceChange={};
 if(typeof d.current_publication_id==="string" && /^[A-Za-z0-9_-]{1,200}$/.test(d.current_publication_id))out.current_publication_id=d.current_publication_id;
 if(p?.currency==="CNY" && p.scale===6 && typeof p.amount_atoms==="string" && /^[0-9]{1,19}$/.test(p.amount_atoms))out.current_price={currency:"CNY",scale:6,amount_atoms:p.amount_atoms};
 if(d.captured_atoms==="0" && d.held_atoms==="0"){out.captured_atoms="0";out.held_atoms="0"}
 return Object.keys(out).length?out:undefined;
}
export interface SafeHubErrorDetails { price_change?:PublicPriceChange; stage?: "metadata" | "status" | "action"; method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"; path?: string }

// SDK diagnostics are useful, but neither arbitrary detail fields nor raw path
// parameters/query strings belong in an agent-visible error.
export function safeHubErrorDetails(raw: unknown): SafeHubErrorDetails | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const d = raw as Record<string, unknown>;
  const out: SafeHubErrorDetails = {};
  const price=safePriceChange(d.price_change);if(price)out.price_change=price;
  if (d.stage === "metadata" || d.stage === "status" || d.stage === "action") out.stage = d.stage;
  if (typeof d.method === "string" && ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(d.method)) out.method = d.method as NonNullable<SafeHubErrorDetails["method"]>;
  if (typeof d.path === "string") {
    const path = d.path.split(/[?#]/, 1)[0]!;
    const routes: Array<[RegExp, string]> = [
      [/^\/v1\/operations\/[^/\s]+\/runs$/, "/v1/operations/{operation_id}/runs"],
      [/^\/v1\/operations\/[^/\s]+$/, "/v1/operations/{operation_id}"],
      [/^\/v1\/requests\/[^/\s]+$/, "/v1/requests/{request_id}"],
      [/^\/v1\/runs\/[^/\s]+$/, "/v1/runs/{run_id}"],
      [/^\/v1\/intents\/[^/\s]+\/continue$/, "/v1/intents/{intent_id}/continue"],
    ];
    const matched = routes.find(([pattern]) => pattern.test(path));
    if (matched) out.path = matched[1];
    else if (["/v1/discover", "/v1/me", "/v1/me/wallet", "/v1/me/usage"].includes(path)) out.path = path;
  }
  return Object.keys(out).length ? out : undefined;
}
function safeDetailsPayload(raw: unknown): {details?: SafeHubErrorDetails} {
  const details = safeHubErrorDetails(raw);
  return details ? {details} : {};
}
export function hubErrorDetails(error: unknown): SafeHubErrorDetails | undefined {
  if (error instanceof HttpError) return safeHubErrorDetails((error.payload as unknown as Record<string, unknown> | undefined)?.details);
  if (error && typeof error === "object" && "details" in error) return safeHubErrorDetails(error.details);
  return undefined;
}
