import { coreApi } from "./http.js";
import { cryptoRandom, intFlag, output, positional, queryString, readJSON } from "./env.js";

async function ops(command, rest, flags) {
  if (command !== "sandbox") throw new Error(`unknown ops command: ${command || ""}`);
  const area = rest[0];
  const action = rest[1];
  if (area === "worker" && action === "run-once") {
    output(await coreApi("/v1/sandbox/workers/run-once", { method: "POST", ops: true }, flags));
    return;
  }
  if (area === "recover-alipay-once") {
    output(await coreApi("/v1/local/workers/recover-alipay-sandbox-once", { method: "POST", ops: true }, flags));
    return;
  }
  if (area === "payment" && action === "query") {
    const paymentIntentID = flags.payment_intent || flags.payment_intent_id || positional(rest, 2);
    if (!paymentIntentID) throw new Error("payment_intent_id is required");
    output(await coreApi(`/v1/payment-intents/${encodeURIComponent(paymentIntentID)}/alipay-sandbox-query`, { method: "POST", ops: true }, flags));
    return;
  }
  if (area === "refund") {
    const refundID = flags.refund || flags.refund_id || positional(rest, 2);
    if (!refundID) throw new Error("refund_id is required");
    if (action === "show") {
      output(await coreApi(`/v1/sandbox/ops/refunds/${encodeURIComponent(refundID)}`, { method: "GET", ops: true }, flags));
      return;
    }
    if (action === "approve" || action === "reject") {
      output(await coreApi(`/v1/sandbox/ops/refunds/${encodeURIComponent(refundID)}/${action}`, {
        method: "POST",
        ops: true,
        idempotencyKey: flags.idempotency_key || `idem_cli_refund_${action}_${refundID}`,
        body: {
          reason_code: flags.reason || flags.reason_code || (action === "approve" ? "approved_by_ops" : "not_eligible"),
          note: flags.note || ""
        }
      }, flags));
      return;
    }
    if (action === "execute") {
      output(await coreApi(`/v1/sandbox/ops/refunds/${encodeURIComponent(refundID)}/execute`, {
        method: "POST",
        ops: true,
        idempotencyKey: flags.idempotency_key || `idem_cli_refund_execute_${refundID}`
      }, flags));
      return;
    }
  }
  if (area === "ledger" && action === "entries") {
    const params = new URLSearchParams();
    if (flags.order || flags.order_id) params.set("order_id", String(flags.order || flags.order_id));
    if (flags.refund || flags.refund_id) params.set("refund_id", String(flags.refund || flags.refund_id));
    if (flags.payment_intent || flags.payment_intent_id) params.set("payment_intent_id", String(flags.payment_intent || flags.payment_intent_id));
    if ([...params.keys()].length === 0) {
      throw new Error("ledger filter is required: use --order, --refund, or --payment-intent");
    }
    output(await coreApi(`/v1/sandbox/ops/ledger/entries${queryString(params)}`, { method: "GET", ops: true }, flags));
    return;
  }
  if (area === "reconciliation") {
    if (action === "run") {
      output(await coreApi("/v1/sandbox/ops/reconciliation-runs", {
        method: "POST",
        ops: true,
        idempotencyKey: flags.idempotency_key || `idem_cli_reconciliation_${cryptoRandom()}`,
        body: {
          reconciliation_run_id: flags.reconciliation_run_id || flags.run_id || "",
          status: flags.status || "matched",
          expected_amount_minor: intFlag(flags.expected_amount_minor || flags.expected || 0, "expected_amount_minor"),
          observed_amount_minor: intFlag(flags.observed_amount_minor || flags.observed || 0, "observed_amount_minor"),
          currency: flags.currency || "CNY",
          raw_statement_ref: flags.raw_statement_ref || flags.statement_ref || ""
        }
      }, flags));
      return;
    }
    if (action === "show") {
      const runID = flags.reconciliation_run_id || flags.run_id || positional(rest, 2);
      if (!runID) throw new Error("reconciliation_run_id is required");
      output(await coreApi(`/v1/sandbox/ops/reconciliation-runs/${encodeURIComponent(runID)}`, { method: "GET", ops: true }, flags));
      return;
    }
  }
  if (area === "settlement" && action === "show") {
    const settlementBatchID = flags.settlement_batch || flags.settlement_batch_id || positional(rest, 2);
    if (!settlementBatchID) throw new Error("settlement_batch_id is required");
    output(await coreApi(`/v1/sandbox/ops/settlement-batches/${encodeURIComponent(settlementBatchID)}`, { method: "GET", ops: true }, flags));
    return;
  }
  throw new Error(`unknown ops sandbox command: ${rest.join(" ")}`);
}

async function admin(command, rest, flags) {
  if (command === "orders") {
    const params = new URLSearchParams();
    for (const key of ["account_id", "status", "provider", "limit"]) {
      if (flags[key]) params.set(key, flags[key]);
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    output(await api(`/api/itp/admin/orders${suffix}`, { method: "GET" }, flags));
    return;
  }
  if (command === "payment-events") {
    const params = new URLSearchParams();
    for (const key of ["order_id", "checkout_id", "out_trade_no", "provider", "event_type", "signature_verified", "limit"]) {
      if (flags[key]) params.set(key, flags[key]);
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    output(await api(`/api/itp/admin/payment-events${suffix}`, { method: "GET" }, flags));
    return;
  }
  if (command === "outbox") {
    const params = new URLSearchParams();
    for (const key of ["status", "event_type", "aggregate_id", "limit"]) {
      if (flags[key]) params.set(key, flags[key]);
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    output(await api(`/api/itp/admin/outbox${suffix}`, { method: "GET" }, flags));
    return;
  }
  if (command === "process-outbox") {
    output(await api("/api/itp/admin/outbox/process", { method: "POST" }, flags));
    return;
  }
  if (command === "recover-order") {
    const orderId = rest[0];
    if (!orderId) throw new Error("order_id is required");
    output(await api(`/api/itp/admin/orders/${encodeURIComponent(orderId)}/recover`, { method: "POST" }, flags));
    return;
  }
  throw new Error(`unknown admin command: ${command || ""}`);
}

export { ops, admin };
