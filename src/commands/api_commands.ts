import {shelfCategories,shelfList,shelfShow,shelfCall,shelfStatus} from "./shelf.js";
import { connectHubDevice, hubDeviceStatus, restartHubDevice } from "../state/hub_device.js";
import { hasHubInstallation, selectHubInstallation } from "../state/hub_installation.js";
import {storedHubProfile} from "../state/hub_credentials.js";
import {runAdminCommand} from "./admin.js";
import {HubTaskRequestError,runHubCredentialsImport,runHubDoctor,runHubWallet} from "./hub.js";
import { Command } from "commander";
import { HttpError } from "../client/http.js";
import {hubErrorDetails} from "../client/hub.js";
import {declaredAgentType,qualifyItPayCommand} from "../state/agent_type.js";
import { hubFailureInstruction, writeCommandEnvelope } from "./hub_guidance.js";

function reportCLIError(error: unknown, contract?: {jsonOutput?: boolean; code: string; instruction: string; recovery: Array<{command: string; reason: string}>}): void {
 const code=error instanceof HubTaskRequestError?error.code:error instanceof HttpError?error.code:error instanceof Error&&["show_required","connection_recovery_conflict","connection_recovery_denied","authorization_required","connection_not_saved","connection_verification_pending","credential_persistence_failed"].some(code=>error.message.startsWith(code+":"))?error.message.split(":",1)[0]!:contract?.code??"command_failed";
 let original=false;
 let installed=hasHubInstallation();
 try {
  const profile=storedHubProfile();
  original=Boolean(profile?.consumer_id);
  installed ||= Boolean(profile?.device_approval_id);
 } catch { original=true; }
 const auth=code==="authorization_required"||code==="unauthenticated";
 const taskID=error instanceof HubTaskRequestError?error.requestID:undefined;
 const references=error instanceof HubTaskRequestError?error.references:undefined;
 const recover=taskID?{command:qualifyItPayCommand(`itpay api status ${taskID}${contract?.jsonOutput?" --json":""}`,declaredAgentType()),reason:"只读核对同一原请求"}:null;
 writeCommandEnvelope({status:"error",error:{code,message:error instanceof Error?error.message:String(error),...(hubErrorDetails(error)?{details:hubErrorDetails(error)}:{})},...(references?{result:references}:{}),instruction:code==="connection_recovery_conflict"?"已有其他active连接；保留原连接、任务与私有候选，交owner裁决，不替换或撤销其他连接。":code==="connection_recovery_denied"?"原连接恢复未通过；保留原profile、任务及私有恢复材料，不新建connect、不重发业务。":code==="connection_not_saved"?"本次连接校验暂未完成，尚未保存；原有连接未替换。服务恢复后按原配置正常 connect，保留原身份和任务，不重发业务。":code==="connection_verification_pending"?"原连接校验暂未完成；保留原身份和引用，不重新授权、不重发业务。稍后只读核对原任务。":code==="credential_persistence_failed"?"原连接未能安全落盘；停止重试并核对私有存储，不清状态或换身份。":auth&&original?(installed?"原连接失效，请按原安装重新授权并核对原请求。":"原连接失效；按原配置 connect 核对原授权。"):auth?"先完成 ItPay API 正常连接；保留原身份和任务，不要创建替代请求。":["idempotency_conflict","invalid_state"].includes(code)?"原任务记录不一致；保留记录核对，不能修改冻结参数继续发送。":taskID?"原请求尚未取得可用回执；这不代表未到达服务器。保留原请求恢复，不重新调用或充值。":hubFailureInstruction(error,contract?.instruction??"Check the command and current Hub connection; preserve original tasks."),next:auth||code==="connection_not_saved"?{command:qualifyItPayCommand(`itpay api connect${installed&&taskID?` --request ${taskID}`:""}${contract?.jsonOutput?" --json":""}`,declaredAgentType()),reason:code==="connection_not_saved"?"本次连接未保存；按原配置完成正常连接":"正常授权后继续原任务"}:["idempotency_conflict","invalid_state","forbidden","publication_changed","credential_revalidation_required","credential_persistence_failed"].includes(code)?null:recover,recovery:auth&&recover?[recover]:contract?.recovery??[]},{jsonOutput:contract?.jsonOutput??process.argv.includes("--json")});
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
  .command("connect [action] [handle]")
  .description("Connect this CLI to your ItPay account")
  .option("--request <id>", "continue the original local API request after authorization")
  .option("--wait <seconds>", "wait for this Device authorization, up to 120 seconds", "120")
  .option("--json", "output JSON")
  .action(async (action: string | undefined, handle: string | undefined, options) => {
    try {
      if (action === "status" && handle === undefined) {
        writeCommandEnvelope({ status: "device_status", result: hubDeviceStatus(), instruction: "当前安装的连接状态。", next: null, recovery: [] }, { jsonOutput: Boolean(options.json) });
        return;
      }
      if (!hasHubInstallation() && !storedHubProfile()?.access_token) {
      throw new Error("Prepare this Agent with setup --api-prefix <absolute host directory> before connecting");
      }
      if (action !== undefined && !(action === "restart" && !handle) && (action !== "continue" || !handle)) {
      throw new Error("Use connect continue <handle> to wait for the original Device authorization");
      }
      const wait = Number(options.wait);
      if (!Number.isInteger(wait) || wait < 0 || wait > 120) throw new Error("Device wait must be between 0 and 120 seconds");
      const result = action === "restart" ? await restartHubDevice() : await connectHubDevice(handle, wait, options.request);
      const next = result.phase === "pending" ? {
        command: `itpay api connect continue --wait 120${options.json ? " --json" : ""} -- ${result.handle}`,
        reason: "等待原授权完成",
      } : result.phase === "connected" && result.request_id ? {
        command: `itpay api status ${result.request_id}${options.json ? " --json" : ""}`,
        reason: "只读核对同一原请求",
      } : null;
      writeCommandEnvelope({
        status: result.phase,
        result,
        instruction: result.phase === "pending" ? "请打开原授权链接，Agent 继续等待。" :
          result.phase === "connected" ? "已核对并保存原账号的连接。" :
            result.phase === "exchange_unknown" ? "兑换结果待核对，保留原连接。" : "本次授权已结束。",
        next,
        recovery: [],
      }, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_connect_failed", instruction: "确认 API 服务可达并保留原连接。", recovery: [] });
    }
  });


hubCmd.command("categories").description("List market categories, including empty shelves").option("--json","output JSON")
 .action(async options=>{try{await shelfCategories(Boolean(options.json));}catch(error){reportCLIError(error,{jsonOutput:Boolean(options.json),code:"categories_failed",instruction:"稍后重试分类读取。",recovery:[]});}});
hubCmd.command("list").description("List products from the shared market").option("--category <category>","category ID, slug or label")
 .option("--query <query>","search products").option("--limit <limit>","page size 1..100","20").option("--cursor <cursor>","opaque next page cursor").option("--json","output JSON")
 .action(async options=>{try{await shelfList(options);}catch(error){reportCLIError(error,{jsonOutput:Boolean(options.json),code:"list_failed",instruction:"核对分类并重试。",recovery:[]});}});
hubCmd.command("show <operation_id>").description("Show purpose, price, example and result retention").option("--json","output JSON")
 .action(async(id:string,options)=>{try{if(!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw new Error("invalid_input: invalid operation ID");await shelfShow(id,Boolean(options.json));}catch(error){reportCLIError(error,{jsonOutput:Boolean(options.json),code:"show_failed",instruction:"使用 list 返回的商品编号。",recovery:[]});}});
hubCmd.command("call [operation_id]").description("Call a shown product or continue the original pending request")
 .option("--input <input>","JSON object, @file or - for stdin").option("--pending <request_id>","continue this installation's original request").option("--json","output JSON")
 .action(async(id:string|undefined,options)=>{try{if(id&&!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw new Error("invalid_input: invalid operation ID");await shelfCall(id,options);}catch(error){reportCLIError(error,{jsonOutput:Boolean(options.json),code:"call_failed",instruction:"保留原请求。先 show 查看用途和价格。",recovery:[]});}});
hubCmd.command("status <request_id>").description("Read only the original request, result and charge").option("--json","output JSON")
 .action(async(id:string,options)=>{try{if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error("invalid_input: invalid request ID");await shelfStatus(id,Boolean(options.json));}catch(error){reportCLIError(error,{jsonOutput:Boolean(options.json),code:"status_failed",instruction:"保留原请求与安装身份，稍后读取。",recovery:[]});}});
hubCmd.command("credentials").description("Developer credential management")
 .command("import").description("Import a scoped key from stdin").option("--json","output JSON")
 .action(async options=>{try{await runHubCredentialsImport({jsonOutput:Boolean(options.json)});}catch(error){reportCLIError(error);}});
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
      reportCLIError(error, { jsonOutput: Boolean(options.json), code: "hub_wallet_failed", instruction: "确认原安装的连接身份。", recovery: [] });
    }
  });


}
