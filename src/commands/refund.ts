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

function refundStateEnvelope(refund: RefundRequest, status: string): CommandEnvelope {
	const terminal = ["succeeded", "failed", "cancelled", "rejected"].includes(refund.status);
	let instruction = "退款处理中，交付已冻结；不要 reveal、授权或读取结果。";
	if (refund.decision_mode === "manual") instruction = "退款已进入人工审核，交付保持冻结；等待服务器决定。";
	if (!refund.access_locked) instruction = "退款当前未锁定交付；按服务器状态处理，不要自行推断退款结果。";
	if (refund.status === "succeeded") instruction = "退款已成功；交付永久关闭。";
	if (refund.status === "cancelled" || refund.status === "rejected") instruction = "退款未执行，交付资格可恢复；旧 grant 不会复活，需要用户重新授权。";
	return {
		status,
		result: {
			refund_request_id: refund.refund_request_id,
			order_id: refund.order_id,
			decision_mode: refund.decision_mode,
			refund_status: refund.status,
			consumption_state: refund.consumption_state,
			...(refund.failure_class ? { failure_class: refund.failure_class } : {}),
			access_locked: refund.access_locked,
			can_cancel: refund.can_cancel,
		},
		instruction,
		next: terminal ? null : { command: `itpay refund watch ${refund.refund_request_id} --json`, reason: "跟踪同一退款" },
		recovery: [],
	};
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
			: { command: `itpay refund create --order ${options.orderID} --json`, reason: "为该订单创建退款" },
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
		status: "cancelled",
		result: {
			refund_request_id: refund.refund_request_id,
			order_id: refund.order_id,
			access_locked: refund.access_locked,
		},
		instruction: "退款已取消；如需交付，重新进入订单并取得新的授权。",
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
		instruction: "退款仍在处理，稍后继续跟踪同一退款；不要重复申请。",
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
