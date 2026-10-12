import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { OutputSink } from "../render/sink.js";
import { CODEX_WAIT_GUIDANCE } from "./install.js";
import { declaredAgentType } from "../state/agent_type.js";
import { CommandContractError, writeCommandEnvelope } from "./guidance.js";

const commandDir = dirname(fileURLToPath(import.meta.url));
const ITPAY_SKILL = "itpay";

export interface SkillOptions {
  jsonOutput?: boolean;
  output?: OutputSink;
  agentType?: string;
}

export function runSkillShow(name: string, options: SkillOptions = {}): void {
  const normalized = name.trim().toLowerCase();
  if (normalized !== ITPAY_SKILL) {
    throw new CommandContractError(
      "skill_not_found",
      `skill not found: ${name}`,
      `当前 CLI 只内置 ${ITPAY_SKILL}；不要猜测 Skill 名称。`,
      [{ command: `itpay skill show ${ITPAY_SKILL} --json`, reason: "读取完整 ItPay Skill" }],
    );
  }
  const original = packagedSkill();
  let content: string;
  try {
    content = readFileSync(findSkillPath(), "utf8");
  } catch {
    throw new Error("packaged skill is unavailable: itpay");
  }
  if (content !== original.content) {
    throw new CommandContractError("skill_override_mismatch", "configured Skill differs from the current package",
      "覆盖路径中的 Skill 不是当前包原文。直接读取 result.skill_path 并按宿主方式启用，不使用陈旧或改写内容。", [], undefined,
      { skill_path: original.path });
  }
  validateSkill(content);
  const agentType = options.agentType ?? declaredAgentType();
  if (agentType?.startsWith("codex-")) content += `\n## Codex command continuation\n\n${CODEX_WAIT_GUIDANCE}\n`;
  const envelope = {
    status: "shown",
    result: { skill: ITPAY_SKILL, content },
    instruction: agentType
      ? agentType === "workbuddy"
        ? "完整读取原文并按宿主技能方式保存启用；按用户意图选择第一条业务命令。保持 workbuddy、同一入口和 Backend；只有实际持久化操作被拒时才沿宿主正式流程申请所需权限，拒绝后报告受阻操作，不删除 identity。"
        : `完整读取原文并按宿主技能方式保存启用；把自己视为服务用户的代理，先理解用户意图和解释用户权益，再选择购买、已购内容、订单或退款对应的第一条命令。当前 Agent Type 是 ${agentType}，后续命令保持不变。`
      : "完整读取并遵守 Skill；先如实选择当前运行环境对应的 Agent Type。",
    next: agentType
      ? null
      : { command: "itpay install --json", reason: "选择真实且稳定的 Agent Type" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...options,
    ...(agentType ? { agentType } : {}),
    plainResult: content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"),
  });
}

export function packagedSkill(): { path: string; content: string } {
  const path = findSkillPath(false);
  const content = readFileSync(path, "utf8");
  validateSkill(content);
  return { path, content };
}

function findSkillPath(allowOverride = true): string {
  if (allowOverride && process.env.ITPAY_CLI_SKILLS_DIR) {
    const configuredRoot = resolve(process.env.ITPAY_CLI_SKILLS_DIR);
    const directPath = resolve(configuredRoot, "SKILL.md");
    if (existsSync(directPath)) return directPath;
    return resolve(configuredRoot, ITPAY_SKILL, "SKILL.md");
  }
  const bundlePath = resolve(commandDir, "skills", ITPAY_SKILL, "SKILL.md");
  if (existsSync(bundlePath)) return bundlePath;
  const packagePath = resolve(commandDir, "..", "..", "..", "skills", ITPAY_SKILL, "SKILL.md");
  if (existsSync(packagePath)) return packagePath;
  return resolve(commandDir, "..", "..", "skills", ITPAY_SKILL, "SKILL.md");
}

function validateSkill(content: string): void {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || !/^name:\s*itpay\s*$/m.test(frontmatter) || !/^description:\s*(?:>|\S)/m.test(frontmatter)) {
    throw new Error("invalid packaged skill: itpay");
  }
}
