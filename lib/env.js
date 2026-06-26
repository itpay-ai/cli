import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_API_BASE = process.env.ITPAY_API_BASE || process.env.ITPAY_CORE_API_BASE || process.env.ITPAY_CORE_BASE_URL || "https://dev.api.itpay.ai";
export const CONFIG_DIR = path.join(os.homedir(), ".itp");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const STATE_PATH = path.join(CONFIG_DIR, "state.json");
export const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
export const RUNS_DIR = path.join(CONFIG_DIR, "runs");
export const LOCK_PATH = path.join(CONFIG_DIR, "state.lock");
const PACKAGE_ROOT_FROM_ENV = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CLI_FILE = fs.existsSync(path.join(PACKAGE_ROOT_FROM_ENV, "bin", "itp"))
  ? path.join(PACKAGE_ROOT_FROM_ENV, "bin", "itp")
  : path.join(PACKAGE_ROOT_FROM_ENV, "bin", "itp.js");
export const CLI_DIR = path.dirname(CLI_FILE);
export const PACKAGE_ROOT = PACKAGE_ROOT_FROM_ENV;
export const VERSION = packageVersion();

function csvValues(value) {
  if (value === undefined || value === null || value === false) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function booleanFlag(value) {
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`invalid boolean flag value: ${value}`);
}

function intFlag(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function splitCSV(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function queryString(params) {
  const raw = params.toString();
  return raw ? `?${raw}` : "";
}

function appendURLQuery(target, params) {
  const suffix = params.toString();
  if (!suffix) return target;
  return `${target}${String(target).includes("?") ? "&" : "?"}${suffix}`;
}

function positional(values, index) {
  const value = values[index];
  if (!value || String(value).startsWith("--")) return "";
  return String(value);
}

function positionalArgs(values = []) {
  const result = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value) continue;
    if (String(value).startsWith("--")) {
      const next = values[i + 1];
      if (next && !String(next).startsWith("--")) i += 1;
      continue;
    }
    result.push(String(value));
  }
  return result;
}

function stripInternalBuyerFields(value) {
  if (Array.isArray(value)) return value.map(stripInternalBuyerFields);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "next_actions") continue;
    result[key] = stripInternalBuyerFields(nested);
  }
  return result;
}

function apiTimeoutMs(flags = {}) {
  const seconds = Number(flags.api_timeout || process.env.ITP_API_TIMEOUT_SECONDS || 45);
  if (!Number.isFinite(seconds) || seconds <= 0) return 45000;
  return Math.max(5000, seconds * 1000);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replaceAll("-", "_");
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function normalizePurchaseFlags(flags, required = false) {
  const plan = typeof flags.plan === "string" ? flags.plan.trim() : "";
  const rawCredits = flags.credits ?? flags.credit ?? null;
  const hasCredits = rawCredits !== null && rawCredits !== undefined && rawCredits !== false;
  if (plan && hasCredits) {
    throw new Error("use either --plan or --credits, not both");
  }
  if (hasCredits) {
    const credits = Number(rawCredits);
    if (!Number.isInteger(credits) || credits < 20) {
      throw new Error("--credits must be an integer greater than or equal to 20");
    }
    return {
      kind: "custom",
      plan: null,
      credits,
      key: `credits-${credits}`
    };
  }
  if (plan) {
    if (plan === "coding-100") {
      throw new Error("coding-100 is disabled; use credit-100, credit-300, credit-500, or --credits <amount>");
    }
    return {
      kind: "plan",
      plan,
      credits: null,
      key: `plan-${plan}`
    };
  }
  if (required) {
    throw new Error("choose a purchase: --credits <integer >=20> or --plan credit-100|credit-300|credit-500");
  }
  return { kind: null, plan: null, credits: null, key: "none" };
}

function apiBase(flags = {}, config = readConfig()) {
  return (flags.api_base || config.api_base || DEFAULT_API_BASE).replace(/\/$/, "");
}

function readConfig() {
  return readJSON(CONFIG_PATH, {});
}

function packageVersion() {
  for (const file of [
    path.join(PACKAGE_ROOT, "package.json"),
    path.join(PACKAGE_ROOT, "share", "itpay_cli", "package.json")
  ]) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).version || "0.0.0";
    } catch {
      // Try the next install layout.
    }
  }
  return "0.0.0";
}

function writeConfig(value) {
  writeJSON0600(CONFIG_PATH, value);
}

function readState() {
  return readJSON(STATE_PATH, {});
}

function writeState(value) {
  writeJSON0600(STATE_PATH, value);
}

function runPath(runId) {
  return path.join(RUNS_DIR, `${runId}.json`);
}

function readRun(runId) {
  if (!runId) return null;
  return readJSON(runPath(runId), null);
}

function listRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJSON(path.join(RUNS_DIR, name), null))
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

function writeRun(run) {
  if (!run?.run_id) throw new Error("run_id is required");
  ensureConfigDir();
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  try {
    fs.chmodSync(RUNS_DIR, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  const next = {
    ...run,
    schema_version: "itp.run.v1",
    updated_at: new Date().toISOString()
  };
  const file = runPath(next.run_id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  writeState({ ...readState(), current_run_id: next.run_id });
  return next;
}

function mergeRun(run, patch) {
  return {
    ...(run || {}),
    ...patch,
    auth: patch.auth === undefined ? run?.auth : { ...(run?.auth || {}), ...(patch.auth || {}) },
    account: patch.account === undefined ? run?.account : { ...(run?.account || {}), ...(patch.account || {}) },
    checkout: patch.checkout === undefined ? run?.checkout : { ...(run?.checkout || {}), ...(patch.checkout || {}) },
    payment: patch.payment === undefined ? run?.payment : { ...(run?.payment || {}), ...(patch.payment || {}) },
    grant: patch.grant === undefined ? run?.grant : { ...(run?.grant || {}), ...(patch.grant || {}) },
    result: patch.result === undefined ? run?.result : { ...(run?.result || {}), ...(patch.result || {}) }
  };
}

function updateRun(run, patch) {
  return writeRun(mergeRun(run, patch));
}

function updateCurrentRun(patch, flags = {}) {
  const run = readRun(flags.run_id || readState().current_run_id);
  if (!run) return null;
  return writeRun(mergeRun(run, patch));
}

function prepareSetupRun(flags, options) {
  const explicitRunId = flags.run_id || null;
  const state = readState();
  let run = explicitRunId ? readRun(explicitRunId) : (!flags.new_run ? readRun(state.current_run_id) : null);
  const reusable = run
    && !["done", "installed", "failed", "cancelled"].includes(run.status)
    && run.phase !== "done"
    && (!run.plan_id || run.plan_id === options.plan)
    && (options.plan || !run.credits || Number(run.credits) === Number(options.credits || 0))
    && (!run.payment_method || run.payment_method === options.method);
  if (reusable) {
    return writeRun(mergeRun(run, {
      target: options.target,
      plan_id: options.plan,
      credits: options.credits,
      purchase_kind: options.plan ? "plan" : "custom",
      payment_method: options.method,
      agent_host: flags.host || run.agent_host || null,
      agent_display: flags.display || run.agent_display || null,
      agent_qr_format: flags.qr_format || run.agent_qr_format || null,
      install_runtime: Boolean(options.install_runtime),
      status: "running"
    }));
  }
  if (flags.resume && explicitRunId && !run) {
    throw new Error(`run not found: ${explicitRunId}`);
  }
  const runId = explicitRunId || `run_${cryptoRandom()}`;
  return writeRun({
    schema_version: "itp.run.v1",
    run_id: runId,
    created_at: new Date().toISOString(),
    api_base: apiBase(flags),
    target: options.target,
    install_runtime: Boolean(options.install_runtime),
    plan_id: options.plan,
    credits: options.credits,
    purchase_kind: options.plan ? "plan" : "custom",
    payment_method: options.method,
    agent_host: flags.host || null,
    agent_display: flags.display || null,
    agent_qr_format: flags.qr_format || null,
    idempotency_key: flags.idempotency_key || `setup:${runId}:${options.plan || `credits-${options.credits}`}`,
    phase: "new",
    status: "running",
    safe_summary: "Setup started."
  });
}

async function withStateLock(fn) {
  ensureConfigDir();
  const staleMs = 10 * 60 * 1000;
  try {
    const stat = fs.statSync(LOCK_PATH);
    const lock = readJSON(LOCK_PATH, {});
    if ((lock.pid && !processIsRunning(lock.pid)) || Date.now() - stat.mtimeMs > staleMs) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {
    // No lock or unreadable stale state.
  }
  let fd;
  try {
    fd = fs.openSync(LOCK_PATH, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  } catch {
    const error = new Error(`another itp setup/status operation is running; if no other ItPay CLI is active, remove the stale lock and retry: rm -f ${LOCK_PATH}`);
    error.next = [
      { type: "check_status", command: cliCommand("status", "--refresh", "--json"), safe_for_agent: true },
      { type: "clear_stale_lock", command: `rm -f ${shellQuote(LOCK_PATH)}`, safe_for_agent: true }
    ];
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // Best effort cleanup.
    }
  }
}

function readCredentials() {
  return readJSON(CREDENTIALS_PATH, {});
}

function writeCredentials(value) {
  writeJSON0600(CREDENTIALS_PATH, value);
}

function writeJSON0600(file, value) {
  ensureConfigDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writeSessionCredentials(response) {
  const currentAccountId = readConfig().account_id;
  let credentials = deleteSessionCredential(readCredentials());
  if (currentAccountId && currentAccountId !== response.account_id) {
    for (const key of Object.keys(credentials)) {
      if (key.startsWith("grant_")) {
        const grantId = key.slice("grant_".length);
        deleteGrantCredential(grantId);
      }
    }
    credentials = {};
  }
  writeCredentials({ ...credentials, ...storeSessionCredential(response) });
}

function storeSessionCredential(response) {
  const token = response.session_token;
  const ref = `itpay:session:${response.account_id}:${response.device_id}`;
  const nativeStore = writeNativeSecret(ref, token);
  if (nativeStore.ok) {
    return {
      session_token_store: nativeStore.store,
      session_token_ref: nativeStore.ref
    };
  }
  return {
    session_token: token,
    session_token_store: "file",
    session_token_warning: nativeStore.error
  };
}

function readSessionToken(credentials = readCredentials()) {
  if (credentials.session_token) {
    return credentials.session_token;
  }
  if (credentials.session_token_store && credentials.session_token_ref) {
    return readNativeSecret(credentials.session_token_store, credentials.session_token_ref);
  }
  return "";
}

function deleteSessionCredential(credentials) {
  if (!credentials) {
    return {};
  }
  if (credentials.session_token_store && credentials.session_token_ref) {
    deleteNativeSecret(credentials.session_token_store, credentials.session_token_ref);
  }
  delete credentials.session_token;
  delete credentials.session_token_store;
  delete credentials.session_token_ref;
  delete credentials.session_token_warning;
  return credentials;
}

function sanitizeAuthResponse(response) {
  const { session_token, ...safe } = response;
  return { ...safe, session_stored: Boolean(session_token) };
}

function storeGrantCredential(grantId, credential) {
  const credentials = readCredentials();
  const key = credential.key;
  const record = { ...credential };
  delete record.key;
  const nativeStore = writeNativeSecret(grantSecretRef(grantId), key);
  if (nativeStore.ok) {
    record.credential_store = nativeStore.store;
    record.credential_ref = nativeStore.ref;
  } else {
    record.key = key;
    record.credential_store = "file";
    record.credential_warning = nativeStore.error;
  }
  credentials[`grant_${grantId}`] = record;
  writeCredentials(credentials);
  return record;
}

function readGrantCredential(grantId) {
  const record = readCredentials()[`grant_${grantId}`];
  if (!record) return null;
  if (record.key) return record;
  const key = readNativeSecret(record.credential_store, record.credential_ref);
  return key ? { ...record, key } : record;
}

function deleteGrantCredential(grantId) {
  const credentials = readCredentials();
  const record = credentials[`grant_${grantId}`];
  if (record?.credential_store && record?.credential_ref) {
    deleteNativeSecret(record.credential_store, record.credential_ref);
  }
  delete credentials[`grant_${grantId}`];
  writeCredentials(credentials);
}

function grantSecretRef(grantId) {
  return `itpay:${grantId}`;
}

function detectNativeCredentialStore() {
  if (!shouldUseNativeCredentialStore()) return "file";
  if (process.platform === "darwin" && commandExists("security")) return "macos-keychain";
  if (process.platform === "linux" && commandExists("secret-tool")) return "secret-tool";
  return "unavailable";
}

function writeNativeSecret(ref, secret) {
  if (!secret) return { ok: false, error: "empty secret" };
  if (!shouldUseNativeCredentialStore()) {
    return { ok: false, error: "native credential store disabled for non-interactive agent host" };
  }
  if (process.platform === "darwin" && commandExists("security")) {
    try {
      execFileSync("security", [
        "add-generic-password",
        "-a",
        ref,
        "-s",
        "ItPay",
        "-w",
        secret,
        "-U"
      ], { stdio: "ignore" });
      return { ok: true, store: "macos-keychain", ref };
    } catch (error) {
      return { ok: false, error: `macOS Keychain unavailable: ${error.message}` };
    }
  }
  if (process.platform === "linux" && commandExists("secret-tool")) {
    try {
      execFileSync("secret-tool", [
        "store",
        "--label=ItPay",
        "service",
        "ItPay",
        "account",
        ref
      ], { input: secret, stdio: ["pipe", "ignore", "ignore"] });
      return { ok: true, store: "secret-tool", ref };
    } catch (error) {
      return { ok: false, error: `secret-tool unavailable: ${error.message}` };
    }
  }
  return { ok: false, error: "native credential store unavailable" };
}

function shouldUseNativeCredentialStore() {
  const store = String(process.env.ITP_CREDENTIAL_STORE || "").toLowerCase();
  if (store === "file") return false;
  if (store === "native" || store === "keychain" || store === "secret-tool") return true;
  const disabled = String(process.env.ITP_DISABLE_NATIVE_CREDENTIAL_STORE || "").toLowerCase();
  if (["1", "true", "yes"].includes(disabled)) return false;
  if (process.env.CODEX_CI || process.env.CODEX_SHELL || process.env.CODEX_THREAD_ID) return false;
  if (process.env.CI && !process.env.GITHUB_ACTIONS) return false;
  return true;
}

function readNativeSecret(store, ref) {
  if (!store || !ref) return "";
  try {
    if (store === "macos-keychain") {
      return execFileSync("security", [
        "find-generic-password",
        "-a",
        ref,
        "-s",
        "ItPay",
        "-w"
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    if (store === "secret-tool") {
      return execFileSync("secret-tool", [
        "lookup",
        "service",
        "ItPay",
        "account",
        ref
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
  } catch {
    return "";
  }
  return "";
}

function deleteNativeSecret(store, ref) {
  try {
    if (store === "macos-keychain") {
      execFileSync("security", [
        "delete-generic-password",
        "-a",
        ref,
        "-s",
        "ItPay"
      ], { stdio: "ignore" });
    }
    if (store === "secret-tool") {
      execFileSync("secret-tool", [
        "clear",
        "service",
        "ItPay",
        "account",
        ref
      ], { stdio: "ignore" });
    }
  } catch {
    // The local record is still removed; missing native secrets are harmless.
  }
}

function commandExists(command) {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function processIsRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    // Best effort; individual secret files are still written as 0600.
  }
}

function readText(file, fallback) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSONWithBackup(file, value, dryRun) {
  return writeTextWithBackup(file, `${JSON.stringify(value, null, 2)}\n`, 0o600, dryRun);
}

function writeTextWithBackup(file, content, mode, dryRun) {
  const backupPath = fs.existsSync(file) ? `${file}.itp-bak-${Date.now()}` : "";
  if (dryRun) {
    return { action: fs.existsSync(file) ? "would_update" : "would_create", backup_path: backupPath || null };
  }
  const dir = path.dirname(file);
  if (dir === CONFIG_DIR) {
    ensureConfigDir();
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (backupPath) {
    fs.copyFileSync(file, backupPath);
    fs.chmodSync(backupPath, mode);
  }
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return { action: backupPath ? "updated" : "created", backup_path: backupPath || null };
}

function fileMode(file) {
  try {
    return `0${(fs.statSync(file).mode & 0o777).toString(8)}`;
  } catch {
    return null;
  }
}

function replaceManagedBlock(source, name, block) {
  const start = `# >>> itp ${name}`;
  const end = `# <<< itp ${name}`;
  const managed = `${start}\n${block.trim()}\n${end}`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
  const trimmed = source.trimEnd();
  if (pattern.test(source)) return source.replace(pattern, managed);
  return `${trimmed}${trimmed ? "\n\n" : ""}${managed}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTomlString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function currentExecutable() {
  return process.argv[1] || "itp";
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function output(value) {
  console.log(JSON.stringify(value, null, 2));
}

function outputError(error) {
  const payload = { success: false, message: safeErrorMessage(error) };
  if (error?.next) payload.next = error.next;
  console.error(JSON.stringify(payload, null, 2));
}

function maskSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 4)}********${secret.slice(-4)}`;
}

function cryptoRandom() {
	return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cliCommand(...args) {
  const override = process.env.ITP_COMMAND;
  const base = override
    ? override
    : `${shellQuote(process.execPath)} ${shellQuote(CLI_FILE)}`;
  return [base, ...args.map((arg) => shellQuote(String(arg)))].join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeErrorMessage(error) {
  return String(error?.message || error || "unknown error")
    .replace(/itp_sess_[A-Za-z0-9_-]+/g, "itp_sess_****")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-****");
}

export { csvValues, booleanFlag, intFlag, splitCSV, queryString, appendURLQuery, positional, positionalArgs, stripInternalBuyerFields, apiTimeoutMs, parseFlags, normalizePurchaseFlags, apiBase, readConfig, packageVersion, writeConfig, readState, writeState, runPath, readRun, listRuns, writeRun, mergeRun, updateRun, updateCurrentRun, prepareSetupRun, withStateLock, readCredentials, writeCredentials, writeJSON0600, writeSessionCredentials, storeSessionCredential, readSessionToken, deleteSessionCredential, sanitizeAuthResponse, storeGrantCredential, readGrantCredential, deleteGrantCredential, grantSecretRef, detectNativeCredentialStore, writeNativeSecret, shouldUseNativeCredentialStore, readNativeSecret, deleteNativeSecret, commandExists, processIsRunning, ensureConfigDir, readText, readJSON, writeJSONWithBackup, writeTextWithBackup, fileMode, replaceManagedBlock, escapeRegExp, escapeTomlString, currentExecutable, quoteShell, output, outputError, maskSecret, cryptoRandom, sleep, cliCommand, shellQuote, safeErrorMessage };
