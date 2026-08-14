import type { BackendClient } from "../client/backend.js";
import type { ServiceFeedbackOptions } from "../client/types.js";
import type { OutputSink } from "../render/sink.js";
import { CLI_VERSION } from "../state/config.js";
import { CommandContractError, writeCommandEnvelope } from "./guidance.js";

const MAX_FEEDBACK_NOTE_CODE_POINTS = 2000;

export interface FeedbackSubmitOptions {
  rating?: string;
  note?: string;
  itemRank?: string;
  environment: "production" | "development";
  agentType?: string;
  jsonOutput?: boolean;
  output?: OutputSink;
}

interface FeedbackItemChoice {
  rank: number;
  item: ServiceFeedbackOptions["items"][number];
  title: string;
  subject?: string;
}

export async function runFeedbackSubmit(
  backend: BackendClient,
  orderID: string | undefined,
  options: FeedbackSubmitOptions,
): Promise<void> {
  const normalizedOrderID = orderID?.trim() ?? "";
  if (!normalizedOrderID) {
    throw new CommandContractError(
      "order_required",
      "--order is required",
      "从当前 exact Local Agent 的 Service Execution 恢复原订单；不要要求用户提供内部 ID，也不要用账号订单、Vault 或 MCP 读取权绕过。本次未提交反馈。",
      [{ command: "itpay services list --json", reason: "恢复当前 Local Agent 可见的原服务" }],
    );
  }
  const rating = normalizeFeedbackRating(options.rating);
  const itemRank = normalizeItemRank(options.itemRank);
  const userNote = normalizeUserNote(options.note ?? "");
  const context = await backend.getServiceFeedbackOptions(normalizedOrderID);
  const choices = feedbackItemChoices(context);

  if (choices.length === 0) {
    throw new CommandContractError(
      "feedback_unavailable",
      "this order has no service item available for feedback",
      "告诉用户这笔订单当前没有可评价的服务项目并停止；不要猜测项目 ID、切换身份或创建其他反馈。",
      [],
    );
  }

  if (choices.length > 1 && itemRank === undefined) {
    writeCommandEnvelope({
      status: "feedback_item_selection_required",
      result: {
        ...(context.order_code ? { order_code: context.order_code } : {}),
        items: choices.map(({ rank, title, subject }) => ({ rank, title, ...(subject ? { subject } : {}) })),
      },
      instruction: "用服务名称和主题让用户选择要复盘哪一项；不要展示内部 ID。用户选择后，Agent 使用同一订单、已有评分或留言（如有）并加入所选 item rank 自己执行提交。",
      next: null,
      recovery: [],
    }, outputOptions(options));
    return;
  }

  const choice = itemRank === undefined
    ? choices[0]
    : choices.find((candidate) => candidate.rank === itemRank);
  if (!choice) {
    throw new CommandContractError(
      "feedback_item_invalid",
      `item rank ${itemRank} is not available for feedback`,
      "只使用当前订单返回的服务项目编号；不要猜测内部 ID。本次未提交反馈。",
      [],
    );
  }

  const note = formatFeedbackNote({
    userNote,
    hasRating: rating !== undefined,
    outcome: context.status,
    serviceTitle: choice.title,
    environment: options.environment,
    ...(options.agentType ? { agentType: options.agentType } : {}),
  });
  if (codePointLength(note) > MAX_FEEDBACK_NOTE_CODE_POINTS) {
    throw new CommandContractError(
      "feedback_note_too_long",
      `formatted feedback note exceeds ${MAX_FEEDBACK_NOTE_CODE_POINTS} Unicode code points`,
      "请用户缩短反馈内容；不要截断、改写或拆分提交。本次未提交反馈。",
      [],
    );
  }

  const response = await backend.submitServiceFeedback(normalizedOrderID, {
    order_item_id: choice.item.order_item_id!,
    ...(rating !== undefined ? { rating } : {}),
    note,
  });
  writeCommandEnvelope({
    status: "feedback_submitted",
    result: {
      ...(context.order_code ? { order_code: context.order_code } : {}),
      service_title: choice.title,
      ...(response.feedback.rating !== undefined ? { rating: response.feedback.rating } : {}),
      feedback_status: response.feedback.status,
    },
    instruction: rating !== undefined || userNote
      ? "告诉用户反馈已经记录并表示感谢，然后停止。不要承诺回复、处理时间、退款或结果变更。"
      : "服务复盘已经记录；无需打扰用户，停止。不要声称用户给了评分或评论。",
    next: null,
    recovery: [],
  }, outputOptions(options));
}

export function normalizeFeedbackRating(value: string | undefined): number | undefined {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return undefined;
  const numeric = normalized.match(/^([1-5])(?:\s*(?:\/\s*5|分|星|stars?))?$/u);
  if (numeric) return Number(numeric[1]);
  const chinese = normalized.match(/^([一二三四五])(?:分|星)?$/u)?.[1];
  if (chinese) return ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 } as const)[chinese as "一" | "二" | "三" | "四" | "五"];
  throw new CommandContractError(
    "feedback_rating_invalid",
    "--rating must be an explicit score from 1 to 5",
    "请用户明确给出 1–5 分；不要从好评、差评或情绪推断评分。本次未提交反馈。",
    [],
  );
}

function normalizeItemRank(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = value.trim().match(/^#?([1-9]\d*)$/u);
  if (!match) {
    throw new CommandContractError(
      "feedback_item_invalid",
      "--item-rank must be a positive integer",
      "使用当前订单返回的正整数服务项目编号；本次未提交反馈。",
      [],
    );
  }
  const rank = Number(match[1]);
  if (!Number.isSafeInteger(rank)) {
    throw new CommandContractError(
      "feedback_item_invalid",
      "--item-rank is outside the supported integer range",
      "使用当前订单返回的服务项目编号；本次未提交反馈。",
      [],
    );
  }
  return rank;
}

function feedbackItemChoices(context: ServiceFeedbackOptions): FeedbackItemChoice[] {
  return context.items.flatMap((item, index) => {
    if (!item.order_item_id?.trim()) return [];
    const subject = safeLine(item.subject ?? "").slice(0, 160);
    return [{
      rank: index + 1,
      item,
      title: safeLine(item.title) || "未命名服务",
      ...(subject ? { subject } : {}),
    }];
  });
}

function normalizeUserNote(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
}

function formatFeedbackNote(input: {
  userNote: string;
  hasRating: boolean;
  outcome: string;
  serviceTitle: string;
  environment: "production" | "development";
  agentType?: string;
}): string {
  const summary = input.userNote
    ? `## Summary\n${input.userNote.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`
    : "";
  return `${summary}## Context\n` + [
    "- Source: agent-postmortem",
    `- Human input: ${humanInputSummary(input.hasRating, Boolean(input.userNote))}`,
    `- Outcome: ${safeLine(input.outcome) || "unknown"}`,
    `- Service: ${safeLine(input.serviceTitle) || "未命名服务"}`,
    `- Client: @itpay/cli ${CLI_VERSION}`,
    `- Agent type: ${safeLine(input.agentType ?? "unspecified")}`,
    `- Environment: ${input.environment}`,
  ].join("\n");
}

function humanInputSummary(hasRating: boolean, hasComment: boolean): string {
  if (hasRating && hasComment) return "rating and comment included";
  if (hasRating) return "rating included";
  if (hasComment) return "comment included";
  return "not provided";
}

function safeLine(value: string): string {
  return value.replace(/[\r\n\u0000-\u001F\u007F]+/gu, " ").trim();
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function outputOptions(options: FeedbackSubmitOptions): { jsonOutput?: boolean; output?: OutputSink; agentType?: string } {
  return {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.agentType ? { agentType: options.agentType } : {}),
  };
}
