// Deterministic PresentationResolver (spec 03 §5): business state first, then
// declared viewer/executor capabilities, then the user's explicit choice and
// failure history. Output is one recommended route plus at most two feasible
// alternatives — never a parallel burst of open + send.
//
// Routes are abstract kinds; the caller maps them to concrete handoff fields
// (url, card image, qr). "unknown" capability answers are never treated as
// "yes", and a route that already failed is not retried without a new reason.

import type { CapabilityAnswer, ClientCapabilities, ExecutorLocality, ViewerDevice } from "../state/client_context.js";

export type PresentationRoute =
  | "open_embedded_browser"
  | "open_system_browser"
  | "show_link"
  | "show_official_image"
  | "show_terminal_qr"
  | "show_mobile_button"
  | "show_mobile_link"
  | "open_user_browser"
  | "request_sms_consent"
  | "request_email_consent"
  | "show_copyable_entry"
  | "ask_viewer_device"
  | "none";

// Business blockers are reported as routes so the caller renders one decision.
export type BusinessBlocker =
  | "policy_blocked"
  | "policy_review_required"
  | "read_same_order"
  | "recover_expired_quote";

export type Observation =
  | "not_attempted"
  | "dispatch_requested"
  | "dispatch_accepted"
  | "page_loaded"   // requires real evidence — dispatch alone never claims this
  | "failed"
  | "unavailable";

export interface PresentationInput {
  business: {
    commerce_policy: "allowed" | "blocked" | "review";
    payment_state: "unpaid" | "paid" | "refund_locked" | "unknown";
    quote_valid: boolean | "unknown";
    amount_minor?: number;
  };
  viewer: ViewerDevice;
  executor_locality: ExecutorLocality;
  capabilities: ClientCapabilities;
  explicit_choice?: PresentationRoute;
  failed_routes?: PresentationRoute[];
  verified_phone_option?: boolean;
  verified_email_option?: boolean;
}

export interface PresentationDecision {
  blocker?: BusinessBlocker;
  recommended: PresentationRoute;
  alternatives: PresentationRoute[];
  routes: PresentationRoute[];
  communication: {
    tell: string;
    wait_for: string;
    must_convey: string[];
  };
}

const yes = (value: CapabilityAnswer): boolean => value === "yes";

export function resolvePresentation(input: PresentationInput): PresentationDecision {
  const blocker = businessBlocker(input.business);
  if (blocker) {
    return {
      blocker,
      recommended: "none",
      alternatives: [],
      routes: [],
      communication: communicationForBlocker(blocker),
    };
  }

  const caps = input.capabilities;
  const local = input.executor_locality === "same_device";
  const routes: PresentationRoute[] = [];
  if (input.viewer === "desktop") {
    if (yes(caps.user_visible_browser)) routes.push("open_embedded_browser");
    if (local && yes(caps.system_browser)) routes.push("open_system_browser");
    if (yes(caps.clickable_https)) routes.push("show_link");
    if (yes(caps.image_visible)) routes.push("show_official_image");
    if (yes(caps.user_visible_terminal) && yes(caps.other_device_scan)) routes.push("show_terminal_qr");
  } else if (input.viewer === "mobile") {
    if (yes(caps.native_url_button)) routes.push("show_mobile_button");
    if (yes(caps.clickable_https)) routes.push("show_mobile_link");
    if (yes(caps.user_visible_browser)) routes.push("open_user_browser");
    if (local && yes(caps.system_browser)) routes.push("open_system_browser");
    // QR never targets the same phone the human is holding.
  } else {
    if (yes(caps.clickable_https)) routes.push("show_link");
    if (routes.length === 0 && yes(caps.image_visible)) routes.push("ask_viewer_device");
  }
  // Relay is a consented fallback, not a presentation route — it only appears
  // when an issued, verified contact option exists.
  if (input.verified_phone_option === true) routes.push("request_sms_consent");
  if (input.verified_email_option === true) routes.push("request_email_consent");
  routes.push("show_copyable_entry");

  const failed = new Set(input.failed_routes ?? []);
  const feasible = routes.filter((route) => !failed.has(route));
  const chosen = input.explicit_choice;
  if (chosen && feasible.includes(chosen)) {
    feasible.splice(feasible.indexOf(chosen), 1);
    feasible.unshift(chosen);
  }
  const ranked = feasible.length > 0 ? feasible : ["show_copyable_entry" as PresentationRoute];
  const [recommended, ...alternatives] = ranked;

  return {
    recommended: recommended!,
    alternatives: alternatives.slice(0, 2),
    routes: ranked.slice(0, 3),
    communication: {
      tell: tellForRoute(recommended!),
      wait_for: "人完成官方页面上的确认/付款；dispatch 成功不等于已付款",
      must_convey: [
        "真实金额与订单归属以 owner 返回为准",
        "已发起打开不代表已显示或已付款",
        ...(input.business.amount_minor === undefined ? ["金额尚未确认，不称锁价或最终价"] : []),
      ],
    },
  };
}

function businessBlocker(business: PresentationInput["business"]): BusinessBlocker | undefined {
  if (business.commerce_policy === "blocked") return "policy_blocked";
  if (business.commerce_policy === "review") return "policy_review_required";
  if (business.payment_state !== "unpaid") return "read_same_order";
  if (business.quote_valid !== true) return "recover_expired_quote";
  if (typeof business.amount_minor !== "number" || business.amount_minor <= 0) return "read_same_order";
  return undefined;
}

function communicationForBlocker(blocker: BusinessBlocker): PresentationDecision["communication"] {
  switch (blocker) {
    case "policy_blocked":
      return { tell: "该服务在当前宿主/准入策略下不可用，不绕外链或消息逃避。", wait_for: "用户更换获准渠道", must_convey: ["技术与准入分开说明"] };
    case "policy_review_required":
      return { tell: "当前准入策略要求复核，不发起展示动作。", wait_for: "准入复核结果", must_convey: ["不是业务失败"] };
    case "read_same_order":
      return { tell: "该订单不处于待付款状态；先读取原订单，不展示付款入口、不新建支付动作。", wait_for: "原订单状态", must_convey: ["用户声称已付仍须核对原单"] };
    case "recover_expired_quote":
      return { tell: "报价已失效或过期；读取原执行由 owner 重新核价，不向人收取旧金额。", wait_for: "新的 owner 报价", must_convey: ["旧二维码/入口不再有效"] };
  }
}

function tellForRoute(route: PresentationRoute): string {
  switch (route) {
    case "open_embedded_browser":
    case "open_system_browser":
    case "open_user_browser":
      return "已发起打开官方页面；若用户未看到，换一种方式，仍是同一订单。";
    case "show_link":
    case "show_mobile_link":
      return "把官方链接作为可点击入口交给用户。";
    case "show_mobile_button":
      return "展示原生 URL 按钮直达官方页。";
    case "show_official_image":
      return "展示官方图片入口（另一台设备用）。";
    case "show_terminal_qr":
      return "展示二维码供另一台设备扫码。";
    case "request_sms_consent":
      return "建议把订单入口发到已验证的手机尾号；征得明确同意后发送一条。";
    case "request_email_consent":
      return "建议把订单入口发到已验证的邮箱；征得明确同意后发送一封。";
    case "ask_viewer_device":
      return "无法判断用户在看哪种设备；最多澄清一次设备类型。";
    case "show_copyable_entry":
      return "给出可复制的官方入口并说明如何打开。";
    default:
      return "当前无可行展示方式；只说明状态，等待用户给出可用渠道。";
  }
}

// --- Relay (SMS / email handoff) -------------------------------------------
// Backend relay endpoints do not exist yet. The CLI therefore exposes the
// flags, enforces the contract shape, and answers honestly unavailable —
// it never sends a message itself and never accepts an arbitrary number,
// template or URL from the client.

export type RelayDecision =
  | { kind: "unavailable"; reason: string }
  | { kind: "invalid"; reason: string }
  | { kind: "needs_consent" };

export function resolveRelay(input: {
  relayOption?: string;
  confirmRelay?: boolean;
  requestKey?: string;
  backendCapability?: boolean;   // true only if the backend exposes relay routes
}): RelayDecision {
  if (!input.backendCapability) {
    return {
      kind: "unavailable",
      reason: "当前 Backend 未提供消息转发（relay）能力；改用官方链接或二维码呈现，不得伪造发送结果。",
    };
  }
  if (!input.relayOption) {
    return { kind: "invalid", reason: "--relay-option 必须是服务端已签发的脱敏联系人引用。" };
  }
  if (!input.requestKey || !input.requestKey.trim()) {
    return { kind: "invalid", reason: "--request-key 是必填的稳定幂等键。" };
  }
  if (!input.confirmRelay) {
    return { kind: "needs_consent" };
  }
  return { kind: "unavailable", reason: "relay 后端未启用。" };
}
