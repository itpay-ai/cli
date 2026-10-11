import type { ServiceAdapter } from "./adapter.js";
import { serviceInputTemplate } from "./shared/input.js";
import { workflowEnvelope } from "./shared/workflow.js";
import { CommandContractError } from "./shared/envelope.js";
export const schemaAdapter: ServiceAdapter = {
 entryInstruction: "根据服务声明填写输入，然后继续同一服务执行。",
 supported: true, inputTemplate: serviceInputTemplate,
 inputInstruction: "Agent按当前锁定模板自行修正错误字段和JSON层级，保留用户原需求和真实选择；不要向用户询问技术字段。只有真实业务歧义才问人；使用返回的执行身份恢复，未创建时用原服务。",
 guidance: () => undefined, requiresGuidance: () => false,
 overviewInstruction: () => "尚未创建执行。按用户请求选择返回的操作并填写完整输入；不猜未声明的操作。",
 locationInstruction: () => "", invocation: () => undefined,
 shouldWait: () => undefined, pollAfter: () => 0,
 preservesTerminalRecovery: () => false, projectState: () => null,
 workflow: workflowEnvelope, savedResult: () => null, deliveryGuidance: () => null, extraFacts: () => ({}),
 runError: () => {}, actionError: () => {},
 readResult: async (_backend, _model, id, options) => {
  if(options.snapshot || options.journey) throw new CommandContractError("result_selector_unsupported", "locked service does not support these result selectors", "保留同一执行；使用当前服务返回的结果读取动作，不猜其他业务选择器。", [{command:`itpay services next ${id} --json`,reason:"读取当前服务声明的动作"}]);
  return undefined;
 }, renderPage: () => false, checkout: async () => ({}),
};
export const unsupportedAdapter: ServiceAdapter = {...schemaAdapter, supported:false, workflow:()=>null, readResult:async()=>{throw new CommandContractError("presentation_contract_unavailable","locked contract unsupported","保留原执行与已有结果并停止，使用兼容CLI读取；不猜模式。",[]);}};
