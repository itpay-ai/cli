// CLI configuration loader. Reads config from environment only. Checkout
// display-token persistence belongs to the cart session file, protected with
// owner-only permissions. Provider secrets are explicitly out of scope here.

import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { HttpClient } from "../client/http.js";
import { BackendClient } from "../client/backend.js";
import { DeviceAuthority } from "./device_authority.js";
import { OperationJournal } from "./operation_journal.js";

export interface CLIConfig {
  baseURL: string;
  bearerToken?: string;
  agentDeviceID: string;
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

export const DEFAULT_BASE_URL = "https://test.itpay.ai";
export const CLI_VERSION = "2.0.0-rc.2";
export const API_CONTRACT_REVISION = "sha256:2c2829f4618c47bc505efc0ded853cf639d775585ba13aa23012197e39efa31f";
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
  const baseURL = env.ITPAY_BACKEND_URL || DEFAULT_BASE_URL;
  const bearerToken = env.ITPAY_BEARER_TOKEN || undefined;
  const agentDeviceID = env.ITPAY_AGENT_DEVICE_ID || "";
  const agentType = env.ITPAY_AGENT_TYPE || agentTypeFromArgv(process.argv);
  const checkoutCurrency = env.ITPAY_CURRENCY || "CNY";
  const idempotencyKey = env.ITPAY_IDEMPOTENCY_KEY || `cli_${shortRandom()}`;
  const ideImageAttach = env.ITPAY_IDE_IMAGE_ATTACH !== "0";
  const ideImageDirOverride = env.ITPAY_IDE_IMAGE_DIR_OVERRIDE;
  return {
    baseURL,
    agentDeviceID,
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
  });
  return new BackendClient(http);
}

function agentTypeFromArgv(argv: string[]): string | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--agent-type") return argv[index + 1];
		if (value?.startsWith("--agent-type=")) return value.slice("--agent-type=".length);
	}
	return undefined;
}

function shortRandom(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}
