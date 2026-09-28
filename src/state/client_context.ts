// V3 CLI client-context: which host is the CLI running under, and what
// target (chat id, channel id, etc.) it has. Mirrors the role of V1's
// `lib/client-context.js` but kept narrow: no I/O, no env I/O beyond the
// raw values the caller passes in.

export const SUPPORTED_HOSTS = new Set<ClientHost>([
  "terminal",
  "codex",
  "claude-code",
  "telegram",
  "discord",
  "whatsapp",
  "feishu",
  "lark",
  "plain-chat",
]);

// Hosts that have a real renderer attached. Discord / WhatsApp currently
// only have host validation and fall back to plain-chat, matching V1.
export const HOSTS_WITH_DEDICATED_RENDERER = new Set<ClientHost>([
  "terminal",
  "codex",
  "claude-code",
  "telegram",
  "feishu",
  "lark",
]);

export type ClientHost =
  | "terminal"
  | "codex"
  | "claude-code"
  | "telegram"
  | "discord"
  | "whatsapp"
  | "feishu"
  | "lark"
  | "plain-chat";

// Telegram/Discord/WhatsApp/Feishu/Lark all require a stable target so we
// can route replies / callback answers back to the right chat.
export const HOSTS_REQUIRING_TARGET = new Set<ClientHost>([
  "telegram",
  "discord",
  "whatsapp",
  "feishu",
  "lark",
]);

const HOST_ALIASES: Record<string, ClientHost> = {
  tg: "telegram",
  "openclaw-telegram": "telegram",
  trae: "codex",
  "trae-agent": "codex",
  feishu_im: "feishu",
  fs: "feishu",
};

export interface ClientContextError {
  code: "client_context_required" | "invalid_host" | "target_required";
  message: string;
}

export function normalizeHost(raw: string | undefined): ClientHost | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if ((SUPPORTED_HOSTS as Set<string>).has(lower)) return lower as ClientHost;
  return HOST_ALIASES[lower];
}

export function requiresTarget(host: ClientHost): boolean {
  return HOSTS_REQUIRING_TARGET.has(host);
}

export function hasDedicatedRenderer(host: ClientHost): boolean {
  return HOSTS_WITH_DEDICATED_RENDERER.has(host);
}

export function defaultHostForAgentType(agentType: string | undefined): ClientHost | undefined {
  const normalized = agentType?.trim().toLowerCase() ?? "";
  if (normalized === "codex-desktop") return "codex";
  if (normalized === "claude-code-desktop") return "claude-code";
  if (normalized === "workbuddy") return "plain-chat";
  if (normalized === "zcode") return "plain-chat";
  if (normalized === "doubao-work") return "plain-chat";
  if (normalized === "openclaw") return undefined;
  return "terminal";
}

export function validateContext(
  host: ClientHost | undefined,
  target: string | undefined,
): ClientContextError | undefined {
  if (!host) {
    return { code: "client_context_required", message: "--host is required" };
  }
  if (requiresTarget(host) && !target) {
    return { code: "target_required", message: `--target is required for host ${host}` };
  }
  return undefined;
}

// --- UX presentation context ------------------------------------------------
// Viewer = the device the HUMAN is looking at; executor = where this CLI
// process runs. They are independent facts (a phone can drive a desktop box).
// Capabilities are declared evidence, never inferred from brand, screen size
// or model identity: unknown means unknown, never "yes".

export type ViewerDevice = "desktop" | "mobile" | "unknown";
export type ExecutorLocality = "same_device" | "remote" | "cloud" | "unknown";
export type CapabilityAnswer = "yes" | "no" | "unknown";

export interface ClientCapabilities {
  // A browser the human can actually see right now.
  user_visible_browser: CapabilityAnswer;
  // A system browser on the executor machine (only useful when locality is
  // same_device — a remote open is not a user-visible page).
  system_browser: CapabilityAnswer;
  clickable_https: CapabilityAnswer;
  image_visible: CapabilityAnswer;
  native_url_button: CapabilityAnswer;
  user_visible_terminal: CapabilityAnswer;
  other_device_scan: CapabilityAnswer;
  send_message: CapabilityAnswer;
}

export function normalizeViewer(raw: string | undefined): ViewerDevice {
  const v = raw?.trim().toLowerCase();
  if (v === "desktop" || v === "mobile") return v;
  return "unknown";
}

export function normalizeLocality(raw: string | undefined): ExecutorLocality {
  const v = raw?.trim().toLowerCase();
  if (v === "same_device" || v === "remote" || v === "cloud") return v;
  return "unknown";
}

// Conservative declared capability table per host. Terminal/desktop agent
// hosts run where a human watches a screen and a system browser exists;
// IM hosts can send links/buttons but cannot be assumed to open pages;
// plain-chat surfaces get links and copyable entries only.
export function hostCapabilities(host: ClientHost | undefined): ClientCapabilities {
  switch (host) {
    case "terminal":
    case "codex":
    case "claude-code":
      return {
        user_visible_browser: "unknown",
        system_browser: "yes",
        clickable_https: "yes",
        image_visible: host === "terminal" ? "no" : "unknown",
        native_url_button: "no",
        user_visible_terminal: "yes",
        other_device_scan: "yes",
        send_message: "yes",
      };
    case "telegram":
    case "feishu":
    case "lark":
      return {
        user_visible_browser: "no",
        system_browser: "no",
        clickable_https: "yes",
        image_visible: "yes",
        native_url_button: "yes",
        user_visible_terminal: "no",
        other_device_scan: "unknown",
        send_message: "yes",
      };
    case "discord":
    case "whatsapp":
      return {
        user_visible_browser: "no",
        system_browser: "no",
        clickable_https: "yes",
        image_visible: "yes",
        native_url_button: "unknown",
        user_visible_terminal: "no",
        other_device_scan: "unknown",
        send_message: "yes",
      };
    case "plain-chat":
    default:
      return {
        user_visible_browser: "no",
        system_browser: "unknown",
        clickable_https: "yes",
        image_visible: "no",
        native_url_button: "unknown",
        user_visible_terminal: "no",
        other_device_scan: "unknown",
        send_message: "yes",
      };
  }
}
