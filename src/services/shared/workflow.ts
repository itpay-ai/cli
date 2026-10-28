import { workflowSubmissionActor } from "./workflow-actor.js";
import { type ServiceExecutionReadModel } from "../../client/types.js";
import { executionInputContext, operationInputTemplate, serviceInputTemplate } from "./input.js";
import { requiredInputFields } from "./platform.js";
import { fileInputTemplate, type CommandEnvelope } from "./envelope.js";

export function workflowEnvelope(model: ServiceExecutionReadModel): CommandEnvelope | undefined {
 if (!model.workflow_entry || ["completed", "delivery"].includes(model.workflow?.status ?? "")) return undefined;
 const id = model.execution.service_execution_id;
 const code=model.workflow?.error_code;
 if (["failed","quota_paused"].includes(model.workflow?.status ?? "") && ["login_required","rate_limited"].includes(code ?? "")) {
  const login=code==="login_required";
  return {status:code!,result:{service_execution_id:id,current_step:model.workflow?.current_step,...(model.quota?{quota:model.quota}:{}),...(model.workflow?.dependency?{dependency:model.workflow.dependency}:{})},instruction:login?"当前账户需要登录；展示官方登录入口后，按返回恢复动作继续同一执行，不重新创建。":"本执行达到调用额度；尊重服务端恢复时间，只继续同一执行，不自动重查或创建付款。",next:login?{command:"itpay auth login --json",reason:"登录后恢复同一执行"}:null,recovery:[]};
 }
 const action = model.workflow?.human_action;
 const state = model.workflow?.status ?? "input_required";
 if (state === "human_action" && action) return {
  status:"confirmation_required", result:{service_execution_id:id,human_action:action},
  instruction:"展示本次操作的待确认内容；已有明确同意且目标与版本未变时沿用，只补缺失的真实同意。按完整模板提交同一执行；选择对象不等于购买批准。",
  next:null,recovery:[],interaction:{schema_version:"itpay.interaction.v1",stage:"confirmation_required",input_template:fileInputTemplate(`itpay services action ${id} --action ${action.action_type} --actor-type ${workflowSubmissionActor(action)} --status approved --input-json <file> --json`,serviceInputTemplate(action.input_schema),requiredInputFields(action.input_schema),{executionID:id,userAnswerRequired:true})},
 };
 const inputRequired = state === "input_required";
 const failed = ["failed","recovery_required","cancelled"].includes(state);
 const dependency = model.workflow?.dependency;
 return {status:dependency?"dependency_unavailable":state,result:{service_execution_id:id,service_id:model.execution.service_id,...(model.workflow?{current_step:model.workflow.current_step,workflow_revision:model.workflow.revision,error_code:model.workflow.error_code}:{}),...(model.workflow?.failure?{failure:model.workflow.failure}:{}),...(dependency?{dependency}:{}),...(inputRequired?{input_schema:model.workflow_entry.input_schema}:{})},
  instruction:dependency?"服务返回外部依赖故障；保留原输入及已有结果，只按返回的重试条件恢复。不猜供应商或错误原因，也不要求用户更改业务条件。":failed?"本执行未完成；核对返回原因和已有付款事实。没有明确恢复动作时停止，不重建购买。":inputRequired?"按当前锁定合同写入完整输入文件，继续同一执行，不猜字段。":state==="payment"?"已到准备付款入口步骤；报价与当前范围批准仍需核对，实际付款由用户在官方页面完成。":"继续读取同一执行的当前状态。",
  next:failed||inputRequired||dependency?null:{command:state==="payment"?`itpay services checkout ${id} --json`:`itpay services next ${id} --json`,reason:"继续同一执行"},recovery:[],
  ...(inputRequired?{interaction:{schema_version:"itpay.interaction.v1" as const,stage:"input_required",input_template:operationInputTemplate(executionInputContext(model.execution),serviceInputTemplate(model.workflow_entry.input_schema,model.workflow?.query_input),requiredInputFields(model.workflow_entry.input_schema))}}:{}),
 };
}
