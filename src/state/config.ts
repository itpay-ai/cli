// CLI configuration loader. The production Backend is pinned to app.itpay.ai;
// environment variables configure only non-Backend runtime details. Checkout
// display-token persistence belongs to the cart session file, protected with
// owner-only permissions. Provider secrets are explicitly out of scope here.

import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { HttpClient } from "../client/http.js";
import { BackendClient } from "../client/backend.js";
import { declaredAgentType } from "./agent_type.js";
import { DeviceAuthority } from "./device_authority.js";
import { OperationJournal } from "./operation_journal.js";

export interface CLIConfig {
  baseURL: string;
  bearerToken?: string;
  agentType?: string;
  checkoutCurrency: string;
  idempotencyKey: string;
  operationJournal?: OperationJournal;
  // IDE image attach contract — defaults to true. Disabled with
  // ITPAY_IDE_IMAGE_ATTACH=0 when the runner has a read-only filesystem
  // or strict scratch-dir policy. When disabled every render path still
  // surfaces a `status:"disabled"` attach so agents see the opt-out
  // instead of wondering why no image appeared.
  ideImageAttach: boolean;
  // Optional override of the canonical IDE image directory.
  ideImageDirOverride?: string;
}

export const DEFAULT_BASE_URL = "https://app.itpay.ai";
export const CLI_VERSION = "2.0.10";
export const API_CONTRACT_REVISION = "sha256:3779f5468ea2109d4134c4ace66258c9eabe82461fa86e83c84df8c860276886";
const CART_SESSION_DEFAULT_DIR = ".itpay-v3";
const CART_SESSION_FILENAME = "cart.json";
const OPERATION_JOURNAL_FILENAME = "operations.json";

export function cartSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ITPAY_CART_SESSION_PATH) {
    return resolve(env.ITPAY_CART_SESSION_PATH);
  }
  const dir = resolve(homedir(), CART_SESSION_DEFAULT_DIR);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, CART_SESSION_FILENAME);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CLIConfig {
  const baseURL = DEFAULT_BASE_URL;
  const bearerToken = env.ITPAY_BEARER_TOKEN || undefined;
  const agentType = declaredAgentType(env);
  const checkoutCurrency = env.ITPAY_CURRENCY || "CNY";
  const idempotencyKey = env.ITPAY_IDEMPOTENCY_KEY || `cli_${shortRandom()}`;
  const ideImageAttach = env.ITPAY_IDE_IMAGE_ATTACH !== "0";
  const ideImageDirOverride = env.ITPAY_IDE_IMAGE_DIR_OVERRIDE;
  return {
    baseURL,
	...(agentType ? { agentType } : {}),
    checkoutCurrency,
    idempotencyKey,
    ...(!env.ITPAY_IDEMPOTENCY_KEY ? { operationJournal: new OperationJournal(resolve(homedir(), CART_SESSION_DEFAULT_DIR, OPERATION_JOURNAL_FILENAME)) } : {}),
    ideImageAttach,
    ...(ideImageDirOverride ? { ideImageDirOverride } : {}),
    ...(bearerToken ? { bearerToken } : {}),
  };
}

export function operationID(config: CLIConfig, operationKey: string): Promise<string> {
  if (config.operationJournal) return config.operationJournal.getOrCreate(operationKey);
  return Promise.resolve(config.idempotencyKey);
}

export function newBackendClient(config: CLIConfig): BackendClient {
	const authority = new DeviceAuthority({
		baseURL: config.baseURL,
		...(config.agentType ? { requestedAgentType: config.agentType } : {}),
		compatibilityHeaders: {
			"X-ItPay-CLI-Version": CLI_VERSION,
			"X-ItPay-Contract-Revision": API_CONTRACT_REVISION,
		},
	});
  const http = new HttpClient({
    baseURL: config.baseURL,
    defaultHeaders: {
      "X-ItPay-CLI-Version": CLI_VERSION,
      "X-ItPay-Contract-Revision": API_CONTRACT_REVISION,
    },
	requestAuthorizer: (input) => authority.authorizationHeaders(input),
    recoverAuthorization: () => authority.recoverAuthorization(),
  });
  return new BackendClient(http);
}

function shortRandom(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}
