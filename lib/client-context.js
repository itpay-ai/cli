const SUPPORTED_HOSTS = new Set(["codex", "claude-code", "telegram", "discord", "whatsapp", "terminal", "plain-chat"]);
const RUNTIME_TARGETS = new Set(["codex", "claude-code", "openclaw", "generic"]);
const EXEMPT_GROUPS = new Set(["", "--help", "-h", "help", "version", "docs", "skill", "doctor", "install"]);

function clientContextGate(args = []) {
  const group = args[0] || "";
  if (EXEMPT_GROUPS.has(group)) return null;
  const flags = parseArgFlags(args.slice(1));
  const host = clientHost(flags);
  if (!host) return clientContextRequired();
  if (!SUPPORTED_HOSTS.has(host)) return unsupportedClientContext(host);
  if (requiresTarget(host) && !clientTarget(flags)) return clientTargetRequired(host);
  return null;
}

function clientHost(flags = {}) {
  const raw = firstValue(
    flags.host,
    flags.client,
    flags.channel,
    argFlag("host"),
    argFlag("client"),
    argFlag("channel")
  );
  const host = normalizeHost(raw);
  if (host === "openclaw" && flags.channel) return normalizeHost(flags.channel);
  return host;
}

function clientTarget(flags = {}) {
  const target = firstValue(flags.chat_target, flags.reply_target, argFlag("chat-target"), argFlag("reply-target"));
  if (target) return target;
  const flagTarget = flags.target || argFlag("target");
  return flagTarget && !RUNTIME_TARGETS.has(normalizeHost(flagTarget)) ? String(flagTarget) : "";
}

function clientCommandArgs(flags = {}) {
  const host = clientHost(flags);
  const target = clientTarget(flags);
  return [
    ...(host ? ["--host", host] : []),
    ...(target ? ["--target", target] : [])
  ];
}

function requiresTarget(host) {
  return host === "telegram" || host === "discord" || host === "whatsapp";
}

function clientContextRequired() {
  return {
    schema_version: "itp.client_context.v1",
    status: "client_context_required",
    must_rerun: true,
    instruction: "Rerun the same itp command with --host <client>. ItPay will not guess the current chat/app client.",
    allowed_hosts: Array.from(SUPPORTED_HOSTS),
    examples: {
      codex: "itp ... --host codex --json",
      claude_code: "itp ... --host claude-code --json",
      telegram: "itp ... --host telegram --target telegram:<chat_id> --json",
      terminal: "itp ... --host terminal --json"
    }
  };
}

function clientTargetRequired(host) {
  return {
    schema_version: "itp.client_context.v1",
    status: "client_target_required",
    must_rerun: true,
    host,
    instruction: "Rerun the same itp command with the current chat target. For OpenClaw Telegram group/private chat, pass inbound_meta.chat_id as --target.",
    examples: {
      telegram_private: "itp ... --host telegram --target telegram:5559456744 --json",
      telegram_group: "itp ... --host telegram --target telegram:-1001234567890 --json",
      discord: "itp ... --host discord --target discord:<channel_id> --json"
    }
  };
}

function unsupportedClientContext(host) {
  return {
    schema_version: "itp.client_context.v1",
    status: "unsupported_client_context",
    must_rerun: true,
    host,
    instruction: "Use one supported --host value so ItPay can return a single executable human-output instruction.",
    allowed_hosts: Array.from(SUPPORTED_HOSTS)
  };
}

function normalizeHost(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("_", "-");
  if (["tg", "openclaw-telegram"].includes(normalized)) return "telegram";
  if (["codex-app", "codex-cli"].includes(normalized)) return "codex";
  if (["claude", "claudecode", "claude-code-app"].includes(normalized)) return "claude-code";
  if (["plain", "plain-chat", "chat"].includes(normalized)) return "plain-chat";
  return normalized;
}

function parseArgFlags(args = []) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!String(arg).startsWith("--")) continue;
    const key = String(arg).slice(2).replaceAll("-", "_");
    const next = args[i + 1];
    if (!next || String(next).startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function argFlag(name) {
  return parseArgFlags(process.argv.slice(2))[String(name).replaceAll("-", "_")] || "";
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== false && String(value).trim() !== "") || "";
}

export { clientCommandArgs, clientContextGate, clientHost, clientTarget };
