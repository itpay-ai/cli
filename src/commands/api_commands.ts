import { selectHubInstallation } from "../state/hub_installation.js";
import {storedHubProfile} from "../state/hub_credentials.js";
import {runAdminCommand} from "./admin.js";
import {HubTaskRequestError,runHubConnect,runHubOriginalReceipt,runHubRecoverConnection,runHubContinue,runHubCredentialsImport,runHubDoctor,runHubDiscover,runHubInspect,runHubResume,runHubRun,runHubRunStatus,runHubTasks,runHubTopupCreate,runHubTopupSkus,runHubTopupStatus,runHubTransactions,runHubUsage,runHubWallet} from "./hub.js";
import { Command } from "commander";
import { HttpError } from "../client/http.js";
import {hubErrorDetails} from "../client/hub.js";
import {declaredAgentType,qualifyItPayCommand} from "../state/agent_type.js";
import { hubFailureInstruction, writeCommandEnvelope } from "./hub_guidance.js";

function reportCLIError(error: unknown, contract?: {jsonOutput?: boolean; code: string; instruction: string; recovery: Array<{command: string; reason: string}>}): void {
 const code=error instanceof HubTaskRequestError?error.code:error instanceof HttpError?error.code:error instanceof Error&&["connection_recovery_conflict","connection_recovery_denied","authorization_required","connection_not_saved","connection_verification_pending","credential_persistence_failed"].some(code=>error.message.startsWith(code+":"))?error.message.split(":",1)[0]!:contract?.code??"command_failed";
 let original=false;try{original=Boolean(storedHubProfile()?.consumer_id)}catch{original=true}
 const auth=code==="authorization_required"||code==="unauthenticated";
 const taskID=error instanceof HubTaskRequestError?error.requestID:undefined;
 const references=error instanceof HubTaskRequestError?error.references:undefined;
 const recover=taskID?{command:qualifyItPayCommand(references?.run_id?`itpay api run-status ${references.run_id}${contract?.jsonOutput?" --json":""}`:`itpay api tasks --refresh --request-id ${taskID}${contract?.jsonOutput?" --json":""}`,declaredAgentType()),reason:"只读核对同一原任务，不创建或续跑请求",read_only:{method:"GET" as const,path:references?.run_id?`/v1/runs/${encodeURIComponent(references.run_id)}`:`/v1/requests/${encodeURIComponent('cli-req-'+taskID)}`}}:null;
 writeCommandEnvelope({status:"error",error:{code,message:error instanceof Error?error.message:String(error),...(hubErrorDetails(error)?{details:hubErrorDetails(error)}:{})},...(references?{result:references}:{}),instruction:code==="connection_recovery_conflict"?"已有其他active连接；保留原连接、任务与私有候选，交owner裁决，不替换或撤销其他连接。":code==="connection_recovery_denied"?"原连接恢复未通过；保留原profile、任务及私有恢复材料，不新建connect、不重发业务。":code==="connection_not_saved"?"本次连接校验暂未完成，尚未保存；原有连接未替换。服务恢复后按原配置正常 connect，保留原身份和任务，不重发业务。":code==="connection_verification_pending"?"原连接校验暂未完成；保留原身份和引用，不重新授权、不重发业务。稍后只读核对原任务。":code==="credential_persistence_failed"?"原连接未能安全落盘；停止重试并核对私有存储，不清状态或换身份。":auth&&original?"原连接失效；仅用 api recover-connection 验证原授权恢复，保留原profile和任务，不新建连接或重发业务。":auth?"先完成 ItPay API 正常连接；保留原身份和任务，不要创建替代请求。":["idempotency_conflict","invalid_state"].includes(code)?"原任务记录不一致；保留记录核对，不能修改冻结参数继续发送。":taskID?"原请求尚未取得可用回执；这不代表未到达服务器。保留原请求恢复，不重新调用或充值。":hubFailureInstruction(error,contract?.instruction??"Check the command and current Hub connection; preserve original tasks."),next:auth||code==="connection_not_saved"?{command:qualifyItPayCommand(`itpay api ${original?"recover-connection":"connect"}${contract?.jsonOutput?" --json":""}`,declaredAgentType()),reason:code==="connection_not_saved"?"本次连接未保存；按原配置完成正常连接":"正常授权后继续原任务"}:["idempotency_conflict","invalid_state","forbidden","publication_changed","credential_revalidation_required","credential_persistence_failed"].includes(code)?null:recover,recovery:auth&&recover?[recover]:contract?.recovery??[]},{jsonOutput:contract?.jsonOutput??process.argv.includes("--json")});
 process.exitCode=1;
}

export function registerAPICommands(program: Command): void {
const hubCmd = program.command("api").alias("hub").description("ItPay API Hub: metered API catalog, prepaid runs, wallet")
 .option("--profile <file>","absolute API installation selector")
 .option("--host <host>","payment presentation host")
 .option("--target <target>","trusted host destination for payment presentation");
hubCmd.hook("preAction", (command) => {
  const profile = command.opts().profile as string | undefined;
  if (profile) selectHubInstallation(profile);
});
hubCmd.command("admin <action>").description("Admin imports, credentials and safe acceptance via scoped ItPay Key")
 .option("--input <source>","JSON from stdin (-) or private @file; never secret argv","-").option("--json","output JSON")
 .action(async(action:string,options)=>{try{await runAdminCommand(action,String(options.input));}catch{reportCLIError(new Error("Admin action failed. Check the masked response, key scopes and current administrator role."));}});
hubCmd
  .command("connect")
  .description("Connect this CLI to your ItPay account via one browser OAuth/PKCE approval")
  .option("--json", "output JSON")
  .action(async (options) => {
    try {
      await runHubConnect({ jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_connect_failed", instruction: "确认 ITPAY_HUB_URL 可达且浏览器授权已完成。", recovery: [] });
    }
  });

hubCmd.command("original-receipt <request_key>")
 .description("Read only the original consumer's saved run result and charge; never activate or resume")
 .option("--json","output JSON")
 .action(async(requestKey:string,options)=>{try{await runHubOriginalReceipt(requestKey,{jsonOutput:Boolean(options.json)});}catch{writeCommandEnvelope({status:"error",error:{code:"receipt_unavailable",message:"原历史回执未取得。"},instruction:"保留原身份与私有候选，交 owner 核对，不恢复/新建连接或续跑。",next:null,recovery:[]},{jsonOutput:Boolean(options.json)});process.exitCode=1;}});

hubCmd.command("recover-connection")
 .description("Recover the exact original OAuth consumer with its original refresh proof; no browser or business retry")
 .option("--json","output JSON")
 .action(async(options)=>{try{await runHubRecoverConnection({jsonOutput:Boolean(options.json)});}catch(error){reportCLIError(error,{jsonOutput:Boolean(options.json),code:"connection_recovery_denied",instruction:"保留原连接及任务；不得新建连接替代。",recovery:[]});}});

hubCmd
  .command("discover")
  .description("Search the published API catalog")
  .option("--query <text>")
  .option("--kinds <kinds>", "comma-separated kinds")
  .option("--effect-classes <classes>", "comma-separated effect classes")
  .option("--limit <n>", "max items", "50")
  .option("--json", "output JSON")
  .action(async (options) => {
    try {
      await runHubDiscover({
        query: options.query,
        kinds: options.kinds ? String(options.kinds).split(",") : undefined,
        effectClasses: options.effectClasses ? String(options.effectClasses).split(",") : undefined,
        limit: Number(options.limit),
        jsonOutput: Boolean(options.json),
      });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_unavailable", instruction: "确认 Hub API 可用（ITPAY_HUB_URL）。", recovery: [] });
    }
  });

hubCmd
  .command("inspect")
  .description("Inspect an operation bound to its current publication")
  .argument("<operation_id>")
  .option("--json", "output JSON")
  .action(async (operationID: string, options) => {
    try {
      await runHubInspect(operationID, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_inspect_failed", instruction: "未取得操作合同；保留当前条件，按实际错误核对 Hub 连接，不推测发布状态。", recovery: [] });
    }
  });

hubCmd
  .command("run")
  .description("Execute a metered operation (idempotent, prepaid)")
  .argument("<operation_id>")
  .requiredOption("--publication <id>", "expected publication id from inspect")
  .requiredOption("--input <json>", "JSON object, @file path, or - for stdin")
  .option("--credential-id <id>", "stored BYOK credential reference")
  .option("--source-credentials <json>", "Native source credential references JSON or @file")
  .option("--max-charge <atoms>", "max charge in atoms (scale 6)")
  .option("--request-id <id>", "stable logical request id — replays resume the same request")
  .option("--wait <seconds>", "poll run status until terminal", "0")
  .option("--json", "output JSON")
  .action(async (operationID: string, options) => {
    try {
      await runHubRun(operationID, {
        publication: options.publication, input: options.input,
        maxCharge: options.maxCharge, requestId: options.requestId,
        credentialId: options.credentialId, sourceCredentials: options.sourceCredentials,
        waitSeconds: Number(options.wait), jsonOutput: Boolean(options.json),
      });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_run_failed", instruction: "确认 publication_id 与 input 符合 inspect 返回的契约。", recovery: [] });
    }
  });

hubCmd
  .command("resume")
  .description("Resume the original task (may POST its intent once); --wait only reads the bound run")
  .argument("<request_id>")
  .option("--wait <seconds>", "poll run status until terminal", "0")
  .option("--json", "output JSON")
  .action(async (requestID: string, options) => {
    try {
      await runHubResume(requestID, { waitSeconds: Number(options.wait), jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_resume_failed", instruction: "request_id 来自 itpay api tasks。", recovery: [] });
    }
  });

hubCmd
  .command("tasks")
  .description("List local Hub task snapshots; --refresh reads original authoritative bindings only")
  .option("--refresh", "read-only refresh of at most 20 original requests")
  .option("--request-id <id>", "select one original local request")
  .option("--json", "output JSON")
  .action(async (options) => {
    try {
      await runHubTasks({ jsonOutput: Boolean(options.json), refresh: Boolean(options.refresh), requestID: options.requestId });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_tasks_failed", instruction: "本地任务账本不可读。", recovery: [] });
    }
  });

hubCmd
  .command("run-status")
  .description("Query an existing run once (read-only); --wait is not supported")
  .showHelpAfterError("run-status is a single read and rejects --wait; inspect api resume --help only for an authorized original-task continuation.")
  .addHelpText("after", "\nrun-status accepts no --wait. Use resume <request_id> --wait only when continuing that original task is authorized; an intent resume may perform a write.")
  .argument("<run_id>")
  .option("--json", "output JSON")
  .action(async (runID: string, options) => {
    try {
      await runHubRunStatus(runID, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_status_failed", instruction: "确认 run_id。", recovery: [] });
    }
  });

const hubCredentialsCmd = hubCmd.command("credentials").description("Manage stored Hub credentials");
hubCredentialsCmd
  .command("import")
  .description("Import an ItPay API key once via stdin (echo $KEY | itpay api credentials import)")
  .option("--json", "output JSON")
  .action(async (options) => {
    try {
      await runHubCredentialsImport({ jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_credentials_failed", instruction: "密钥只能通过 stdin 导入。", recovery: [] });
    }
  });

hubCmd
  .command("doctor")
  .description("Check local agent↔hub connectivity, credentials and catalog (read-only)")
  .option("--json", "output JSON")
  .action(async (options) => {
    try {
      await runHubDoctor({ jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_doctor_failed", instruction: "按输出逐条修复本地栈。", recovery: [] });
    }
  });

hubCmd
  .command("wallet")
  .description("Show wallet balances")
  .option("--json", "output JSON")
  .action(async (options) => {
    try {
      await runHubWallet({ jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_wallet_failed", instruction: "确认身份凭据（ITPAY_HUB_TOKEN/ITPAY_HUB_KEY）。", recovery: [] });
    }
  });

hubCmd
 .command("usage")
 .description("Read current Consumer usage, gross charges, refunds and held funds")
 .option("--json", "output JSON")
 .action(async (options) => {
  try { await runHubUsage({jsonOutput:Boolean(options.json)}); }
  catch(error) { reportCLIError(error,{jsonOutput:Boolean(options.json),code:"hub_usage_failed",instruction:"确认当前连接身份与权限。",recovery:[]}); }
 });

hubCmd
  .command("transactions")
  .description("List wallet transactions")
  .option("--json", "output JSON")
  .action(async (options) => {
    try {
      await runHubTransactions({ jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_wallet_failed", instruction: "确认身份凭据。", recovery: [] });
    }
  });

hubCmd
  .command("topups")
  .description("List fixed top-up denominations")
  .option("--json", "output JSON")
  .action(async (options) => {
    try {
      await runHubTopupSkus({ jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_topup_failed", instruction: "确认 Hub API 可用。", recovery: [] });
    }
  });

hubCmd
  .command("topup")
  .description("Create an explicitly requested wallet top-up; choose an advertised company channel")
 .option("--channel <id>","explicit company payment channel from the official wallet page")
 .option("--mode <mode>","explicit advertised channel mode")
  .argument("<sku_id>")
  .option("--payer-currency <cur>", "payer currency", "CNY")
  .option("--for-intent <id>", "bind this top-up to a blocked intent so crediting resumes the original request")
  .option("--json", "output JSON")
  .action(async (skuID: string, options) => {
    try {
      await runHubTopupCreate(skuID, { payerCurrency: options.payerCurrency, forIntent: options.forIntent,channel:options.channel,mode:options.mode, jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_topup_failed", instruction: "检查 sku_id 与 payer_currency。", recovery: [] });
    }
  });

hubCmd
  .command("topup-status")
  .description("Read a top-up order status")
  .argument("<topup_id>")
  .option("--json", "output JSON")
  .action(async (topupID: string, options) => {
    try {
      await runHubTopupStatus(topupID, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_topup_failed", instruction: "确认 topup_id。", recovery: [] });
    }
  });

hubCmd
  .command("continue")
  .description("Resume a blocked intent after funding/consent")
  .argument("<intent_id>")
  .option("--json", "output JSON")
  .action(async (intentID: string, options) => {
    try {
      await runHubContinue(intentID, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_continue_failed", instruction: "确认 intent_id 仍有效。", recovery: [] });
    }
  });



}
