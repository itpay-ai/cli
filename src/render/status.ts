// Maps backend enum values to short terminal hints. Keep this file
// narrow on purpose: presentation is a CLI concern, not business truth.

export const CHECKOUT_STATUS_HINTS: Record<string, string> = {
  draft: "Checkout is still being assembled.",
  quote_bound: "Show the checkout QR to the buyer to start the human flow.",
  auth_required: "Buyer must complete provider authorization before payment.",
  payment_required: "Frontend should create a payment intent.",
  payment_pending: "Provider is processing the payment. Wait for the verify callback.",
  payment_succeeded: "Payment verified. Awaiting delivery.",
  completed: "Order is complete and delivered.",
  failed: "Checkout failed. See server logs for the underlying reason.",
  expired: "Checkout expired. Create a new checkout to retry.",
  refunded: "Order has been fully refunded.",
};

export const ORDER_STATUS_HINTS: Record<string, string> = {
  pending_payment: "Order is waiting for payment verification.",
  paid: "Payment verified. Delivery in progress.",
  delivery_pending: "Order is queued for delivery preparation.",
  delivered: "Order is delivered. No further action needed.",
  failed: "Order failed. Contact support.",
  partially_refunded: "A partial refund has been issued.",
  refunded: "Order has been fully refunded.",
  cancelled: "Order has been cancelled.",
};

export const REFUND_STATUS_HINTS: Record<string, string> = {
  requested: "Refund request received. Awaiting review.",
  policy_review_required: "Refund requires human/admin review.",
  accepted: "Refund accepted by the platform. Provider call in flight.",
  provider_pending: "Refund is being processed by the provider.",
  succeeded: "Refund completed.",
  failed: "Refund failed. See server logs.",
  cancelled: "Refund was cancelled before it completed.",
};

export function hintFor(kind: "checkout" | "order" | "refund", status: string): string {
  const table =
    kind === "checkout" ? CHECKOUT_STATUS_HINTS : kind === "order" ? ORDER_STATUS_HINTS : REFUND_STATUS_HINTS;
  return table[status] ?? `Status: ${status}`;
}
