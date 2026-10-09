import { type RefundRequest } from "../../client/types.js";
import { type CommandEnvelope } from "./envelope.js";

export function refundStateEnvelope(refund: RefundRequest, status: string): CommandEnvelope {
	const terminal = ["succeeded", "failed", "cancelled", "rejected"].includes(refund.status);
	let instruction = refund.decision_mode === "manual"
		? "先告诉用户退款已进入人工审核，原交付保持冻结；人工审核不等于拒绝，等待服务器决定，不要重复申请或承诺结果。"
		: "先告诉用户退款申请已经记录，原交付已冻结；自动路径表示系统会继续处理，但只有最终 succeeded 才能确认退款成功。然后只跟踪同一退款，不读取交付、不创建授权或重复申请。";
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
		instruction: instruction + " consumption_state是平台交付内容的消费事实，access_locked是交付访问锁；不能据此推断线下服务是否已使用或退款资格。",
		next: terminal ? null : { command: `itpay refund get ${refund.refund_request_id} --json`, reason: "按需读取同一退款；不自动循环等待" },
		recovery: [],
	};
}
