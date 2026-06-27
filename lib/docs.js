import fs from "node:fs";
import path from "node:path";
import { CLI_DIR, PACKAGE_ROOT, cliCommand, output, positionalArgs, readJSON } from "./env.js";

async function docs(command, rest = [], flags = {}) {
  const role = normalizeDocsRole(flags.role || "buyer");
  if (command === "list" || !command) {
    const docsList = listAgentDocs(role);
    output({
      schema_version: "itp.agent_doc_index.v1",
      role,
      topics: docsList.map((doc) => ({
        topic: doc.topic,
        title: doc.title,
        purpose: doc.purpose,
        command: cliCommand("docs", "show", doc.topic, "--role", role, "--json"),
        next_docs: Array.isArray(doc.next_docs) ? doc.next_docs.map((next) => next.topic).filter(Boolean) : []
      })),
      start_here: cliCommand("docs", "show", "quickstart", "--role", role, "--json"),
      search_command: cliCommand("docs", "search", "<question>", "--role", role, "--json")
    });
    return;
  }
  if (command === "show" || command === "read") {
    const topic = flags.topic || positionalArgs(rest)[0] || "quickstart";
    output(loadAgentDoc(role, topic));
    return;
  }
  if (command === "search") {
    const query = String(flags.query || flags.q || positionalArgs(rest).join(" ")).trim();
    if (!query) throw new Error("docs search query is required");
    const matches = searchAgentDocs(role, query);
    output({
      schema_version: "itp.agent_doc_search.v1",
      role,
      query,
      matches,
      fallback: matches.length ? null : {
        topic: "quickstart",
        command: cliCommand("docs", "show", "quickstart", "--role", role, "--json")
      }
    });
    return;
  }
  throw new Error(`unknown docs command: ${command}`);
}

function normalizeDocsRole(role) {
  const normalized = String(role || "buyer").trim().toLowerCase();
  if (normalized === "buyer" || normalized === "itpay-buyer") return "buyer";
  throw new Error(`unsupported docs role: ${role}`);
}

function listAgentDocs(role) {
  const docsDir = resolveDocsDir(role);
  return fs.readdirSync(docsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => loadAgentDoc(role, name.replace(/\.json$/, "")))
    .sort((a, b) => docTopicOrder(a.topic) - docTopicOrder(b.topic) || a.topic.localeCompare(b.topic));
}

function loadAgentDoc(role, topic) {
  const normalizedTopic = normalizeDocTopic(topic);
  const file = path.join(resolveDocsDir(role), `${normalizedTopic}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`agent docs topic not found: ${normalizedTopic}`);
  }
  const doc = readJSON(file, null);
  if (!doc || doc.role !== role || doc.topic !== normalizedTopic) {
    throw new Error(`invalid agent docs topic: ${normalizedTopic}`);
  }
  return {
    ...doc,
    source: {
      packaged_path: file,
      command: cliCommand("docs", "show", normalizedTopic, "--role", role, "--json")
    }
  };
}

function searchAgentDocs(role, query) {
  const rawQuery = String(query).toLowerCase();
  const terms = rawQuery.split(/\s+/).filter(Boolean);
  return listAgentDocs(role)
    .map((doc) => {
      const docTerms = (doc.search_terms || []).map((term) => String(term).toLowerCase()).filter(Boolean);
      const haystack = [
        doc.topic,
        doc.title,
        doc.purpose,
        ...(doc.when_to_use || []),
        ...(doc.agent_rules || []),
        ...(doc.forbidden || []),
        ...docTerms
      ].join(" ").toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) +
        docTerms.reduce((sum, term) => sum + (rawQuery.includes(term) ? 1 : 0), 0);
      return { doc, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || docTopicOrder(a.doc.topic) - docTopicOrder(b.doc.topic))
    .slice(0, 5)
    .map((entry) => ({
      topic: entry.doc.topic,
      title: entry.doc.title,
      purpose: entry.doc.purpose,
      score: entry.score,
      command: cliCommand("docs", "show", entry.doc.topic, "--role", role, "--json"),
      next_docs: Array.isArray(entry.doc.next_docs) ? entry.doc.next_docs.map((next) => next.topic).filter(Boolean) : []
    }));
}

function resolveDocsDir(role) {
  const candidates = [
    process.env.ITPAY_CLI_DOCS_DIR,
    path.join(PACKAGE_ROOT, "docs", "agent", role),
    path.join(path.dirname(CLI_DIR), "share", "itpay_cli", "docs", "agent", role),
    path.join(process.cwd(), "docs", "agent", role)
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`ItPay agent docs not found for role ${role}. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

function normalizeDocTopic(topic) {
  return String(topic || "").trim().toLowerCase().replaceAll("_", "-");
}

function docTopicOrder(topic) {
  const order = [
    "quickstart",
    "catalog-search",
    "product-recommendation",
    "cart-checkout",
    "payment-qr",
    "payment-wait",
    "qr-refresh",
    "secure-delivery",
    "human-claim-ui",
    "account-portal",
    "vault-agent-read",
    "recovery",
    "safety-policy"
  ];
  const index = order.indexOf(topic);
  return index === -1 ? 999 : index;
}

async function skill(command, flags) {
  const role = normalizeSkillRole(flags.role || flags.skill || "buyer");
  const skillPath = resolveSkillPath(role);
  if (!command || command === "show" || command === "read") {
    const content = fs.readFileSync(skillPath, "utf8");
    if (flags.json) {
      output({ skill: "itpay-buyer", role, path: skillPath, content });
    } else {
      process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    }
    return;
  }
  if (command === "path") {
    if (flags.json) {
      output({ skill: "itpay-buyer", role, path: skillPath });
    } else {
      process.stdout.write(`${skillPath}\n`);
    }
    return;
  }
  throw new Error(`unknown skill command: ${command}`);
}

function normalizeSkillRole(role) {
  const normalized = String(role || "buyer").trim().toLowerCase();
  if (normalized === "buyer" || normalized === "itpay-buyer") return "buyer";
  if (normalized === "merchant" || normalized === "itpay-merchant") {
    throw new Error("merchant skill is not packaged yet; use --role buyer for current external-agent tests");
  }
  throw new Error(`unsupported skill role: ${role}`);
}

function resolveSkillPath(role = "buyer") {
  const skillDirName = "itpay-buyer";
  const envPath = process.env.ITPAY_BUYER_SKILL_PATH;
  const candidates = [
    envPath,
    process.env.ITPAY_CLI_SKILL_PATH,
    path.join(PACKAGE_ROOT, "skills", skillDirName, "SKILL.md"),
    path.join(path.dirname(CLI_DIR), "share", "itpay_cli", "skills", skillDirName, "SKILL.md"),
    path.join(process.cwd(), "skills", skillDirName, "SKILL.md")
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`ItPay skill file not found for role ${role}. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

export { docs, skill };
