// Durable Hub task store (A03/F-R01): every logical run request gets a
// stable request_id persisted BEFORE any POST leaves the process.
//
// Concurrency model: ONE FILE PER TASK — concurrent creates of different
// tasks cannot collide, and a per-task lock makes updates atomic. Tasks are
// namespaced by (hub origin, credential prefix) so two consumers on the
// same HOME never read or resume each other's work. Legacy single-file
// stores are migrated on first open; records without scope bind explicitly
// to the credential in use, never guessed.
//
// Secrets are never stored here — only ids and request facts.
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { withFileLock } from "./file_lock.js";
import { storedHubKeyPrefix, storedHubProfile } from "./hub_credentials.js";

export type HubCredentialSelection = { credential_id?: string; source_credentials?: Record<string, { credential_id: string; expected_version: string }> };

export interface HubTask extends HubCredentialSelection {
  request_id: string;
  operation_id: string;
  publication_id: string;
  input: unknown;
  input_digest: string;
  max_charge_atoms?: string;
  run_id?: string;
  intent_id?: string;
  topup_id?: string;
  topup_seq?: number;
  // Ownership facts (F-R02): scope under which this task was created. A
  // resume must run under the same origin + credential; these are enforced
  // server-side too — the local copy exists so the CLI never silently
  // re-dispatches a task it cannot own.
  hub_origin?: string;
  key_prefix?: string | undefined;
  account_id?: string;
  status: "pending" | "blocked" | "dispatched" | "succeeded" | "failed" | "unknown";
  blocking_reason?: string;
  created_at: string;
  updated_at: string;
}

interface HubTaskFile {
  schema_version: "itpay.hub_tasks.v1";
  tasks: Record<string, HubTask>;
}

// Terminal states never roll back to an earlier stage on a racing update.
const STATUS_RANK: Record<HubTask["status"], number> = {
  pending: 0, blocked: 1, dispatched: 2, unknown: 2, failed: 3, succeeded: 3,
};

function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ITPAY_STATE_DIR ? resolve(env.ITPAY_STATE_DIR) : resolve(env.HOME || homedir(), ".itpay-v3");
}

function normalizedOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.ITPAY_HUB_URL ?? "http://localhost:18090";
  try {
    const u = new URL(raw);
    u.search = ""; u.hash = ""; u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

// Scope = normalized hub origin + the credential actually in play. Two
// different keys (consumers) pointed at the same hub get separate task
// namespaces; an env-var key override and an imported profile are distinct
// consumers even for the same account.
export function hubTasksScope(env: NodeJS.ProcessEnv = process.env): string {
  const origin = normalizedOrigin(env);
  const key = env.ITPAY_HUB_KEY ?? "";
  const profile = storedHubProfile(env);
  let consumer: string;
  if (env.ITPAY_HUB_TOKEN) throw new Error("authorization_required: connect a verified OAuth profile before using local tasks");
  if (key) consumer = `key:${key}`;
  else if (profile?.access_token) {
    if (!profile.subject || !profile.consumer_id) throw new Error("authorization_required: reconnect to verify task owner");
    consumer = JSON.stringify(["oauth", profile.subject, profile.consumer_id]);
  } else if (profile?.api_key) consumer = `key:${profile.api_key}`;
  else throw new Error("authorization_required: connect ItPay before using local tasks");
  const hash = createHash("sha256").update(JSON.stringify([origin,consumer])).digest("hex");
  return `scope-${hash}`;
}

export function hubTasksDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "hub-tasks", hubTasksScope(env));
}

/** @deprecated file path retained for callers that only print it. */
export function hubTasksPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hubTasksDir(env), "tasks");
}

export function canonicalInput(input: unknown): string {
  return JSON.stringify(sortDeep(input));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]));
  }
  return v;
}

export function digestTask(operationID: string, publicationID: string, input: unknown, maxCharge?: string, selections?: HubCredentialSelection): string {
  const h = createHash("sha256");
  h.update(operationID); h.update("\0");
  h.update(publicationID); h.update("\0");
  h.update(canonicalInput(input)); h.update("\0");
  if (maxCharge) h.update(maxCharge);
  if (selections?.credential_id || selections?.source_credentials) {
    h.update("\0credentials/v1\0"); h.update(canonicalInput(selections));
  }
  return h.digest("hex");
}

function taskFileName(requestID: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestID)) throw new Error("invalid request_id");
  return `${requestID}.json`;
}

export class HubTaskStore {
  private readonly scopeFields: { hub_origin: string; key_prefix?: string | undefined };

  /**
   * @param dir scope directory — default is the current
   *   (origin × credential) namespace. Tests may pass an explicit dir.
   */
  constructor(private readonly dir: string = hubTasksDir()) {
    const key = process.env.ITPAY_HUB_KEY;
    this.scopeFields = {
      hub_origin: normalizedOrigin(process.env),
      ...(key ? { key_prefix: key.slice(0, 14) } : storedHubKeyPrefix() ? { key_prefix: storedHubKeyPrefix() } : {}),
    };
    this.migrateLegacy();
  }

  /** The Hub Idempotency-Key for a request_id — stable across processes. */
  idempotencyKey(requestID: string): string {
    return `cli-req-${requestID}`;
  }

  get(requestID: string): HubTask | undefined {
    const file = join(this.dir, taskFileName(requestID));
    if (!existsSync(file)) return undefined;
    return this.readTask(file);
  }

  getOrCreate(seed: Omit<HubTask, "request_id" | "status" | "created_at" | "updated_at" | "input_digest" | "hub_origin" | "key_prefix"> & { request_id?: string }): { task: HubTask; created: boolean } {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const requestID = seed.request_id ?? `req_${randomUUID().replaceAll("-", "")}`;
    const file = join(this.dir, taskFileName(requestID));
    const createTask = (): { task: HubTask; created: boolean } => {
      const now = new Date().toISOString();
      const task: HubTask = {
        request_id: requestID,
        operation_id: seed.operation_id, publication_id: seed.publication_id, input: seed.input,
        input_digest: digestTask(seed.operation_id, seed.publication_id, seed.input, seed.max_charge_atoms, { ...(seed.credential_id ? { credential_id: seed.credential_id } : {}), ...(seed.source_credentials ? { source_credentials: seed.source_credentials } : {}) }),
        ...(seed.max_charge_atoms ? { max_charge_atoms: seed.max_charge_atoms } : {}),
        ...(seed.credential_id ? { credential_id: seed.credential_id } : {}),
        ...(seed.source_credentials ? { source_credentials: seed.source_credentials } : {}),
        ...this.scopeFields,
        status: "pending", created_at: now, updated_at: now,
      };
      this.writeTask(file, task);
      return { task, created: true };
    };
    if (seed.request_id) {
      // Publish complete JSON under the per-task lock. A racing creator
      // reads the committed record; it never observes a partially written file.
      return withFileLock(`${file}.lock`, () => {
        if (existsSync(file)) return { task: this.readTask(file), created: false };
        return createTask();
      });
    }
    // Generated id — a fresh request_id is a fresh task; plain write.
    return createTask();
  }

  update(requestID: string, patch: Partial<HubTask>): HubTask | undefined {
    const file = join(this.dir, taskFileName(requestID));
    if (!existsSync(file)) return undefined;
    // Per-task lock: two processes updating the same task serialize here;
    // terminal states (succeeded/failed) cannot regress.
    return withFileLock(`${file}.lock`, () => {
      const existing = this.readTask(file);
      if (STATUS_RANK[existing.status] >= STATUS_RANK.succeeded) return existing;
      const next = { ...existing, ...patch, request_id: requestID, updated_at: new Date().toISOString() };
      this.writeTask(file, next);
      return next;
    });
  }

  list(): HubTask[] {
    if (!existsSync(this.dir)) return [];
    const out: HubTask[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try { out.push(this.readTask(join(this.dir, name))); } catch { /* skip corrupt entries */ }
    }
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** Bind a migrated/legacy task to the current scope on explicit access. */
  private bindScope(task: HubTask, file: string): HubTask {
    if (task.hub_origin && task.key_prefix !== undefined) return task;
    const bound = { ...task, ...this.scopeFields, updated_at: new Date().toISOString() };
    this.writeTask(file, bound);
    return bound;
  }

  private readTask(file: string): HubTask {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as HubTask;
    if (typeof parsed.request_id !== "string") throw new Error("hub task store is invalid");
    return this.bindScope(parsed, file);
  }

  private writeTask(file: string, task: HubTask): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(task, null, 2), { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  }

  // Legacy v1 store was one hub-tasks.json under the state dir — split it
  // into per-task files inside the current scope, once, under a store lock.
  private migrateLegacy(): void {
    const legacyPath = join(stateDir(), "hub-tasks.json");
    if (!existsSync(legacyPath)) return;
    withFileLock(`${legacyPath}.migrate.lock`, () => {
      if (!existsSync(legacyPath)) return;
      const parsed = JSON.parse(readFileSync(legacyPath, "utf8")) as HubTaskFile;
      if (parsed.schema_version !== "itpay.hub_tasks.v1" || typeof parsed.tasks !== "object") return;
      // The old store has no trustworthy Buyer/Consumer binding. Preserve it
      // for explicit recovery without showing its private input to a new user.
      renameSync(legacyPath, `${legacyPath}.${randomUUID()}.quarantined`);
    });
  }
}
