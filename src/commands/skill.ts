import {createHash} from "node:crypto";
import {CANONICAL_SKILL_SHA256, CANONICAL_API_SKILL_SHA256} from "../state/skill_identity.generated.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageResourcePath } from "../state/package_resources.js";

import type { OutputSink } from "../render/sink.js";
import { CODEX_WAIT_GUIDANCE } from "./install.js";
import { declaredAgentType } from "../state/agent_type.js";
import { CommandContractError, writeCommandEnvelope } from "./guidance.js";

const ITPAY_SKILL = "itpay";

export interface SkillOptions {
  jsonOutput?: boolean;
  output?: OutputSink;
  agentType?: string;
}

export function runSkillShow(name: string, options: SkillOptions = {}): void {
  const normalized = name.trim().toLowerCase();
  if (normalized === "itpay-api") {
    showAPISkill(options);
    return;
  }
  if (normalized !== ITPAY_SKILL && normalized !== "itpay-buyer") {
    throw new CommandContractError(
      "skill_not_found",
      `skill not found: ${name}`,
      `当前 CLI 内置 ${ITPAY_SKILL}（Services）和 itpay-api（API）；不要猜测 Skill 名称。`,
      [{ command: `itpay skill show ${ITPAY_SKILL} --json`, reason: "读取完整 ItPay Skill" }],
    );
  }
  const original = packagedSkill();
  let content: string;
  try {
    content = readFileSync(findSkillPath(), "utf8");
  } catch (error) {
    if (process.env.ITPAY_CLI_SKILLS_DIR) {
      const cause = error && typeof error === "object" && "code" in error ? String(error.code) : "read_failed";
      throw new CommandContractError("skill_override_unavailable", "configured Skill cannot be read",
        "覆盖路径不可读取；当前包原文可用。直接读取 result.skill_path 并按宿主方式启用，不另装全局包。", [], undefined,
        { skill_path: original.path, cause_code: cause });
    }
    throw error;
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
  let path = findSkillPath(false);
  // A bundled Skill registers one canonical root; its unchanged Buyer payload
  // may omit the duplicate markdown only when that root matches this build.
  if (!existsSync(path) && process.env.ITPAY_CLI_SKILLS_DIR) path = findSkillPath();
  const content = readFileSync(path, "utf8");
  if (createHash("sha256").update(content).digest("hex") !== CANONICAL_SKILL_SHA256) {
    throw new CommandContractError("skill_override_mismatch", "Skill does not match this pinned CLI build", "使用当前包同源的完整 Skill；保留原任务和身份，不安装另一套 CLI。", []);
  }
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
  return packageResourcePath("skills",ITPAY_SKILL,"SKILL.md");
}

function validateSkill(content: string): void {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || !/^name:\s*itpay\s*$/m.test(frontmatter) || !/^description:\s*(?:>|\S)/m.test(frontmatter)) {
    throw new Error("invalid packaged skill: itpay");
  }
}

// API always reads its own pinned package resource. Services override roots and
// Services onboarding must never replace the API instruction or its identity.
function showAPISkill(options: SkillOptions): void {
  let content: string;
  try {
    content = readFileSync(packageResourcePath("skills", "itpay-api", "SKILL.md"), "utf8");
  } catch {
    throw new CommandContractError("skill_unavailable", "packaged API Skill cannot be read",
      "包内 API Skill 缺失或不可读取；通过原分发方式恢复同版本完整包，不回退 Services Skill。", []);
  }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (createHash("sha256").update(content).digest("hex") !== CANONICAL_API_SKILL_SHA256
    || !frontmatter || !/^name:\s*itpay-api\s*$/m.test(frontmatter)
    || !/^description:\s*(?:>|\S)/m.test(frontmatter)) {
    throw new CommandContractError("skill_mismatch", "packaged API Skill does not match this pinned CLI build",
      "包内 API Skill 名称或原文校验失败；通过原分发方式恢复同版本完整包，不使用 Services 覆盖路径或下载替代指引。", []);
  }
  const agentType = options.agentType ?? declaredAgentType();
  writeCommandEnvelope({
    status: "shown",
    result: { skill: "itpay-api", content },
    instruction: "完整读取 API Skill，按用户任务使用 itpay api --help；需要认证时由本人完成 api connect，已有任务沿原引用恢复。保持真实宿主、Hub 端点和状态目录。",
    next: null,
    recovery: [],
  }, {
    ...options,
    ...(agentType ? { agentType } : {}),
    plainResult: content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"),
  });
}
