import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findDocsDir(): string {
  if (process.env.ITPAY_CLI_DOCS_DIR) {
    return process.env.ITPAY_CLI_DOCS_DIR;
  }
  // dist/src/commands → ../../../docs/agent/buyer = <pkg>/docs/agent/buyer
  const pkgPath = resolve(__dirname, "..", "..", "..", "docs", "agent", "buyer");
  if (existsSync(pkgPath)) return pkgPath;
  // src/commands → ../../docs/agent/buyer = <pkg>/docs/agent/buyer (dev mode)
  const devPath = resolve(__dirname, "..", "..", "docs", "agent", "buyer");
  if (existsSync(devPath)) return devPath;
  return pkgPath;
}

const DOCS_DIR = findDocsDir();

interface AgentDoc {
  schema_version: string;
  topic: string;
  title: string;
  purpose: string;
  when_to_use?: string[];
  search_terms?: string[];
}

function loadDocs(): AgentDoc[] {
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = readFileSync(resolve(DOCS_DIR, file), "utf-8");
    return JSON.parse(raw) as AgentDoc;
  });
}

export function runDocsList(): void {
  const docs = loadDocs();
  process.stdout.write(`Agent docs (${docs.length} topics):\n\n`);
  for (const doc of docs) {
    process.stdout.write(`  ${doc.topic}\n`);
    process.stdout.write(`    title:   ${doc.title}\n`);
    process.stdout.write(`    purpose: ${doc.purpose}\n\n`);
  }
}

export function runDocsShow(topic: string): void {
  const docs = loadDocs();
  const doc = docs.find((d) => d.topic === topic);
  if (!doc) {
    process.stderr.write(`doc topic "${topic}" not found. Use "itpay docs list" to see available topics.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
}

export function runDocsSearch(query: string): void {
  const docs = loadDocs();
  const lower = query.toLowerCase();
  const results = docs.filter((doc) => {
    const text = [doc.topic, doc.title, doc.purpose, ...(doc.search_terms ?? [])].join(" ").toLowerCase();
    return text.includes(lower);
  });
  if (results.length === 0) {
    process.stdout.write(`no docs match "${query}"\n`);
    return;
  }
  process.stdout.write(`${results.length} matching docs:\n\n`);
  for (const doc of results) {
    process.stdout.write(`  ${doc.topic} — ${doc.title}\n`);
  }
}
