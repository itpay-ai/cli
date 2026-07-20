import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { OutputSink } from "../render/sink.js";
import { resolveOutput } from "../render/sink.js";
import { CommandContractError, writeCommandEnvelope } from "./guidance.js";

const commandDir = dirname(fileURLToPath(import.meta.url));

interface AgentDoc extends Record<string, unknown> {
  schema_version: string;
  product_scope: string;
  topic: string;
  title: string;
  purpose: string;
  when_to_use?: string[];
  search_terms?: string[];
}

interface DocsOptions {
  jsonOutput?: boolean;
  output?: OutputSink;
}

export function runDocsList(options: DocsOptions = {}): void {
  const topics = loadDocs().map(({ topic, title, purpose }) => ({ topic, title, purpose }));
  writeCommandEnvelope({
    status: "listed",
    result: { topics },
    instruction: "选择与当前步骤最接近的一个 topic；不要一次加载全部文档。",
    next: null,
    recovery: [],
  }, {
    ...options,
    plainResult: topics.flatMap((doc) => [`${doc.topic}: ${doc.title}`, `  ${doc.purpose}`]),
  });
}

export function runDocsShow(topic: string, options: DocsOptions = {}): void {
  const normalized = topic.trim();
  const doc = loadDocs().find((candidate) => candidate.topic === normalized);
  if (!doc) {
    throw new CommandContractError(
      "doc_not_found",
      `doc topic not found: ${topic}`,
      "使用稳定 topic 名称；不要根据标题猜 topic。",
      [
        { command: "itpay docs list --json", reason: "列出全部 topic" },
        { command: `itpay docs search ${shellWord(normalized || "topic")} --json`, reason: "按关键词重新搜索" },
      ],
    );
  }

  const envelope = {
    status: "shown",
    result: { topic: doc.topic, content: doc },
    instruction: "只执行文档中与当前服务端状态匹配的步骤；服务端返回的当前 next 优先。",
    next: null,
    recovery: [],
  };
  if (options.jsonOutput) {
    writeCommandEnvelope(envelope, options);
    return;
  }
  const out = resolveOutput(options.output);
  out("shown\n");
  out(`${JSON.stringify(doc, null, 2)}\n`);
  out(`instruction: ${envelope.instruction}\n`);
}

export function runDocsSearch(query: string, options: DocsOptions = {}): void {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    throw new CommandContractError(
      "docs_query_required",
      "docs search query must not be empty",
      "提供一个 topic、标题、用途或 search term 关键词。",
      [{ command: "itpay docs list --json", reason: "不确定关键词时列出 topic" }],
    );
  }
  const topics = loadDocs()
    .filter((doc) => searchableText(doc).includes(normalized))
    .map(({ topic, title, purpose }) => ({ topic, title, purpose }));
  if (topics.length === 0) {
    writeCommandEnvelope({
      status: "no_match",
      result: { query, topics: [] },
      instruction: "没有匹配文档；缩短关键词，或列出全部 topic。",
      next: { command: "itpay docs list --json", reason: "浏览稳定 topic" },
      recovery: [],
    }, options);
    return;
  }

  writeCommandEnvelope({
    status: "matched",
    result: { query, topics },
    instruction: topics.length === 1
      ? "已唯一匹配；读取该 topic。"
      : "选择最相关的一个 topic；不要同时展开全部结果。",
    next: topics.length === 1
      ? { command: `itpay docs show ${topics[0]!.topic} --json`, reason: "读取唯一匹配文档" }
      : null,
    recovery: [],
  }, {
    ...options,
    plainResult: topics.map((doc) => `${doc.topic}: ${doc.title}`),
  });
}

function loadDocs(): AgentDoc[] {
  const docsDir = findDocsDir();
  const files = readdirSync(docsDir).filter((file) => file.endsWith(".json")).sort();
  return files.map((file) => parseDoc(readFileSync(resolve(docsDir, file), "utf8"), file))
    .sort((left, right) => left.topic.localeCompare(right.topic));
}

function findDocsDir(): string {
  if (process.env.ITPAY_CLI_DOCS_DIR) return resolve(process.env.ITPAY_CLI_DOCS_DIR);
  const packagePath = resolve(commandDir, "..", "..", "..", "docs", "agent", "buyer");
  if (existsSync(packagePath)) return packagePath;
  return resolve(commandDir, "..", "..", "docs", "agent", "buyer");
}

function parseDoc(raw: string, file: string): AgentDoc {
  const value = JSON.parse(raw) as Partial<AgentDoc>;
  if (
    typeof value.schema_version !== "string" ||
    typeof value.product_scope !== "string" ||
    typeof value.topic !== "string" ||
    typeof value.title !== "string" ||
    typeof value.purpose !== "string"
  ) {
    throw new Error(`invalid agent doc: ${file}`);
  }
  return value as AgentDoc;
}

function searchableText(doc: AgentDoc): string {
  return [doc.topic, doc.title, doc.purpose, ...(doc.search_terms ?? [])].join(" ").toLowerCase();
}

function shellWord(value: string): string {
  return /^[a-zA-Z0-9._-]+$/.test(value) ? value : JSON.stringify(value);
}
