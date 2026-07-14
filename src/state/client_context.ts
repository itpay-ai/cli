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

export function defaultHostForAgentType(agentType: string | undefined): ClientHost {
  const normalized = agentType?.trim().toLowerCase() ?? "";
  if (normalized === "codex-desktop") return "codex";
  if (normalized === "claude-code-desktop") return "claude-code";
  if (normalized === "workbuddy") return "plain-chat";
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
