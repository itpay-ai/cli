import { DEFAULT_BASE_URL } from "../state/config.js";

export interface InstallTarget {
  name: string;
  configFile: string;
  instructions: string[];
}

const INSTALL_TARGETS: Record<string, InstallTarget> = {
  "claude-code": {
    name: "Claude Code",
    configFile: "~/.claude/settings.json",
    instructions: [
      "1. Ensure itpay is installed:  npm install -g @itpay/cli",
      `2. Default API:                 ${DEFAULT_BASE_URL}`,
      "3. Use --agent-type claude-code-cli or claude-code-desktop",
      "4. Use --host claude-code for human-facing output",
      "5. The CLI renders checkout QR as markdown images and links",
    ],
  },
  codex: {
    name: "Codex / Trae",
    configFile: "~/.codex/config.toml",
    instructions: [
      "1. Ensure itpay is installed:  npm install -g @itpay/cli",
      `2. Default API:                 ${DEFAULT_BASE_URL}`,
      "3. Use --agent-type codex-cli or codex-desktop",
      "4. Use --host trae or --host codex for human-facing output",
      "5. Attach the emitted QR image and show the checkout link",
      "6. Collect missing contact fields from the user; never invent them",
    ],
  },
  terminal: {
    name: "Terminal",
    configFile: "shell profile (~/.zshrc, ~/.bashrc)",
    instructions: [
      "1. Install globally:            npm install -g @itpay/cli",
      `2. Default API:                 ${DEFAULT_BASE_URL}`,
      "3. Set the real runtime type with --agent-type <type>",
      "4. Use --host terminal for text/QR output in terminal",
      "5. Override ITPAY_BACKEND_URL only for local or test backends",
    ],
  },
  telegram: {
    name: "Telegram",
    configFile: "OpenClaw gateway config",
    instructions: [
      "1. Install itpay:               npm install -g @itpay/cli",
      `2. Default API:                 ${DEFAULT_BASE_URL}`,
      "3. Set the real OpenClaw runtime with --agent-type <type>",
      "4. Use --host telegram --target <chat_id> for human-facing output",
      "5. The CLI emits openclaw_message payloads with buttons and QR images",
    ],
  },
  feishu: {
    name: "Feishu / Lark",
    configFile: "Feishu bot config",
    instructions: [
      "1. Install itpay:               npm install -g @itpay/cli",
      `2. Default API:                 ${DEFAULT_BASE_URL}`,
      "3. Set the real agent runtime with --agent-type <type>",
      "4. Use --host feishu --target <open_id> or --host lark --target <open_id>",
      "5. The CLI emits Interactive Card JSON with buttons and QR images",
    ],
  },
};

export function runInstall(target?: string): void {
  if (!target || target === "list") {
    listTargets();
    return;
  }

  const normalized = target.toLowerCase();
  if (normalized === "trae") {
    // Trae uses the codex install target
    printInstall("codex");
    return;
  }

  if (INSTALL_TARGETS[normalized]) {
    printInstall(normalized);
  } else {
    process.stderr.write(`unknown target "${target}". Available: ${Object.keys(INSTALL_TARGETS).join(", ")}\n`);
    process.exitCode = 1;
  }
}

function printInstall(key: string): void {
  const target = INSTALL_TARGETS[key];
  if (!target) return;
  process.stdout.write(`\n=== ItPay V3 CLI — Install for ${target.name} ===\n`);
  process.stdout.write(`Config file: ${target.configFile}\n\n`);
  for (const line of target.instructions) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write("\n");
}

function listTargets(): void {
  process.stdout.write("Available install targets:\n\n");
  for (const [key, target] of Object.entries(INSTALL_TARGETS)) {
    process.stdout.write(`  ${key.padEnd(14)} ${target.name.padEnd(18)} ${target.configFile}\n`);
  }
}
