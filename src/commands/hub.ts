// Shared API command parsing, diagnostics and original-request error context.
import {readFileSync} from "node:fs";
import {HubTaskStore,type HubTask} from "../state/hub_tasks.js";
import {HttpError} from "../client/http.js";
import {importHubKey} from "../state/hub_credentials.js";
import {HubClient,HubApiError,hubErrorDetails,loadHubConfig} from "../client/hub.js";
import {writeCommandEnvelope} from "./hub_guidance.js";

function hub():HubClient{return new HubClient(loadHubConfig())}

export async function readRunInput(spec: string): Promise<unknown> {
  let raw: string;
  if (spec.startsWith("@")) {
    raw = readFileSync(spec.slice(1), "utf8");
  } else if (spec === "-") {
    raw = await new Promise<string>((resolve, reject) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { buf += c; });
      process.stdin.on("end", () => resolve(buf));
      process.stdin.on("error", reject);
    });
  } else {
    raw = spec;
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("invalid_input: --input must be a JSON object, @file, or - for stdin");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("invalid_input: --input must be a JSON object");
  }
  return input;
}

export class HubTaskRequestError extends Error {
 readonly requestID:string;
 readonly references:{request_id:string;run_id?:string;intent_id?:string};
 readonly code:string;
 readonly details: ReturnType<typeof hubErrorDetails>;
 constructor(error:unknown,task:HubTask) {
  super(error instanceof Error?error.message:"original Hub request did not return a receipt");
  this.requestID=task.request_id;
  this.details=hubErrorDetails(error);
  this.references={request_id:task.request_id,...(task.run_id?{run_id:task.run_id}:{}),...(task.intent_id?{intent_id:task.intent_id}:{})};
  this.code=error instanceof HttpError?error.code:["authorization_required","connection_verification_pending","credential_persistence_failed","idempotency_conflict","invalid_state"].find(code=>this.message.startsWith(code+":"))??"hub_request_unknown";
 }
}

export async function runHubWallet(options: { jsonOutput?: boolean | undefined }): Promise<void> {
 const bal=await hub().wallet() as Awaited<ReturnType<HubClient["wallet"]>>&{topup_url?:string};
 writeCommandEnvelope({status:"ready",result:{available_atoms:bal.available.amount_atoms,held_atoms:bal.held.amount_atoms,
  currency:bal.available.currency,scale:bal.available.scale,period_limit_atoms:null,topup_url:bal.topup_url??null},
  instruction:"余额不代表本连接的授权额度。需要主动充值时打开返回的官方入口。",
  next:null,recovery:[]},{jsonOutput:Boolean(options.jsonOutput)});
}

export async function runHubDoctor(options: { jsonOutput?: boolean | undefined }): Promise<void> {
  type Check = { name: string; ok: boolean; detail: string };
  const checks: Check[] = [];
  const emsg = (e: unknown) => {
    if (e instanceof HubApiError) return `${e.status} ${e.code}`;
    if (e instanceof HttpError) return `${e.status} ${e.code}`;
    return e instanceof Error ? e.message : String(e);
  };
  const client = hub();
  let authed = false;
  try {
    await client.me();
    authed = true;
    checks.push({ name: "credential", ok: true, detail: "hub identity authenticated" });
  } catch (e) {
    checks.push({ name: "credential", ok: false, detail: `${emsg(e)} — use the original installation connect command` });
  }
  try {
    const res = await client.discover({ limit: 1 });
    const n = res.items?.length ?? 0;
    checks.push({ name: "catalog", ok: n > 0, detail: n > 0 ? `shared shelf returned ${n}+ published ops` : "shelf has no available products" });
  } catch (e) {
    checks.push({ name: "catalog", ok: false, detail: `shelf read failed: ${emsg(e)}` });
  }
  try {
    const w = await client.wallet();
    checks.push({ name: "wallet", ok: true, detail: `available ${w.available.currency} ${w.available.amount_atoms}` });
  } catch (e) {
    checks.push({ name: "wallet", ok: false, detail: `wallet: ${emsg(e)}` });
  }
  const store = new HubTaskStore();
  const tasks = store.list();
  checks.push({ name: "task_store", ok: true, detail: `${tasks.length} persisted task(s)` });
  const ok = checks.every((c) => c.ok);
  writeCommandEnvelope({
    status: ok ? "ok" : "degraded",
    result: { authenticated: authed, checks },
    instruction: ok ? "本地栈可用。" : "修复上述失败项后重试 itpay api doctor。",
    next: null, recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`),
  });
  if (!ok) process.exitCode = 1;
}

export async function runHubCredentialsImport(options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const raw = await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => { clearTimeout(timeout); resolve(buf); });
    process.stdin.on("error", (error) => { clearTimeout(timeout); reject(error); });
    const timeout = setTimeout(() => reject(new Error("timeout: pipe the key on stdin — echo $KEY | itpay api credentials import")), 30_000);
  });
  const key = raw.trim();
  const cfg = loadHubConfig();
  const { key_prefix } = importHubKey(key, cfg.baseURL);
  writeCommandEnvelope({
    status: "imported",
    result: { key_prefix },
    instruction: `密钥已安全保存（前缀 ${key_prefix}…）。后续 itpay api 命令自动使用，不再需要环境变量。`,
    next: { command: "itpay api wallet", reason: "验证凭据有效" },
    recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: [`imported key ${key_prefix}…`],
  });
}
