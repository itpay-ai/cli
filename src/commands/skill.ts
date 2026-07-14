import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { OutputSink } from "../render/sink.js";
import { declaredAgentType } from "../state/agent_type.js";
import { CommandContractError, writeCommandEnvelope } from "./guidance.js";

const commandDir = dirname(fileURLToPath(import.meta.url));
const BUYER_SKILL = "itpay-buyer";

export interface SkillOptions {
  jsonOutput?: boolean;
  output?: OutputSink;
  agentType?: string;
}

export function runSkillShow(name: string, options: SkillOptions = {}): void {
  const normalized = name.trim().toLowerCase();
  if (normalized !== BUYER_SKILL) {
    throw new CommandContractError(
      "skill_not_found",
      `skill not found: ${name}`,
      `当前 CLI 只内置 ${BUYER_SKILL}；不要猜测 Skill 名称。`,
      [{ command: `itpay skill show ${BUYER_SKILL} --json`, reason: "读取完整 Buyer Skill" }],
    );
  }
  let content: string;
  try {
    content = readFileSync(findSkillPath(), "utf8");
  } catch {
    throw new Error("packaged skill is unavailable: itpay-buyer");
  }
  validateSkill(content);
  const agentType = options.agentType ?? declaredAgentType();
  const envelope = {
    status: "shown",
    result: { skill: BUYER_SKILL, content },
    instruction: agentType
      ? agentType === "workbuddy"
        ? "完整读取并遵守 Skill；保持 workbuddy、同一 Node/CLI launcher 和可持久写入 Device 状态的执行权限。内部诊断不要逐步转述给用户。"
        : `完整读取并遵守 Skill；当前 Agent Type 是 ${agentType}，后续命令保持不变。`
      : "完整读取并遵守 Skill；先如实选择当前运行环境对应的 Agent Type。",
    next: agentType
      ? { command: "itpay catalog list --json", reason: "按 Skill 开始发现服务" }
      : { command: "itpay install --json", reason: "选择真实且稳定的 Agent Type" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...options,
    ...(agentType ? { agentType } : {}),
    plainResult: content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"),
  });
}

function findSkillPath(): string {
  if (process.env.ITPAY_CLI_SKILLS_DIR) {
    return resolve(process.env.ITPAY_CLI_SKILLS_DIR, BUYER_SKILL, "SKILL.md");
  }
  const packagePath = resolve(commandDir, "..", "..", "..", "skills", BUYER_SKILL, "SKILL.md");
  if (existsSync(packagePath)) return packagePath;
  return resolve(commandDir, "..", "..", "skills", BUYER_SKILL, "SKILL.md");
}

function validateSkill(content: string): void {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || !/^name:\s*itpay-buyer\s*$/m.test(frontmatter) || !/^description:\s*(?:>|\S)/m.test(frontmatter)) {
    throw new Error("invalid packaged skill: itpay-buyer");
  }
}
