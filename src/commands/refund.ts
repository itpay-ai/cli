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
	let instruction = refund.decision_mode === "manual"
		? "先告诉用户退款已进入人工审核，原交付保持冻结；人工审核不等于拒绝，等待服务器决定，不要重复申请或承诺结果。"
		: "先告诉用户退款申请已经记录，原交付已冻结；自动路径表示系统会继续处理，但只有最终 succeeded 才能确认退款成功。然后只跟踪同一退款，不要重复申请、reveal、授权或读取结果。";
	if (!refund.access_locked) instruction = "先告诉用户退款当前没有锁定交付；按服务器事实解释当前状态，不要自行推断退款结果、到账时间或交付资格。";
	if (refund.status === "succeeded") instruction = "先告诉用户退款已由 ItPay 确认成功，原交付永久关闭；不需要继续跟踪或重复申请。";
	if (refund.status === "cancelled" || refund.status === "rejected") instruction = "先告诉用户退款没有执行，交付资格可以恢复；旧读取授权不会复活，需要用户重新授权。不要把取消或拒绝说成退款成功。";
	if (refund.status === "failed") {
		if (refund.failure_class === "known_no_effect") instruction = "先告诉用户本次退款请求确认未发送，不能说退款已成功；Agent 不自行重试，请用户等待平台管理员决定是否重新执行。";
		else if (refund.failure_class === "retryable") instruction = "先告诉用户渠道明确返回可重试失败，但 Agent 不会自行重试或重复申请；请用户等待平台管理员处理。";
		else if (refund.failure_class === "outcome_unknown") instruction = "先告诉用户退款渠道结果未知，原交付继续锁定且必须先由平台对账；禁止重试、重复申请或承诺退款结果。";
		else if (refund.failure_class === "permanent") instruction = "先告诉用户渠道明确拒绝本次退款，当前不能承诺退款成功；不要重试，请用户联系平台支持。";
		else instruction = "先告诉用户退款没有正常完成，当前不能承诺退款成功；不要重试或重复申请，请用户联系平台支持。";
	}
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
