import {runAdminCommand} from "./admin.js";
import {runHubConnect,runHubContinue,runHubCredentialsImport,runHubDoctor,runHubDiscover,runHubInspect,runHubResume,runHubRun,runHubRunStatus,runHubTasks,runHubTopupCreate,runHubTopupSkus,runHubTopupStatus,runHubTransactions,runHubUsage,runHubWallet} from "./hub.js";
import { Command } from "commander";
import { HttpError } from "../client/http.js";
import { writeCommandEnvelope } from "./hub_guidance.js";

function reportCLIError(error: unknown, contract?: {jsonOutput?: boolean; code: string; instruction: string; recovery: Array<{command: string; reason: string}>}): void {
 writeCommandEnvelope({status:"error",error:{code:error instanceof HttpError ? error.code : contract?.code ?? "command_failed",message:error instanceof Error ? error.message : String(error)},instruction:contract?.instruction ?? "Check the command and the current Hub connection; resume known tasks before retrying writes.",next:null,recovery:contract?.recovery ?? []},{jsonOutput:contract?.jsonOutput ?? process.argv.includes("--json")});
 process.exitCode=1;
}

export function registerAPICommands(program: Command): void {
const hubCmd = program.command("api").alias("hub").description("ItPay API Hub: metered API catalog, prepaid runs, wallet")
 .option("--host <host>","payment presentation host")
 .option("--target <target>","trusted host destination for payment presentation");
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
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_inspect_failed", instruction: "operation_id 可能未知或未发布。", recovery: [] });
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
  .description("Resume a persisted task by request_id — same key, never a new request")
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
  .description("List durable Hub tasks (request → run/intent binding)")
  .option("--json", "output JSON")
  .action(async (options) => {
    try {
      await runHubTasks({ jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_tasks_failed", instruction: "本地任务账本不可读。", recovery: [] });
    }
  });

hubCmd
  .command("run-status")
  .description("Query an existing run — never creates a new request")
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
