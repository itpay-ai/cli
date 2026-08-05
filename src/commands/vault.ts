import type { BackendClient } from "../client/backend.js";
import type { CLIConfig } from "../state/config.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { CommandContractError, type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";
import { HttpError } from "../client/http.js";

export interface VaultListOptions {
  query?: string;
  limit: number;
  output?: OutputSink;
  jsonOutput?: boolean;
}

export interface VaultAccessOptions {
  artifact: string;
  fields?: string[];
  output?: OutputSink;
  jsonOutput?: boolean;
}

export interface VaultReadOptions {
  artifact: string;
  output?: OutputSink;
  jsonOutput?: boolean;
}

export async function runVaultList(
  backend: BackendClient,
  _config: CLIConfig,
  options: VaultListOptions,
): Promise<void> {
  const out = resolveOutput(options.output);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) {
    throw new CommandContractError(
      "limit_invalid",
      "--limit must be an integer from 1 to 50",
      "使用 1 到 50 的整数 limit；本次未读取 Vault 列表。",
      [{ command: "itpay vault list --limit 20 --json", reason: "使用默认上限重试" }],
    );
  }
  const response = await backend.listVaultArtifacts({
    limit: options.limit,
    ...(options.query ? { query: options.query } : {}),
  });
  const items = (response.items ?? []).map((item) => ({
    artifact_ref: item.artifact_ref,
    service_title: item.service_title,
    subject_label: item.subject_label,
    order_code: item.order_code,
    access_status: item.access_status,
    amount_minor: item.amount_minor,
    currency: item.currency,
  }));
  const first = items[0];
  const envelope: CommandEnvelope = {
    status: "vault_listed",
    result: { items, next_cursor: response.next_cursor ?? null },
    instruction: first
      ? "让用户选择 artifact_ref 后请求授权；不要假设第一项就是当前任务。"
      : "当前没有 Vault 工件；购买请使用现有 commerce 命令，不要伪造 artifact。",
    next: first
      ? { command: `itpay vault access --artifact ${first.artifact_ref} --json`, reason: "请求人类授权" }
      : null,
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    output: out,
    plainResult: items.map((item) =>
      `${item.artifact_ref}: ${item.service_title ?? "artifact"} ${item.subject_label ?? ""} [${item.access_status}]`,
    ),
  });
}

export async function runVaultAccess(
  backend: BackendClient,
  _config: CLIConfig,
  options: VaultAccessOptions,
): Promise<void> {
  const out = resolveOutput(options.output);
  const artifact = options.artifact.trim();
  if (!artifact) {
    throw new CommandContractError(
      "artifact_required",
      "--artifact is required",
      "先用 vault list 选择 artifact_ref；本次未创建授权请求。",
      [{ command: "itpay vault list --json", reason: "列出 Vault 库存" }],
    );
  }
  const created = await backend.createVaultAccessRequest(artifact, {
    ...(options.fields && options.fields.length > 0 ? { fields: options.fields } : {}),
  });
  const url = created.authorization?.url ?? "";
  const envelope: CommandEnvelope = {
    status: "human_authorization_required",
    result: {
      access_request_id: created.access_request_id,
      expires_at: created.expires_at,
      authorization: created.authorization,
      artifact_ref: artifact,
    },
    ...(url ? { handoff: { url } } : {}),
    instruction: "请用户在浏览器以同一 Buyer 登录并批准；批准后执行 vault read。不要记录或复制 start_token。",
    next: { command: `itpay vault read --artifact ${artifact} --json`, reason: "批准后读取受保护结果" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    output: out,
    plainResult: [`Authorize: ${url}`],
  });
}

export async function runVaultRead(
  backend: BackendClient,
  _config: CLIConfig,
  options: VaultReadOptions,
): Promise<void> {
  const out = resolveOutput(options.output);
  const artifact = options.artifact.trim();
  if (!artifact) {
    throw new CommandContractError(
      "artifact_required",
      "--artifact is required",
      "先选择 artifact_ref；本次未读取。",
      [{ command: "itpay vault list --json", reason: "列出 Vault 库存" }],
    );
  }
  try {
    const result = await backend.readGrantedVaultArtifact(artifact);
    if (result.status === "result_preparing") {
      writeCommandEnvelope({
        status: "result_preparing",
        result: { artifact_ref: artifact },
        instruction: "结果准备中；稍后重试 vault read，不要新建 Provider 调用。",
        next: { command: `itpay vault read --artifact ${artifact} --json`, reason: "稍后重试读取" },
        recovery: [],
      }, {
        ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
        output: out,
        plainResult: [`Preparing: ${artifact}`],
      });
      return;
    }
    if (result.status === "result_unavailable") {
      writeCommandEnvelope({
        status: "result_unavailable",
        result: {
          artifact_ref: result.artifact_ref || artifact,
          reason: result.reason || "unavailable",
        },
        instruction: "该结果不可读取；不要重试、重新授权或调用 Provider。",
        next: null,
        recovery: [],
      }, {
        ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
        output: out,
        plainResult: [`Unavailable: ${artifact}`],
      });
      return;
    }
    writeCommandEnvelope({
      status: result.status || "result_ready",
      result: {
        artifact_ref: result.artifact_ref || artifact,
        grant_expires_at: result.grant_expires_at,
        result: result.result ?? {},
      },
      instruction: "仅展示授权字段数据；不要据此发起支付或退款。",
      next: null,
      recovery: [],
    }, {
      ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
      output: out,
      plainResult: [JSON.stringify(result.result ?? {}, null, 2)],
    });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.code === "agent_access_denied")) {
      writeCommandEnvelope({
        status: "authorization_required",
        result: { artifact_ref: artifact },
        instruction: "需要人类授权；先 vault access，再重试 read。",
        next: { command: `itpay vault access --artifact ${artifact} --json`, reason: "请求人类授权" },
        recovery: [],
      }, {
        ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
        output: out,
        plainResult: [`Authorization required: ${artifact}`],
      });
      return;
    }
    if (error instanceof HttpError && (error.code === "reveal_blocked_by_refund" || error.code === "result_unavailable")) {
      writeCommandEnvelope({
        status: "result_unavailable",
        result: {
          artifact_ref: artifact,
          reason: error.code === "reveal_blocked_by_refund" ? "refunded" : "unavailable",
        },
        instruction: "该结果不可读取；不要重试、重新授权或调用 Provider。",
        next: null,
        recovery: [],
      }, {
        ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
        output: out,
        plainResult: [`Unavailable: ${artifact}`],
      });
      return;
    }
    if (error instanceof HttpError && error.code === "result_preparing") {
      writeCommandEnvelope({
        status: "result_preparing",
        result: { artifact_ref: artifact },
        instruction: "结果准备中；稍后重试 vault read，不要新建 Provider 调用。",
        next: { command: `itpay vault read --artifact ${artifact} --json`, reason: "稍后重试读取" },
        recovery: [],
      }, {
        ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
        output: out,
        plainResult: [`Preparing: ${artifact}`],
      });
      return;
    }
    throw error;
  }
}
