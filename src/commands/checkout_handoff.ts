export * from "../render/checkout_handoff.js";

import type {CheckoutCreated,CheckoutPresentation} from "../client/types.js";
import {CommandContractError} from "../services/shared/envelope.js";

// Presentation owns the clock, original cart and payment facts for every handoff.
export function assertCheckoutPayable(checkout:CheckoutCreated, authoritative:CheckoutPresentation|undefined, cartID:string, sourceExecutionID?:string):void {
  const current = authoritative?.checkout ?? checkout.checkout;
  const payableStates = ["draft", "quote_bound", "auth_required", "payment_required"];
  const deadlineClosed = authoritative?.payment_remaining_seconds === 0 ||
    (current.expires_at !== undefined && (!authoritative?.server_now || Date.parse(current.expires_at) <= Date.parse(authoritative.server_now)));
  if ((current.cart_id && current.cart_id !== cartID) || !payableStates.includes(current.status) || authoritative?.payment_intents.some(intent=>!["failed","cancelled","expired"].includes(intent.status)) || deadlineClosed || !checkout.display_token) {
    throw new CommandContractError("checkout_not_payable", "original checkout is not a current payable entry",
      "原Checkout不可作为新付款入口；核对原订单。过期不续期，付款处理中或未知不重放，不换购物车或幂等键创建替代购买。",
      sourceExecutionID ? [{command:`itpay services next ${sourceExecutionID} --json`, reason:"读取来源执行的原订单与付款事实"}] : [], undefined, {cart_id:cartID, checkout_id:current.checkout_id, checkout_status:current.status,
        reason:deadlineClosed ? "payment_window_closed" : "checkout_not_payable"});
  }
}
