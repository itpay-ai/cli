import { type ClientHost } from "../state/client_context.js";
import { platformKeyForHost, type RenderPlan } from "./plan.js";
import { type CardLocale } from "./locale.js";
import { isLinkOnlyBrowserAgent } from "./checkout_handoff.js";
import { qualifyItPayCommand } from "../state/agent_type.js";

// --- checkout QR plan ---

export function buildCheckoutQRPlan(input: {
  localSimulation?: boolean;
  host: ClientHost;
  checkoutID: string;
  checkoutURL: string;
  displayToken: string;
  qrPayload: string;
  qrPNGURL?: string;
  cardURL?: string;
  nextAction: string;
  orderItems?: { title: string; quantity: number; amountMinor: number; currency: string }[];
  orderCurrency?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  paymentIntentID?: string;
  agentType?: string;
  locale?: CardLocale;
}): RenderPlan {
  const summary = input.localSimulation ? "在本机打开模拟付款入口；铁路与地图查询真实，授权、通知和交易模拟，不会扣款。" : `Scan the QR or open ${input.checkoutURL} to start the human checkout flow.`;
  const isPayment = input.paymentIntentID != null;
  const afterCommand = qualifyItPayCommand(
    `itpay checkout --id ${input.checkoutID} --token ${input.displayToken}${input.locale === "en" ? " --locale en" : ""} --json`,
    input.agentType,
  );

  const platform: RenderPlan["platform"] = {
    text: summary,
    links: [
      { label: "打开付款页面", url: input.checkoutURL },
    ],
    buttons: [
      { label: "打开收银台", kind: "url" as const, url: input.checkoutURL },
      ...(input.checkoutID
        ? [{ label: "查询 Checkout 状态", kind: "callback" as const, intent: "check_checkout_status", ref: input.checkoutID }]
        : []),
    ],
    blocks: [],
    ...(input.qrPNGURL ? { media: [{ url: input.qrPNGURL, label: "Branded QR", mimeType: "image/png" }] } : {}),
  };

  const plan: RenderPlan = {
    kind: isPayment ? "payment_qr" : "checkout_qr",
    ...(input.localSimulation ? {localSimulation:true} : {}),
    host: input.host,
    summary,
    url: input.qrPayload,
    ...(isLinkOnlyBrowserAgent(input.agentType, platformKeyForHost(input.host)) && input.cardURL ? { linkOnlyURL: input.cardURL } : {}),
    preferredQRSources: [input.qrPNGURL ?? input.qrPayload],
    checkoutID: input.checkoutID,
    platform,
    afterActionCommand: afterCommand,
    afterActionLabel: isPayment ? "用户完成本人付款后，读取原单状态：" : "用户完成原官方页面当前步骤后，读取原任务状态：",
  };
  if (input.orderItems) plan.orderItems = input.orderItems;
  if (input.orderCurrency) plan.orderCurrency = input.orderCurrency;
  if (input.paymentMethod) plan.paymentMethod = input.paymentMethod;
  if (input.paymentStatus) plan.paymentStatus = input.paymentStatus;
  if (input.paymentIntentID) plan.paymentIntentID = input.paymentIntentID;
  return plan;
}
