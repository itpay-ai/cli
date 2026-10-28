// Hub API commands — Discover/Inspect/Run/Wallet/Top-ups against the Hub
// contract (contracts/openapi/hub.v1.yaml). These are pure contract
// orchestration; identity comes from ITPAY_HUB_TOKEN / ITPAY_HUB_KEY.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HubTaskStore, digestTask, type HubCredentialSelection } from "../state/hub_tasks.js";
import { hubOAuthConfig, runConnectFlow } from "../state/hub_oauth.js";
import { storeHubSession } from "../state/hub_credentials.js";
import {declaredAgentType, qualifyItPayCommand} from "../state/agent_type.js";
import {renderPaymentHandoff} from "../render/payment_handoff.js";
import { HttpError } from "../client/http.js";
import { importHubKey } from "../state/hub_credentials.js";
import { HubClient, HubApiError, loadHubConfig, type DiscoverItem, type EffectClass, type ServiceKind } from "../client/hub.js";
import { type AdmissionRequest, isRunReceipt } from "@itpay/hub-client";
import { writeCommandEnvelope } from "./hub_guidance.js";

function hub(): HubClient {
  return new HubClient(loadHubConfig());
}

function atomsToYuan(atoms: string): string {
  const v = BigInt(atoms);
  const yuan = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0");
  return `¥${yuan}.${frac}`;
}

export async function runHubDiscover(options: {
  query?: string | undefined; kinds?: string[] | undefined; effectClasses?: string[] | undefined; limit?: number | undefined; jsonOutput?: boolean | undefined;
}): Promise<void> {
  const client = hub();
  const result = await client.discover({
    query: options.query, kinds: options.kinds as ServiceKind[] | undefined, effect_classes: options.effectClasses as EffectClass[] | undefined,
    limit: options.limit,
  });
  const items = result.items ?? [];
  writeCommandEnvelope({
    status: items.length === 0 ? "catalog_empty" : "listed",
    result: { items: items.map(formatItem), next_cursor: result.next_cursor ?? null },
    instruction: items.length === 0
      ? "没有匹配的已发布操作；不要猜测 operation_id，改用更宽的查询。"
      : "先用 itpay api inspect <operation_id> 确认 effect_class、价格与 input_schema，再决定是否运行。",
    next: items[0]
      ? { command: `itpay api inspect ${items[0].operation_id}${options.jsonOutput ? " --json" : ""}`, reason: "运行前必须检查当前 publication" }
      : null,
    recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: items.map((it) => {
      const price = it.unit_price ? ("amount_atoms" in it.unit_price ? `${atomsToYuan(it.unit_price.amount_atoms)}/${it.unit_price.unit}` : "尚未配置") : "free";
      return `${it.operation_id}  ${it.display_name}  [${it.effect_class}] ${price}  (${it.status})`;
    }),
  });
}

function formatItem(it: DiscoverItem) {
  return {
    operation_id: it.operation_id, api_id: it.api_id, kind: it.kind,
    display_name: it.display_name, summary: it.summary,
    effect_class: it.effect_class, status: it.status,
    ...(it.unit_price ? { unit_price: it.unit_price } : {}),
  };
}

export async function runHubInspect(operationID: string, options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const desc = await hub().inspect(operationID);
  const price = desc.price_card;
  writeCommandEnvelope({
    status: "inspected",
    result: {
      ...desc,
      operation_id: desc.operation_id, api_id: desc.api_id, kind: desc.kind,
      display_name: desc.display_name, effect_class: desc.effect_class,
      status: desc.status, current_publication_id: desc.current_publication_id,
      price_card: price ?? null, input_schema: desc.input_schema ?? null,
    },
    instruction: desc.status !== "published"
      ? "该操作当前不可运行；不要发起 run。"
      : "使用 current_publication_id 绑定运行；带 effect_class=external_write/purchase 的操作需要用户确认。",
    next: desc.status === "published"
      ? { command: `itpay api run ${desc.operation_id} --publication ${desc.current_publication_id} --input '<JSON>'${options.jsonOutput ? " --json" : ""}`, reason: "发布绑定运行" }
      : null,
    recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: [
      `${desc.operation_id}  ${desc.display_name}  [${desc.effect_class}] ${desc.status}`,
      `publication: ${desc.current_publication_id}`,
      price ? (price.mode === "unconfigured" ? "price: 尚未配置" : `price: ${atomsToYuan(price.amount_atoms)}/${price.unit} (${price.mode})`) : "price: free",
    ],
  });
}

async function readRunInput(spec: string): Promise<unknown> {
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

// Accept stored credential references only. Provider header values never belong
// in a command, request task or source-selection file.
export function readHubCredentialSelection(credentialID?: string, sourceSpec?: string): HubCredentialSelection {
  if (credentialID !== undefined && sourceSpec !== undefined) throw new Error("invalid_input: --credential-id and --source-credentials are mutually exclusive");
  const validID = (v: unknown): v is string => typeof v === "string" && /^uck_[A-Za-z0-9_-]{1,124}$/.test(v);
  if (credentialID !== undefined) {
    if (!validID(credentialID)) throw new Error("invalid_input: --credential-id must be a stored uck_ credential reference");
    return { credential_id: credentialID };
  }
  if (sourceSpec === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(sourceSpec.startsWith("@") ? readFileSync(sourceSpec.slice(1), "utf8") : sourceSpec); }
  catch { throw new Error("invalid_input: --source-credentials must be a JSON reference mapping or @file"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length < 1 || Object.keys(parsed).length > 32) throw new Error("invalid_input: bounded source credential mapping required");
  const entries: [string, {credential_id: string; expected_version: string}][] = [];
  for (const [name, raw] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_input: invalid source selection");
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).length !== 2 || !validID(value.credential_id) || typeof value.expected_version !== "string" || !/^cred_[A-Za-z0-9_-]{1,123}$/.test(value.expected_version)) throw new Error("invalid_input: each source requires only credential_id and expected_version references");
    entries.push([name,{credential_id:value.credential_id,expected_version:value.expected_version}]);
  }
  return { source_credentials: Object.fromEntries(entries) };
}

// Poll a run until terminal or the wait budget expires — bounded backoff,
// never a new request (AT10).
async function waitForRun(client: HubClient, runID: string, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  let delay = 500;
  for (;;) {
    const rec = await client.runStatus(runID);
    if (["succeeded", "failed", "cancelled"].includes(rec.execution_state)) return rec;
    if (Date.now() >= deadline) return rec;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
}

export async function runHubRun(operationID: string, options: {
  publication: string; input: string; maxCharge?: string | undefined;
  requestId?: string | undefined; waitSeconds?: number | undefined;
  jsonOutput?: boolean | undefined; credentialId?: string | undefined; sourceCredentials?: string | undefined;
}): Promise<void> {
  const selections = readHubCredentialSelection(options.credentialId, options.sourceCredentials);
  const client = hub();
  const store = new HubTaskStore();
  const input = await readRunInput(options.input);

  // A03: the logical request is persisted BEFORE any POST. A retry,
  // a crash or a reopened shell replays the same request_id — never a
  // fresh UUID that would mint a second charge (F02).
  const digest = digestTask(operationID, options.publication, input, options.maxCharge, selections);
  const { task, created } = store.getOrCreate({
    ...(options.requestId ? { request_id: options.requestId } : {}),
    operation_id: operationID, publication_id: options.publication,
    input, ...selections, ...(options.maxCharge ? { max_charge_atoms: options.maxCharge } : {}),
  });
  if (!created && task.input_digest !== digest) {
    throw new Error(`idempotency_conflict: request ${task.request_id} already exists with different input/publication/credential selection — use a new --request-id or "itpay api resume ${task.request_id}"`);
  }
  if (!created && task.run_id) {
    // Already dispatched: report the original run — never re-charge.
    const rec = await waitForRun(client, task.run_id, options.waitSeconds ?? 0);
    store.update(task.request_id, { status: rec.execution_state === "succeeded" ? "succeeded" : rec.execution_state === "failed" ? "failed" : "dispatched" });
    renderRun(rec, options.jsonOutput, "replayed");
    return;
  }
  if (!created && task.intent_id) {
    await renderBlockedTask(task, null, options.jsonOutput);
    return;
  }

  const body: AdmissionRequest = {
    expected_publication_id: task.publication_id, input: task.input as Record<string, unknown>,
    ...(task.credential_id ? { credential_id: task.credential_id } : {}),
    ...(task.source_credentials ? { source_credentials: task.source_credentials } : {}),
  };
  if (options.maxCharge) {
    body.max_charge = { currency: "CNY", scale: 6, amount_atoms: options.maxCharge };
  }
  store.update(task.request_id, { status: "dispatched" });
  const admission = await client.run(operationID, body, store.idempotencyKey(task.request_id));
  if (!isRunReceipt(admission)) {
    store.update(task.request_id, { status: "blocked", intent_id: admission.intent_id, blocking_reason: admission.blocking_reason });
    await renderBlockedTask(task, admission, options.jsonOutput);
    return;
  }
  let rec = admission;
  store.update(task.request_id, { run_id: rec.run_id });
  if (options.waitSeconds) {
    rec = await waitForRun(client, rec.run_id, options.waitSeconds) as typeof rec;
  }
  store.update(task.request_id, {
    status: rec.execution_state === "succeeded" ? "succeeded" : rec.execution_state === "failed" ? "failed" : "dispatched",
  });
  renderRun(rec, options.jsonOutput);
}

function renderRun(rec: any, jsonOutput: boolean | undefined, note?: string) {
  const charged = rec.actual_charge ? atomsToYuan(rec.actual_charge.amount_atoms) : "¥0.000000";
  writeCommandEnvelope({
    status: rec.execution_state === "succeeded" ? "executed" : rec.execution_state,
    result: { run_id: rec.run_id, execution_state: rec.execution_state, settlement_state: rec.settlement_state, actual_charge: rec.actual_charge ?? null, result: rec.result ?? null, error: rec.error ?? null, ...(note ? { note } : {}) },
    instruction: rec.execution_state === "succeeded"
      ? `运行完成，已按价格卡结算 ${charged}。`
      : `运行未完成（${rec.error?.code ?? rec.execution_state}）；用 itpay api run-status ${rec.run_id} 查询原任务，不重复发起。`,
    next: ["succeeded", "failed"].includes(rec.execution_state) ? null
      : { command: `itpay api run-status ${rec.run_id}`, reason: "查询原 run 状态，不新建请求" },
    recovery: [],
  }, {
    jsonOutput: Boolean(jsonOutput),
    plainResult: [`run ${rec.run_id}  ${rec.execution_state}  ${rec.settlement_state}  ${charged}${note ? "  (" + note + ")" : ""}`],
  });
}

// renderBlockedTask surfaces the official structured action. For a
// prepaid_only key caller the server attaches a web_action URL — the human
// opens it (or scans the QR) to top up in their own session; crediting then
// resumes the SAME intent server-side. The CLI never invents a payment URL.
export async function renderBlockedTask(task: { request_id: string; intent_id?: string }, admission: any, jsonOutput: boolean | undefined) {
  if(!admission&&task.intent_id){try{const payment=await hub().getAPIPaymentRequest(task.intent_id);admission={intent_id:task.intent_id,blocking_reason:'insufficient_balance',payment_request:payment,required_action:payment.collection_action};}catch{/* Query only; never create a replacement payment on a missing result. */}}
  const intentID=admission?.intent_id??task.intent_id;
  const action=admission?.required_action;
  const reason=admission?.blocking_reason??'blocked';
  const payment=admission?.payment_request;
  const paymentRequired=payment&&/^[1-9][0-9]*$/.test(String(payment.payer_minor_amount??''));
  if(action&&!paymentRequired){
    let target:string|undefined;
    try{const url=new URL(action.target);if(url.protocol==='https:'&&!url.username&&!url.password)target=url.href;}catch{/* No invented replacement URL. */}
    const approval=['authorization_denied','budget_exceeded'].includes(reason);
    const instruction=approval?'请在官方页面核对该 Agent、API 效果范围和消费预算，明确批准后恢复同一原请求。消费授权不会充值或自动扣款。':reason==='insufficient_balance'?'余额不足；请在官方充值页核对原请求和实际金额，到账后恢复同一原请求。':'请在官方页面完成所需操作，再查询同一原请求。';
    writeCommandEnvelope({status:reason,result:{request_id:task.request_id,intent_id:intentID,...(admission??{})},...(target?{handoff:{type:'open_url',url:target,label:action.label??'打开官方页面'}}:{}),instruction:target?instruction:'未取得可用官方操作链接；保留原请求并核对当前状态。',next:target?{command:qualifyItPayCommand(`itpay api resume ${task.request_id}${jsonOutput?' --json':''}`,declaredAgentType()),reason:approval?'完成消费授权后恢复同一原请求':'完成官方操作后查询同一原请求'}:null,recovery:[]},{jsonOutput:Boolean(jsonOutput),plainResult:[`request ${task.request_id} blocked intent ${intentID??'-'}`,...(target?[target]:[])]});
    return;
  }
  const handoff=action&&paymentRequired?await renderPaymentHandoff({action,requestID:task.request_id,amountMinor:Number(admission?.payment_request?.payer_minor_amount??0),currency:admission?.payment_request?.payer_currency??'CNY',jsonOutput:Boolean(jsonOutput)}):null;
  writeCommandEnvelope({status:admission?.blocking_reason??'blocked',result:{request_id:task.request_id,intent_id:intentID,...(admission??{}),...(handoff?{qr_kind:action.branded===true?'branded_payment_card':'official_checkout_link'}:{})},...(handoff?{handoff:handoff.handoff}:{}),instruction:handoff?.instruction??'当前没有可用的官方品牌付款卡片或收银台链接。保留原请求，查询状态；不要生成或展示 raw QR。',next:handoff?.next??{command:`itpay api resume ${task.request_id}`,reason:'恢复同一原请求'},recovery:[]},{jsonOutput:Boolean(jsonOutput),plainResult:[`request ${task.request_id} blocked intent ${intentID??'-'}`,...(handoff?[JSON.stringify(handoff.handoff)]:[])]});
}

export async function runHubWallet(options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const client = hub();
  const bal = await client.wallet();
  writeCommandEnvelope({
    status: "ok",
    result: { available: bal.available, held: bal.held },
    instruction: `可用 ${atomsToYuan(bal.available.amount_atoms)}，在途 ${atomsToYuan(bal.held.amount_atoms)}。`,
    next: null, recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: [`available ${atomsToYuan(bal.available.amount_atoms)}  held ${atomsToYuan(bal.held.amount_atoms)}`],
  });
}

export async function runHubUsage(options: { jsonOutput?: boolean | undefined }): Promise<void> {
 const usage = await hub().usage();
 writeCommandEnvelope({status:"ok",result:usage,instruction:"当前 Consumer 的用量与费用回执；读取不会再次执行或扣费。",next:null,recovery:[]}, {
  jsonOutput:Boolean(options.jsonOutput),plainResult:[`gross ${atomsToYuan(usage.gross_atoms)}  refunded ${atomsToYuan(usage.refunded_atoms)}  net ${atomsToYuan(usage.net_atoms)}  held ${atomsToYuan(usage.held_atoms)}`],
 });
}

export async function runHubTransactions(options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const { items } = await hub().walletTransactions();
  writeCommandEnvelope({
    status: "listed",
    result: { items },
    instruction: "钱包流水只读；任何 dispute 走退款入口，不篡改本地记录。",
    next: null, recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: items.map((t) => `${String(t.transaction_id)}  ${String(t.kind)}  ${String(t.direction)}  ${atomsToYuan((t.amount as {amount_atoms:string}).amount_atoms)}`),
  });
}

export async function runHubTopupSkus(options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const { items } = await hub().topupSkus();
  writeCommandEnvelope({
    status: "listed",
    result: { items },
    instruction: "固定面额；仅供用户选择。列出面额不代表用户已经批准充值。",
    next: null,
    recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: items.map((s) => {
      const credit = s.credit as {amount_atoms:string};
      return `${String(s.sku_id)}  ${String(s.display)}  ${atomsToYuan(credit.amount_atoms)}`;
    }),
  });
}

export async function runHubTopupCreate(skuID: string, options: { payerCurrency?: string | undefined; forIntent?: string | undefined;channel?:string|undefined;mode?:string|undefined; jsonOutput?: boolean | undefined }): Promise<void> {
  const client = hub();
  const store = new HubTaskStore();
  // --for-intent binds this top-up to the ORIGINAL blocked task — the
  // deterministic key means a retried topup command can never double-pay.
  const linkedTask = options.forIntent
    ? store.list().find((t) => t.intent_id === options.forIntent)
    : undefined;
  // Per-attempt sequence: a CLI retry of an IN-FLIGHT order reuses the
  // same key (server replays the original order — never a second charge).
  // Only when the previous order reached a terminal state does a new
  // topup command for the same intent mint a new attempt.
  let seq = linkedTask?.topup_seq ?? 1;
  if (linkedTask?.topup_id) {
    try {
      const prev = await client.topupStatus(linkedTask.topup_id);
      const st = String(prev.status);
      if (["credited", "expired", "failed", "refunded", "cancelled"].includes(st)) {
        seq = (linkedTask.topup_seq ?? 1) + 1;
      }
    } catch {
      // status unreachable — reuse the last seq; the server dedupes on key
    }
  }
  const idemKey = linkedTask ? `cli-topup-${linkedTask.request_id}-${seq}` : `cli-topup-${randomUUID()}`;
  let order: Awaited<ReturnType<HubClient["createTopup"]>>;
 try{order=await client.createTopup({
    sku_id: skuID, payer_currency: options.payerCurrency ?? "CNY",
 ...(options.channel?{channel:options.channel}:{}),...(options.mode?{mode:options.mode}:{}),
    ...(options.forIntent ? { continuation_id: options.forIntent } : {}),
},idemKey)}catch(error){
 if(error instanceof HttpError&&error.code==="channel_unavailable"&&!options.channel){
 const target=new URL("/me/wallet",loadHubConfig().baseURL);if(options.forIntent)target.searchParams.set("continuation_id",options.forIntent);
 const required_action={kind:"open_url",target:target.toString(),presentation:"approved_web_fallback",user_action_required:true};
 writeCommandEnvelope({status:"action_required",result:{required_action,continuation_id:options.forIntent??null},instruction:"请在官方钱包页面明确选择公司收款渠道。尚未创建付款订单，也不会自动选择或付款。",next:null,recovery:[]},{jsonOutput:Boolean(options.jsonOutput),plainResult:[`请选择付款方式：${target.toString()}`]});return;
 }throw error;
 }
 if (linkedTask) {
    store.update(linkedTask.request_id, { topup_id: String(order.topup_id), topup_seq: seq });
  }
  const action = order.collection_action;
  const handoff=action?await renderPaymentHandoff({action,requestID:String(order.topup_id),amountMinor:Number(order.payer_minor_amount),currency:order.payer_currency,jsonOutput:Boolean(options.jsonOutput),resumeCommand:`itpay api topup-status ${order.topup_id}`}):null;
  writeCommandEnvelope({
    status: String(order.status ?? "created"),
    result: order,
    ...(handoff?{handoff:handoff.handoff}:{}),
    instruction: handoff?.instruction??(action?.user_action_required
      ? `请在批准的 Web 回退页面完成支付：${action.target ?? "(collection action)"}`
      : "订单已创建；按状态跟进。"),
    next: { command: `itpay api topup-status ${String(order.topup_id)}${options.jsonOutput ? " --json" : ""}`, reason: "查看充值状态" },
    recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: [`topup ${String(order.topup_id)}  ${String(order.status)}`],
  });
}

export async function runHubTopupStatus(topupID: string, options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const order = await hub().topupStatus(topupID);
  writeCommandEnvelope({
    status: String(order.status ?? "unknown"),
    result: order,
    instruction: `充值单状态 ${String(order.status)}；credited 后钱包余额更新。`,
    next: null, recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: [`topup ${String(order.topup_id)}  ${String(order.status)}`],
  });
}

// runHubDoctor — A00: verify the local agent↔hub loop end to end.
// Checks hub reachability, credential presence + authentication, catalog
// non-empty, and the task store health. Read-only; makes no paid calls.
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
    checks.push({ name: "credential", ok: false, detail: `${emsg(e)} — run 'itpay api credentials import'` });
  }
  try {
    const res = await client.discover({ limit: 1 });
    const n = res.items?.length ?? 0;
    checks.push({ name: "catalog", ok: n > 0, detail: n > 0 ? `discover returned ${n}+ published ops` : "catalog empty — run qa_seed.sh" });
  } catch (e) {
    checks.push({ name: "catalog", ok: false, detail: `discover failed: ${emsg(e)}` });
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

export async function runHubContinue(intentID: string, options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const res = await hub().continueIntent(intentID, `cli-${randomUUID()}`);
  writeCommandEnvelope({
    status: res.state ?? res.status ?? "open",
    result: res,
    instruction: res.run && res.run.execution_state === "succeeded"
      ? `运行完成，已按价格卡结算 ${res.run.actual_charge ? atomsToYuan(res.run.actual_charge.amount_atoms) : "¥0.000000"}。`
      : "续跑未成功或仍在途中；同一 intent_id 可安全重试。",
    next: null, recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: [`intent ${intentID}  ${res.state}`],
  });
}

export async function runHubResume(requestID: string, options: { waitSeconds?: number | undefined; jsonOutput?: boolean | undefined }): Promise<void> {
  const client = hub();
  const store = new HubTaskStore();
  const task = store.get(requestID);
  if (!task) {
    throw new Error(`not_found: unknown task ${requestID} — check "itpay api tasks"`);
  }
  if (task.run_id) {
    const rec = await waitForRun(client, task.run_id, options.waitSeconds ?? 0);
    store.update(requestID, { status: rec.execution_state === "succeeded" ? "succeeded" : rec.execution_state === "failed" ? "failed" : "dispatched" });
    renderRun(rec, options.jsonOutput);
    return;
  }
  if (task.intent_id) {
    const res = await client.continueIntent(task.intent_id, `cli-continue-${requestID}`);
    if (res.run) {
      store.update(requestID, { run_id: res.run.run_id, status: res.run.execution_state === "succeeded" ? "succeeded" : "dispatched" });
      renderRun(res.run, options.jsonOutput);
    } else {
      const state = res.blocking_reason ?? res.state ?? res.status ?? "blocked";
      store.update(requestID, { blocking_reason: state });
      await renderBlockedTask(task,{...res,intent_id:task.intent_id,blocking_reason:state},options.jsonOutput);
    }
    return;
  }
  throw new Error(`invalid_state: task ${requestID} has no run or intent — it never reached the server`);
}

export async function runHubTasks(options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const tasks = new HubTaskStore().list();
  writeCommandEnvelope({
    status: "listed",
    result: { items: tasks },
    instruction: "本地任务账本；itpay api resume <request_id> 恢复，itpay api run-status <run_id> 查询。",
    next: null, recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: tasks.map((t) => `${t.request_id}  ${t.operation_id}  ${t.status}  ${t.run_id ?? t.intent_id ?? "-"}`),
  });
}

export async function runHubRunStatus(runID: string, options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const rec = await hub().runStatus(runID);
  renderRun(rec, options.jsonOutput);
}

// credentials import — secret via stdin only; never argv/stdout/logs.
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

// `itpay api connect` — one browser OAuth/PKCE authorization binds this CLI
// profile to a Hub session (A03/F-R11). The user approves once; afterwards
// the bearer token (stored 0600) carries owner-level rights including
// top-up — while imported keys stay the prepaid-only developer path.
export async function runHubConnect(options: { jsonOutput?: boolean | undefined }): Promise<void> {
  const cfg = hubOAuthConfig();
  const { authorizeURL, done } = await runConnectFlow(cfg);
  // The handoff is diagnostic output; --json stdout remains one terminal document.
  if (options.jsonOutput) process.stderr.write(`Open to authorize ItPay: ${authorizeURL}\n`);
  else writeCommandEnvelope({
    status: "authorization_required",
    result: {
      authorize_url: authorizeURL,
      client_id: cfg.clientID,
      resource: cfg.resource,
    },
    instruction: "在浏览器完成一次授权；CLI 等待回调后自动绑定。",
    next: null,
    recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: ["打开浏览器完成授权：", `  ${authorizeURL}`],
  });
  const tokens = await done;
  const meResponse = await fetch(`${cfg.resource}/v1/me`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!meResponse.ok) throw new Error("authorization_required: could not verify connected identity");
  const me = await meResponse.json() as { buyer_id?: string; consumer_id?: string };
  if (!me.buyer_id || (!me.consumer_id || (me.consumer_id !== `oauth:${cfg.clientID}` && !me.consumer_id.startsWith(`oauth:${cfg.clientID}:`)))) throw new Error("authorization_required: OAuth consumer mismatch");
  const subject = me.buyer_id;
  storeHubSession(tokens.accessToken, tokens.refreshToken, tokens.expiresIn, subject, cfg.resource, process.env, me.consumer_id);
  writeCommandEnvelope({
    status: "connected",
    result: {
      hub: cfg.resource,
      subject: subject ?? null,
      expires_in: tokens.expiresIn,
      refresh_token: Boolean(tokens.refreshToken),
    },
    instruction: "已连接。可以 itpay api discover / run；充值请在网页或 topup 命令中明确进行。",
    next: { command: "itpay api doctor --json", reason: "验证连接与目录可用" },
    recovery: [],
  }, {
    jsonOutput: Boolean(options.jsonOutput),
    plainResult: [`已连接 ${cfg.resource}${subject ? ` (${subject})` : ""}`],
  });
}
