// Thin API configuration adapter over the fixed-version @itpay/hub-client package.
// Package provenance is locked in dependencies/*.source.json.
import {
  HubClient as SdkHubClient,
  HubApiError,
  type EffectClass,
  type ServiceKind,
  type AdmissionRequest,
  type ContinueIntentResponse,
  type DiscoverItem,
  type DiscoverRequest,
  type DiscoverResponse,
  type Me,
  type OperationDescriptor,
  type RunAdmissionResponse,
  type RunReceipt,
  type TopUpOrder,
  type TopUpSKU,
  type Usage,
  type Wallet,
  type WalletTransaction,
} from "@itpay/hub-client";
import { HttpError } from "./http.js";
import { connectedHubToken, storedHubProfile, storedHubToken, storedHubKey } from "../state/hub_credentials.js";

export { HubApiError };

export type {
  AdmissionRequest,
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
  const explicit = Boolean(env.ITPAY_HUB_TOKEN || env.ITPAY_HUB_KEY);
  return {
    sessionEnv: !explicit && profile?.access_token ? env : undefined,
    baseURL: (env.ITPAY_HUB_URL ?? "http://localhost:18090").replace(/\/+$/, ""),
    // Session token from `hub connect` or env override wins over a stored
    // imported key; the SDK precedence rule applies to whichever we send.
    bearerToken: env.ITPAY_HUB_TOKEN ?? (env.ITPAY_HUB_KEY ? undefined : storedHubToken(env)),
    apiKey: env.ITPAY_HUB_KEY ?? (profile?.access_token ? undefined : storedHubKey(env)),
  };
}

// Conflict rule (R03): bearer and key credentials must not name different
// subjects silently. When both are present the bearer wins and the key is
// dropped with a loud warning — never a silent account mix.
function toSdkConfig(cfg: HubConfig): { baseUrl: string; token?: string; apiKeyHeader?: "X-ItPay-Key" | "Authorization" } {
  if (cfg.bearerToken) {
    return { baseUrl: cfg.baseURL, token: cfg.bearerToken };
  }
  if (cfg.apiKey) {
    return { baseUrl: cfg.baseURL, token: cfg.apiKey, apiKeyHeader: "X-ItPay-Key" };
  }
  return { baseUrl: cfg.baseURL };
}

export class HubClient {
  private sdk: SdkHubClient;

  constructor(private readonly cfg: HubConfig) {
    this.sdk = new SdkHubClient(toSdkConfig(cfg));
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
  createTopup(body: { sku_id: string; payer_currency: string; continuation_id?: string;channel?:string;mode?:string }, idempotencyKey: string): Promise<TopUpOrder> {
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
        this.sdk = new SdkHubClient({ baseUrl: this.cfg.baseURL, token });
      }
      try { return await fn(); }
      catch (err) {
        if (!(err instanceof HubApiError) || err.status !== 401 || err.envelope.error.code !== "unauthenticated" || !this.cfg.sessionEnv || !token) throw err;
        // Authentication failed before admission. Keep the same SDK call,
        // body and idempotency key; never retry transport or unknown outcomes.
        const refreshed = await connectedHubToken(this.cfg.sessionEnv, token);
        this.sdk = new SdkHubClient({ baseUrl: this.cfg.baseURL, token: refreshed });
        return await fn();
      }
    } catch (err) {
      if (err instanceof HubApiError) {
        throw new HttpError(err.status, {
          code: err.envelope.error.code,
          message: err.envelope.error.message,
        }, `hub request failed`);
      }
      throw err;
    }
  }
}
