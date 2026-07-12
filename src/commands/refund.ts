import type { BackendClient } from "../client/backend.js";
import type { RefundRequest } from "../client/types.js";
import { operationID, type CLIConfig } from "../state/config.js";
import { renderRefund } from "../render/output.js";
import { hintFor } from "../render/status.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";

export interface RefundOptions { orderID: string; reason?: string; output?: OutputSink; }

export async function runRefund(backend: BackendClient, config: CLIConfig, options: RefundOptions): Promise<void> {
	const out = resolveOutput(options.output);
	const reason = options.reason?.trim() || "buyer_requested";
	const refund = await backend.createRefund(options.orderID, { reason }, config.bearerToken, await operationID(config, `refund.create:${options.orderID}:${reason}`));
	writeRefund(out, refund);
}

export async function runListRefunds(backend: BackendClient, orderID: string, output?: OutputSink): Promise<void> {
	const out = resolveOutput(output);
	const response = await backend.listOrderRefunds(orderID);
	if (response.refunds.length === 0) { out("No refund requests for this order.\nnext: `itpay refund create --order " + orderID + "`\n"); return; }
	for (const refund of response.refunds) writeRefund(out, refund);
}

export async function runGetRefund(backend: BackendClient, refundID: string, output?: OutputSink): Promise<void> {
	writeRefund(resolveOutput(output), await backend.getRefund(refundID));
}

export async function runCancelRefund(backend: BackendClient, refundID: string, reason?: string, output?: OutputSink): Promise<void> {
	writeRefund(resolveOutput(output), await backend.cancelRefund(refundID, reason?.trim() || "buyer_cancelled"));
}

export async function runWatchRefund(backend: BackendClient, refundID: string, intervalSeconds = 2, timeoutSeconds = 120, output?: OutputSink): Promise<void> {
	const out = resolveOutput(output);
	const deadline = Date.now() + timeoutSeconds * 1000;
	let previous = "";
	while (Date.now() < deadline) {
		const refund = await backend.getRefund(refundID);
		if (refund.status !== previous) { writeRefund(out, refund); previous = refund.status; }
		if (["succeeded", "failed", "cancelled", "rejected"].includes(refund.status)) return;
		await new Promise((resolve) => setTimeout(resolve, Math.max(1, intervalSeconds) * 1000));
	}
	throw new Error(`refund watch timed out; resume with: itpay refund watch ${refundID}`);
}

function writeRefund(out: OutputSink, refund: RefundRequest): void {
	out(renderRefund(refund) + "\n");
	out(`hint: ${hintFor("refund", refund.status)}\n`);
	if (refund.can_cancel) out(`next: cancel with \`itpay refund cancel ${refund.refund_request_id}\` or continue watching.\n`);
	else if (!["succeeded", "failed", "cancelled", "rejected"].includes(refund.status)) out(`next: \`itpay refund watch ${refund.refund_request_id}\`\n`);
}
