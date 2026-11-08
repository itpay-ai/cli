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

export function describeHubIdentity(me: Awaited<ReturnType<HubClient["me"]>>, kind: string) {
 const extra=me as typeof me & {key_id?:string;account_hint?:string};
 return {credential_kind:kind,account_hint:extra.account_hint??(me.buyer_id ? "…"+me.buyer_id.slice(-6) : null),
  ...(kind==="api_key"?{key_id:extra.key_id??null}:{consumer_id:me.consumer_id??null})};
}
export async function runHubWallet(options: { jsonOutput?: boolean; usage?: boolean; transactions?: boolean }): Promise<void> {
 if(options.usage&&options.transactions)throw new Error("invalid_input: choose --usage or --transactions");
 const cfg=loadHubConfig(),client=new HubClient(cfg);
 const me=await client.me(),identity=describeHubIdentity(me,cfg.apiKey?"api_key":me.consumer_id?"oauth":"owner");
 const scope=cfg.apiKey?"api_key":me.consumer_id?"consumer":"owner";
 const bal=await client.wallet() as Awaited<ReturnType<HubClient["wallet"]>>&{topup_url?:string;owner_billing_url?:string};
 let result:Record<string,unknown>;
 if(options.usage)result={...await client.usage(),scope,identity};
 else if(options.transactions){
  const data=await client.walletTransactions() as Awaited<ReturnType<HubClient["walletTransactions"]>>&{has_more?:boolean;limit?:number;next_page?:number};
  // Older servers include account funding credits. They are not this credential's usage.
  result={...data,items:scope==="owner"?data.items:data.items.filter(x=>["charge","charge_refund"].includes(x.kind)),scope,identity,
   truncated:data.has_more??(scope!=="owner"&&data.items.length>=100),limit:data.limit??(scope==="owner"?50:100)};
 }else result={available_atoms:bal.available.amount_atoms,held_atoms:bal.held.amount_atoms,currency:bal.available.currency,scale:bal.available.scale,period_limit_atoms:null,topup_url:bal.topup_url??null,scope:"account_balance",identity};
 result.owner_billing_url=bal.owner_billing_url??bal.topup_url??null;
 writeCommandEnvelope({status:"ready",result,instruction:options.usage||options.transactions?"仅当前凭据范围；runs 包含失败，不是成功交付数。机器流水只含本凭据消费/消费退款，截断不能当全量。全账号充值、冻结及原款退款请本人打开账单入口。":"余额属于账号，不代表本连接消费额度。主动充值打开官方入口，由本人选档并付款；链接不是充值订单。",next:null,recovery:[]},{jsonOutput:Boolean(options.jsonOutput)});
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
    const timeout = setTimeout(() => reject(new Error("timeout: provide the selected API Key through private stdin to api credentials import")), 30_000);
  });
  const key = raw.trim();
  const cfg = loadHubConfig();
  const { key_prefix } = importHubKey(key, cfg.baseURL);
  writeCommandEnvelope({
    status: "imported",
    result: { key_prefix:key_prefix.slice(0,8)+"…",credential_kind:"api_key" },
    instruction: `密钥已安全保存（前缀 ${key_prefix.slice(0,8)}…）。后续 itpay api 命令自动使用，不再需要环境变量。`,
    next: { command: "itpay api wallet", reason: "验证凭据有效" },
    recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: [`imported key ${key_prefix}…`],
  });
}
