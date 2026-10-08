import { refundStateEnvelope } from "../services/shared/refund.js";
import type { BackendClient } from "../client/backend.js";
import type { RefundRequest } from "../client/types.js";
import { operationID, type CLIConfig } from "../state/config.js";
import { formatMoney } from "../render/output.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";

export interface RefundOptions { orderID: string; reason?: string; output?: OutputSink; jsonOutput?: boolean; }
export interface RefundReadOptions { output?: OutputSink; jsonOutput?: boolean; }
export interface RefundWatchOptions extends RefundReadOptions { intervalSeconds?: number; timeoutSeconds?: number; }
export interface RefundListOptions extends RefundReadOptions { orderID: string; }

export async function runRefund(backend: BackendClient, config: CLIConfig, options: RefundOptions): Promise<void> {
	const reason = options.reason?.trim() || "buyer_requested";
	const refund = await backend.createRefund(options.orderID, { reason }, config.bearerToken, await operationID(config, `refund.create:${options.orderID}:${reason}`));
	const envelope = refundStateEnvelope(refund, "requested");
	writeCommandEnvelope(envelope, {
		...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
		...(options.output ? { output: options.output } : {}),
		plainResult: Object.entries(envelope.result).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`),
	});
}

export async function runListRefunds(backend: BackendClient, options: RefundListOptions): Promise<void> {
	const out = resolveOutput(options.output);
	const response = await backend.listOrderRefunds(options.orderID);
	const refunds = response.refunds.map((refund) => ({
		refund_request_id: refund.refund_request_id,
		status: refund.status,
		amount: formatMoney(refund.amount_minor, refund.currency),
		created_at: refund.created_at,
	}));
	const active = refunds.find((refund) => !["succeeded", "failed", "cancelled", "rejected"].includes(refund.status));
	const selected = active ?? refunds[0];
	const envelope: CommandEnvelope = {
		status: selected ? "listed" : "empty",
		result: { order_id: options.orderID, refunds },
		instruction: active
			? "已有活跃退款；继续跟踪同一笔，不要为该订单重复创建。"
			: selected
				? "结果按最新到最旧排列；按时间和状态选择退款记录，再读取权威详情。"
				: "该订单没有退款记录；确认用户确实要求退款后再创建。",
		next: selected
			? { command: `itpay refund get ${selected.refund_request_id} --json`, reason: active ? "读取活跃退款" : "读取最新退款" }
			: null,
		recovery: [],
	};
	writeCommandEnvelope(envelope, {
		...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
		output: out,
		plainResult: [
			`order_id: ${options.orderID}`,
			...refunds.map((refund) => `${refund.refund_request_id}: ${refund.status} ${refund.amount} created=${refund.created_at}`),
		],
	});
}

export async function runGetRefund(backend: BackendClient, refundID: string, options: RefundReadOptions = {}): Promise<void> {
	const envelope = refundStateEnvelope(await backend.getRefund(refundID), "shown");
	writeCommandEnvelope(envelope, {
		...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
		...(options.output ? { output: options.output } : {}),
		plainResult: Object.entries(envelope.result).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`),
	});
}

export async function runCancelRefund(backend: BackendClient, refundID: string, reason?: string, options: RefundReadOptions = {}): Promise<void> {
	const refund = await backend.cancelRefund(refundID, reason?.trim() || "buyer_cancelled");
	const envelope: CommandEnvelope = {
		status: refund.status,
		result: {
			refund_request_id: refund.refund_request_id,
			order_id: refund.order_id,
			access_locked: refund.access_locked,
		},
		instruction: refund.status === "cancelled" ? "Backend确认退款已取消；如需交付，重新进入原订单核对当前权限，旧grant不自动复活；后端要求时取得新的授权。" : "Backend未确认取消；按返回的退款权威状态核对原订单，不重复提交取消。",
		next: { command: `itpay order ${refund.order_id} --json`, reason: "确认订单访问状态" },
		recovery: [],
	};
	writeRefundEnvelope(envelope, options);
}

export async function runWatchRefund(backend: BackendClient, refundID: string, options: RefundWatchOptions = {}): Promise<void> {
	const intervalSeconds = options.intervalSeconds ?? 2;
	const timeoutSeconds = options.timeoutSeconds ?? 120;
	if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) throw new Error("--interval must be at least 1 second");
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout must be a positive number");
	const deadline = Date.now() + timeoutSeconds * 1000;
	let refund: RefundRequest;
	for (;;) {
		refund = await backend.getRefund(refundID);
		if (["succeeded", "failed", "cancelled", "rejected"].includes(refund.status)) {
			writeRefundEnvelope(refundStateEnvelope(refund, "watch_complete"), options);
			return;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(intervalSeconds * 1000, remaining)));
	}
	writeRefundEnvelope({
		status: "watch_timeout",
		result: {
			refund_request_id: refund.refund_request_id,
			last_status: refund.status,
			access_locked: refund.access_locked,
			can_cancel: refund.can_cancel,
		},
		instruction: "先告诉用户退款仍在处理，Timeout 只表示本次等待结束，并不表示退款失败；稍后继续跟踪同一退款，不要重复申请或承诺结果。",
		next: { command: `itpay refund watch ${refund.refund_request_id} --json`, reason: "恢复轮询" },
		recovery: [],
	}, options);
}

function writeRefundEnvelope(envelope: CommandEnvelope, options: RefundReadOptions): void {
	writeCommandEnvelope(envelope, {
		...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
		...(options.output ? { output: options.output } : {}),
		plainResult: Object.entries(envelope.result).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`),
	});
}

export { refundStateEnvelope } from "../services/shared/refund.js";
