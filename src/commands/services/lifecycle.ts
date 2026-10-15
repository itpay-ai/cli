import { serviceAdapter, serviceClientFeatures, errorServiceAdapter } from "../../services/registry.js";
import { type BackendClient } from "../../client/backend.js";
import { HttpError } from "../../client/http.js";
import { HttpTransportError } from "../../client/transport.js";
import { DeviceStateError } from "../../state/device_authority.js";
import { type ServiceCapability, type ServiceCapabilityInvoked, type ServiceExecutionReadModel } from "../../client/types.js";
import { operationID, type CLIConfig } from "../../state/config.js";
import { type ClientHost } from "../../state/client_context.js";
import { hasSpecializedHTTPGuidance, CommandContractError, type CommandAction, type CommandEnvelope, isTerminalServiceExecutionStatus, writeCommandEnvelope, fileInputTemplate, plainValueLines } from "../../services/shared/envelope.js";
import { ServicesCommandOptions, requiredInputFields, missingRequiredInput, stableInput, formatInputOptions, queryText, capabilityPrice, purchaseConfirmationInstruction, checkoutCommand, serviceResultPlainLines, serviceDeliveryMode, journalTaskState, remainingAutomaticWait, recordAutomaticWait, servicesNextPlainResult } from "../../services/shared/platform.js";
import { servicesNextEnvelope } from "../../services/presentation.js";
import { executionInputContext, operationInputTemplate } from "../../services/shared/input.js";
import { runServicesCheckout } from "./commerce.js";

export async function runServicesStart(
  backend: BackendClient,
  serviceID: string,
  options: ServicesCommandOptions & { host?: string; target?: string; clientContext?: Record<string, unknown>; jsonOutput?: boolean } = {},
): Promise<void> {
  const host = options.host ?? "terminal";
  const response = await backend.startServiceExecution({
    service_id: serviceID,
    client_context: {
      host,
      features: serviceClientFeatures(),
      ...(options.target ? { target: options.target } : {}),
      ...(options.clientContext ?? {}),
    },
  });
  if ("overview_only" in response) { writeServiceOverview(response.service_definition,options);return; }
  if (!serviceAdapter(response.execution).supported) {writeCommandEnvelope({status:"presentation_contract_unavailable",result:{service_execution_id:response.execution.service_execution_id,service_id:response.execution.service_id,service_contract_version_id:response.execution.service_contract_version_id},instruction:"当前锁定合同不受支持；保留原执行与已有结果并停止，使用兼容CLI，不猜模式或输入。",next:null,recovery:[]},options);return;}
  if (response.workflow_entry) {
    const guidance = serviceAdapter(response.execution).guidance(response.execution.service_id, response.workflow_entry.input_schema);
    if (serviceAdapter(response.execution).requiresGuidance(serviceID) && !guidance) {
      writeCommandEnvelope({status:"contract_unavailable",result:{service_execution_id:response.execution.service_execution_id,service_id:serviceID},instruction:"当前执行缺少可用输入合同；只读取一次同执行合同，仍缺失则报告系统缺口并停止，不猜缺失字段或旧输入写法。",next:{command:`itpay services get ${response.execution.service_execution_id} --json`,reason:"读取当前执行锁定的输入合同一次"},recovery:[]},options);
      return;
    }
    writeCommandEnvelope({
      status: "input_required",
      result: { service_execution_id: response.execution.service_execution_id, service_id: serviceID, input_schema: response.workflow_entry.input_schema, ...(guidance ? { guidance } : {}) },
      instruction: serviceAdapter(response.execution).entryInstruction,
      next: null,
      interaction: {
        schema_version: "itpay.interaction.v1",
        stage: "input_required",
        input_template: operationInputTemplate(executionInputContext(response.execution),guidance?.input_example ?? serviceAdapter(response.execution).inputTemplate(response.workflow_entry.input_schema),requiredInputFields(response.workflow_entry.input_schema)),
      },
      recovery: [] }, {...options});
    return;
  }
  const capability = response.capabilities.find((item) =>
    item.phase === response.execution.phase && !item.requires_payment,
  );
  const requiredInput = requiredInputFields(capability?.input_schema);
  const needsInput = requiredInput.length > 0;
  const command = capability && !needsInput
    ? `itpay services invoke ${response.execution.service_execution_id} --capability ${capability.capability_id} --json`
    : `itpay services next ${response.execution.service_execution_id} --json`;
  const capabilitySummary = capability ? {
    capability_id: capability.capability_id,
    required_input: requiredInput,
    input_schema: capability.input_schema,
    ...(capability.free_quota_limit !== undefined ? { free_quota_limit: capability.free_quota_limit } : {}),
  } : null;
  writeCommandEnvelope({
    status: "ready",
    result: {
      service_execution_id: response.execution.service_execution_id,
      service_id: response.execution.service_id,
      phase: response.execution.phase,
      capability: capabilitySummary,
    },
    instruction: capability
      ? "填写首选 capability 的 required_input；一次只提交当前 execution 所代表的服务意图。" + serviceAdapter(response.execution).locationInstruction(capability.input_schema)
      : "当前没有可直接调用的 capability；读取服务端下一步，不要猜测 capability。",
    next: {
      command,
      reason: capability && !needsInput ? "执行当前允许的能力" : "读取服务端计算的下一步",
    },
    ...(capability && needsInput ? {
      interaction: {
        schema_version: "itpay.interaction.v1" as const,
        stage: "input_required",
        input_template:fileInputTemplate(`itpay services invoke ${response.execution.service_execution_id} --capability ${capability.capability_id} --input-json <file> --json`,serviceAdapter(response.execution).inputTemplate(capability.input_schema ?? {}),requiredInput,{executionID:response.execution.service_execution_id}),
      },
    } : {}),
    recovery: [],
  }, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: [
      `service_execution_id: ${response.execution.service_execution_id}`,
      `service_id: ${response.execution.service_id}`,
      `phase: ${response.execution.phase}`,
      ...(capability ? [
        `capability: ${capability.capability_id}`,
        `required_input: ${requiredInput.length > 0 ? requiredInput.join(",") : "none"}`,
        ...(capability.free_quota_limit !== undefined ? [`free_quota_limit: ${capability.free_quota_limit}`] : []),
      ] : []),
    ],
  });
}

export async function runServicesInvoke(
  backend: BackendClient,
  config: CLIConfig,
  serviceExecutionID: string,
  capabilityID: string,
  input: Record<string, unknown>,
  options: ServicesCommandOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const readModel = await backend.getServiceExecution(serviceExecutionID);
  const requestedCapability = readModel.capabilities.find((capability) => capability.capability_id === capabilityID);
  if (!requestedCapability) {
    throw new CommandContractError(
      "capability_not_found",
      `capability ${capabilityID} is not available on service execution ${serviceExecutionID}`,
      "使用 Service Execution 当前返回的 capability_id，不要猜测名称。",
      [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前可用 capability" }],
    );
  }
  if (requestedCapability.requires_payment) {
    throw new CommandContractError(
      "checkout_required",
      `capability ${capabilityID} requires checkout and cannot be invoked directly`,
			"付费 capability 不能直接 invoke。不要尝试 quote、cart、buy、checkout 或 pay 作为旁路；只恢复同一 Execution 的当前合法动作。",
			[{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取同一 Execution 的当前合法动作" }],
    );
  }
  const missingInput = missingRequiredInput(requestedCapability.input_schema, input);
  if (missingInput.length > 0) {
    throw new CommandContractError(
      "capability_input_invalid",
      `missing required capability input: ${missingInput.join(", ")}`,
      "只补缺失字段到小JSON文件，再提交同一执行；本次尚未调用供应商。",
      [],
      { schema_version: "itpay.interaction.v1", stage: "input_required",
        input_template:fileInputTemplate(`itpay services invoke ${serviceExecutionID} --capability ${capabilityID} --input-json <file> --json`,serviceAdapter(readModel.execution).inputTemplate(requestedCapability.input_schema ?? {},input),missingInput,{executionID:serviceExecutionID}) },
    );
  }

  const idempotencyKey = await operationID(config, `service.invoke:${serviceExecutionID}:${capabilityID}:${stableInput(input)}`);
  let response: ServiceCapabilityInvoked;
  try {
    response = await backend.invokeServiceCapability(serviceExecutionID, capabilityID, {
      idempotency_key: idempotencyKey,
      redacted_summary: input,
    });
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== "verified_phone_required") throw error;
    writeCommandEnvelope({
      status: "human_action_required",
      result: { service_execution_id: serviceExecutionID, error_code: "verified_phone_required" },
      instruction: "需要在官方页面完成手机号验证后当前执行才能继续。运行 itpay auth login 打开官方登录页，完成手机号验证并绑定本设备后重试原命令；CLI 不接收手机号或验证码。",
      next: { command: "itpay auth login --json", reason: "完成官方手机号验证并绑定当前设备" },
      recovery: [{ command: `itpay services invoke ${serviceExecutionID} --capability ${capabilityID}${formatInputOptions(input)} --json`, reason: "仅在完成手机号验证与设备绑定后重试" }],
    }, { ...options, plainResult: ["手机号验证：itpay auth login"] });
    return;
  }
  const envelope = invokedEnvelope(response, requestedCapability, readModel.capabilities, input);
  writeCommandEnvelope(envelope.value, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: envelope.plainResult,
  });
}

export function invokedEnvelope(
  response: ServiceCapabilityInvoked,
  requestedCapability: ServiceCapability,
  capabilities: ServiceCapability[],
  input: Record<string, unknown>,
): { value: CommandEnvelope; plainResult: string[] } {
  if (response.execution_request_id) {
    const id = response.execution.service_execution_id;
    return { value: { status: "running", result: {service_execution_id: id, execution_request_id: response.execution_request_id},
      instruction: "查询已排队或正在运行。告知用户稍候，只读取同一任务的状态；不要重新发起查询，也不要把暂未返回结果说成没有车。",
      next: {command: `itpay services next ${id} --timeout 60 --json`, reason: "有界等待同一查询；宿主返回session_id时先收集该命令输出，不并行启动next", poll_after_ms:1500}, recovery: [] },
      plainResult: ["status: running", `service_execution_id: ${id}`] };
  }
  const items = response.result_items.map((item) => ({
    rank: item.rank,
    title: item.display_title,
    safe_payload: item.safe_payload,
  }));
  const quota = response.effective_quota
    ? { remaining: response.effective_quota.remaining, limit: response.effective_quota.limit }
    : undefined;
  const baseResult: Record<string, unknown> = {
    service_execution_id: response.execution.service_execution_id,
    capability_id: requestedCapability.capability_id,
    query: input,
    items,
    ...(quota ? { quota } : {}),
  };
  const businessProjection = serviceAdapter(response.execution).invocation(response,requestedCapability,input,items.length);
  if (businessProjection?.early) return businessProjection.early;
  if (businessProjection?.catalog) baseResult.catalog = businessProjection.catalog;
  let status = items.length > 0 ? "result_ready" : "no_result";
  let instruction = items.length > 0
		? "用编号、名称和可公开字段向用户说明候选；若候选列表已满足目标就停止。只有用户明确选择并希望继续时，才提交对应编号；不要向用户提及 safe_payload、Execution 或内部 ID。"
    : `没有找到与“${queryText(input)}”匹配的结果。向用户展示本次为 0 个结果并停止。不要修改、缩短或猜测其他输入；只有用户明确提供新输入后，才能启动新的查询。`;
  if (businessProjection?.instruction) instruction = businessProjection.instruction;
  let next: CommandAction | null = null;
  let quotaTemplate:ReturnType<typeof fileInputTemplate>|undefined;

  if (response.effective_quota?.exhausted) {
    status = "quota_exhausted";
    instruction = "免费额度已用完且本次没有调用 Provider。当前没有可购买的 continuation；只读取同一 Execution 的服务端恢复方向。";
    const checkoutAction = response.next_actions?.find((action) => action.kind === "create_checkout");
    const checkoutCapability = capabilities.find((capability) => capability.capability_id === checkoutAction?.capability_id);
    if (checkoutCapability) {
      baseResult.checkout = {
        capability_id: checkoutCapability.capability_id,
        ...(checkoutCapability.price_amount_minor !== undefined && checkoutCapability.price_currency ? {
          price: { amount_minor: checkoutCapability.price_amount_minor, currency: checkoutCapability.price_currency },
        } : {}),
        delivery_email_required: checkoutCapability.delivery_email_required,
      };
      const price = capabilityPrice(checkoutCapability);
      instruction = purchaseConfirmationInstruction(
        "quota_exhausted",
        price,
        checkoutCapability.delivery_email_required,
        checkoutCapability.delivery_email_purpose,
      );
      const missing=missingRequiredInput(checkoutCapability.input_schema,input);
      if(missing.length || checkoutCapability.delivery_email_required){
        quotaTemplate=fileInputTemplate(`itpay services checkout ${response.execution.service_execution_id} --capability ${checkoutCapability.capability_id} --input-json <file>${checkoutCapability.delivery_email_required?" --email <email>":""} --json`,serviceAdapter(response.execution).inputTemplate(checkoutCapability.input_schema ?? {},input),[...missing,...(checkoutCapability.delivery_email_required?["email"]:[])],{executionID:response.execution.service_execution_id});
        next=null;
      }else next={command:checkoutCommand(response.execution.service_execution_id,checkoutCapability,input),reason:`仅在用户明确同意支付 ${price} 后执行；否则停止`};
    } else {
      next = {
        command: `itpay services next ${response.execution.service_execution_id} --json`,
        reason: "读取服务端提供的付费恢复入口",
      };
    }
  } else if (items.length > 0 && requestedCapability.requires_human_action) {
    next = null;
  } else if (items.length === 0) {
    next = null;
  }
  const interaction = items.length > 0 && requestedCapability.requires_human_action
    ? {
        schema_version: "itpay.interaction.v1" as const,
        stage: "query_results_ready",
        input_template: {
          command: `itpay services action ${response.execution.service_execution_id} --action select_candidate --actor-type human --status approved --candidate <rank> --json`,
          required_input: ["rank"],
          executable: false as const,
        },
      }
    : undefined;
  if (businessProjection?.suffix) instruction += businessProjection.suffix;

  return {
    value: { status, result: baseResult, instruction, next, recovery: [], ...(quotaTemplate?{interaction:{schema_version:"itpay.interaction.v1" as const,stage:"input_required",input_template:quotaTemplate}}:interaction ? { interaction } : {}) },
    plainResult: serviceResultPlainLines(baseResult),
  };
}

export async function runServicesGet(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const response = await backend.getServiceExecution(serviceExecutionID);
  const execution = response.execution;
  const timeline = response.events.slice(-20).map((event) => ({
    sequence: event.sequence,
    step: event.type,
    status: event.status,
    phase: event.phase,
    ...(event.capability_id ? { capability_id: event.capability_id } : {}),
    occurred_at: event.occurred_at,
  }));
  const deliveryMode = serviceDeliveryMode(response);
  const lockedRefund = response.refunds.find((refund) => refund.access_locked);
  const nextState = servicesNextEnvelope(response);
  const result: Record<string, unknown> = {
    ...nextState.result,
    service_execution_id: execution.service_execution_id,
    service_id: execution.service_id,
    status: execution.status,
    phase: execution.phase,
    ...(execution.current_capability_id ? { current_capability_id: execution.current_capability_id } : {}),
    updated_at: execution.updated_at,
    timeline,
    ...(response.workflow ? { workflow: response.workflow } : {}),
    ...serviceAdapter(response.execution).extraFacts(response),
    ...(response.events.length > timeline.length ? { timeline_truncated: true } : {}),
    ...(deliveryMode ? { delivery_mode: deliveryMode } : {}),
    ...(lockedRefund ? {
      access_locked: true,
      refund: { refund_request_id: lockedRefund.refund_request_id, status: lockedRefund.status },
    } : {}),
  };
  const envelope: CommandEnvelope = {
    status: nextState.status,
    result,
    instruction: nextState.instruction,
    next: nextState.next,
    ...(nextState.interaction ? { interaction: nextState.interaction } : {}),
    ...(nextState.communication ? { communication: nextState.communication } : {}),
    ...(nextState.handoff ? { handoff: nextState.handoff } : {}),
    recovery: nextState.recovery.filter(action => action.command !== `itpay services get ${serviceExecutionID} --json`),
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: plainValueLines(envelope.result),
  });
}

export function shouldWaitForServiceResult(model: ServiceExecutionReadModel): boolean {
  if (model.current_delivery || model.workflow?.human_action || model.payment_bindings.some(binding => typeof binding.status === "string" && ["pending","outcome_unknown","unknown","processing"].includes(binding.status)) || isTerminalServiceExecutionStatus(model.execution.status)) return false;
  const adapter=serviceAdapter(model.execution);
  if(!adapter.supported)return false;
  const wait=adapter.shouldWait(model);if(wait!==undefined)return wait;
  const run=model.execution_requests?.filter(request=>request.execution_kind==="service.execution.run").at(-1);
  if(model.workflow?.status==="quota_paused" && run?.operation==="resume" && ["pending","started"].includes(run.status))return true;
  return ["queued", "running", "delivery"].includes(model.workflow?.status ?? "");
}

export async function runServicesNext(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean; sinceSnapshot?: string; timeoutSeconds?: number; pollIntervalMS?: number; sleep?: (milliseconds: number) => Promise<void>; initialModel?: ServiceExecutionReadModel; deadline?: number; startedAt?: number; waitedMS?: number } = {},
): Promise<void> {
  const started = options.startedAt ?? Date.now();
  const env=options.env ?? process.env;
  const budget=remainingAutomaticWait(serviceExecutionID,env);
  const until = Math.min(Date.now()+budget,options.timeoutSeconds===0 ? started : options.deadline ?? started + (options.timeoutSeconds ?? 0) * 1000);
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let response = options.initialModel ?? await backend.getServiceExecution(serviceExecutionID, {...(options.sinceSnapshot ? {sinceSnapshot:options.sinceSnapshot}:{}),...(options.deadline!==undefined ? {deadline:options.deadline}:until>started ? {deadline:until}: {})});
  let waitedMS = options.waitedMS ?? 0;
  while (shouldWaitForServiceResult(response) && Date.now() < until) {
    const pollStarted = Date.now();
    try {
      await sleep(Math.min(Math.max(1500, options.pollIntervalMS ?? serviceAdapter(response.execution).pollAfter(response)), Math.max(0,until-Date.now())));
      if (Date.now() >= until) break;
      try {response = await backend.getServiceExecution(serviceExecutionID, {...(options.sinceSnapshot ? {sinceSnapshot:options.sinceSnapshot}:{}),deadline:until});}
      catch(error) {if(error instanceof HttpTransportError && Date.now()>=until) break;throw error;}
    } finally {
      const elapsed = Math.max(0, Date.now()-pollStarted);
      waitedMS += elapsed;
      recordAutomaticWait(serviceExecutionID,elapsed,env);
    }
  }
  const envelope = servicesNextEnvelope(response);
  const remaining=remainingAutomaticWait(serviceExecutionID,env);
  if (shouldWaitForServiceResult(response)) {
    envelope.result={...envelope.result,waited_seconds:Math.round(waitedMS/1000),auto_wait_remaining_ms:remaining,wait_timed_out:Boolean(options.timeoutSeconds)};
    const resume={command:`itpay services next ${serviceExecutionID} --timeout 60 --json`,reason:remaining>0 ? "仍在处理，未失败；在剩余预算内读取同一任务" : "仅用户明确要求继续时读取原任务",poll_after_ms:1500};
    envelope.next=remaining>0 ? resume:null;
    if(remaining===0){envelope.recovery=[resume];envelope.instruction="自动等待预算已耗尽，停止自动续读；原任务仍处理中，不是零结果。用户明确要求时只读取原执行。";}
  }
  journalTaskState(serviceExecutionID, envelope, options.env ?? process.env);
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: servicesNextPlainResult(envelope.result),
  });
}

export interface ServicesRunOptions extends ServicesCommandOptions {
 operationID?:string;
 continuation?:{service_execution_id:string;snapshot_id:string};
  executionID?: string;
  jsonOutput?: boolean;
  host?: ClientHost;
  target?: string;
  timeoutSeconds?: number;
  pollIntervalMS?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function runServicesRun(
  backend: BackendClient,
  config: CLIConfig,
  serviceID: string,
  input: Record<string, unknown> | undefined,
  options: ServicesRunOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  const deadline = Math.min(options.deadline ?? Infinity,startedAt + (options.timeoutSeconds===0 ? 60 : Math.min(120,options.timeoutSeconds ?? 120)) * 1000);
  let id = options.executionID;
  let failureStage = id ? "read_initial_state" : "create_execution";
  let adapter = serviceAdapter({service_id:serviceID,service_contract_version_id:""});
  let inputContext = {serviceID, operationID:options.operationID, executionID:options.executionID, continuation:options.continuation};
  try {
    if (!id) {
      const started = await backend.startServiceExecution({
        service_id: serviceID,
 ...(options.operationID ? {operation_id:options.operationID}:{}),
 ...(options.continuation ? {continuation:options.continuation}:{}),
        client_context: { host: options.host ?? "terminal", features: serviceClientFeatures(), ...(options.target ? { target: options.target } : {}) },
        ...(input !== undefined ? { input } : {}),
      },{deadline});
      if ("overview_only" in started) {writeServiceOverview(started.service_definition,options);return;}
      id = started.execution.service_execution_id;
      failureStage="read_initial_state";
      if (!started.workflow_entry) {
        await runServicesNext(backend, id, {...options, deadline, startedAt});
        return;
      }
    }
    failureStage = "read_initial_state";
    let model = await backend.getServiceExecution(id,{deadline});
    adapter = serviceAdapter(model.execution);
    if (model.execution.public_binding) inputContext = {...inputContext,...executionInputContext(model.execution),...(options.continuation ? {continuation:options.continuation} : {})};
    if (model.execution.service_id !== serviceID && model.execution.public_binding?.public_service_id !== serviceID) throw new Error("execution belongs to another service");
 if(options.operationID && model.execution.public_binding?.operation_id !== options.operationID) throw new Error("execution belongs to another operation");
    if (!model.workflow_entry || (input === undefined && !model.workflow)) {
      await runServicesNext(backend, id, {...options, deadline, startedAt});
      return;
    }
    if (!serviceAdapter(model.execution).supported) {
      writeCommandEnvelope(servicesNextEnvelope(model),options);return;
    }
    if (isTerminalServiceExecutionStatus(model.execution.status)) {
      // A restored terminal purchase cannot advance or obtain a new checkout.
      writeCommandEnvelope(servicesNextEnvelope(model),options);
      return;
    }
    if (input !== undefined) {
      failureStage = "submit_input";
      model = await backend.advanceServiceExecution(id, input, `workflow-input:${id}`,{deadline});
    } else if (model.workflow?.status === "quota_paused") {
      failureStage = "resume_execution";
      model = await backend.advanceServiceExecution(id, undefined, `workflow-resume:${id}`,{deadline});
    }
    failureStage = "read_results";
    const until = options.timeoutSeconds===0 ? startedAt : Math.min(deadline,Date.now()+remainingAutomaticWait(id,options.env ?? process.env));
    const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    let waitedMS = 0;
    const paid = () => model.payment_bindings.some((binding) => binding.status === "payment_verified") || model.checkout_bindings.some((binding) => binding.status === "payment_verified");
    // A planning projection can exist before any usable result or user action.
    // Keep the existing bounded wait until there is something to hand over.
    while ((["queued", "running", "delivery", "quota_paused"].includes(model.workflow?.status ?? "") || (model.workflow?.status === "payment" && paid())) && shouldWaitForServiceResult(model) && Date.now() < until) {
      const pollStarted = Date.now();
      try {
        await sleep(Math.min(Math.max(1500,options.pollIntervalMS ?? 1500),Math.max(0,until-Date.now())));
        if (Date.now() >= until) break;
        try {model = await backend.getServiceExecution(id,{deadline:until});}
        catch(error) {if(error instanceof HttpTransportError && Date.now()>=until) break;throw error;}
      } finally {
        const elapsed = Math.max(0,Date.now()-pollStarted);
        waitedMS += elapsed;
        recordAutomaticWait(id,elapsed,options.env ?? process.env);
      }
    }
    if (model.refunds.some(refund => refund.access_locked)) {
      await runServicesNext(backend, id, {...options, initialModel:model, deadline, startedAt, waitedMS, timeoutSeconds:options.timeoutSeconds ?? 120});
      return;
    }
    if (model.purchase_preparation && !model.purchase_review) {
      await runServicesNext(backend,id,{...options,initialModel:model,deadline,startedAt,waitedMS,timeoutSeconds:0});return;
    }
    if (model.workflow?.status === "payment" && !paid()) {
      await runServicesCheckout(backend, config, id, model.workflow_entry?.capability_id, {
        ...options,
        readModel:model,
        deadline,
        ...(config.agentType ? { agentType: config.agentType } : {}),
        resume: model.checkout_bindings.length > 0,
      });
      return;
    }
    await runServicesNext(backend, id, {...options, initialModel:model, deadline, startedAt, waitedMS, timeoutSeconds:options.timeoutSeconds ?? 120});
  } catch (cause) {
    if(!id && cause instanceof HttpError && typeof cause.payload?.service_execution_id === "string") id=cause.payload.service_execution_id;
    if (cause instanceof HttpError) adapter = errorServiceAdapter(cause.payload, serviceID) ?? adapter;
 if(cause instanceof HttpError && cause.code==="public_operation_invalid")throw new CommandContractError(cause.code,cause.message,"按返回的固定service_definition核对声明操作；购买仍使用原结果详情的完整continuation模板，不改owner/snapshot、不猜operation、不重建原购买。",cause.payload?.service_definition?[]:[{command:"itpay catalog list --json",reason:"只读公开目录与定义；不创建执行"}],undefined,{service_id:serviceID,...(cause.payload?.service_definition?{service_definition:cause.payload.service_definition}:{}),execution_created:id ? true : typeof cause.payload?.execution_created==="boolean" ? cause.payload.execution_created:"unknown",...(typeof cause.payload?.provider_called==="boolean"?{provider_called:cause.payload.provider_called}:{})});

    if (cause instanceof HttpError && cause.code === "capability_input_invalid") {
      const schema = cause.payload?.input_schema;
      const executionID = cause.payload?.service_execution_id ?? id;
      const errorAdapter = errorServiceAdapter(cause.payload, serviceID) ?? adapter;
      if (!errorAdapter.supported) throw new CommandContractError("presentation_contract_unavailable",cause.message,"当前锁定合同不受此CLI支持；保留原输入和执行并停止，使用兼容CLI，不猜业务或提交修正模板。",[],undefined,{service_id:serviceID,...(executionID?{service_execution_id:executionID}:{}),original_error_code:cause.code});
      throw new CommandContractError(cause.code, cause.message,
        errorAdapter.inputInstruction,
        schema ? [] : [{command: executionID ? `itpay services get ${executionID} --json` : "itpay catalog list --json", reason: "获取当前锁定合同；仍缺合同则停止，不猜旧写法"}],
        schema ? {schema_version: "itpay.interaction.v1", stage: "input_required", input_template: operationInputTemplate({...inputContext, executionID}, errorAdapter.inputTemplate(schema,input), requiredInputFields(schema))} : undefined,
        {service_id: serviceID, ...(executionID ? {service_execution_id: executionID} : {}), execution_created: id ? true : cause.payload?.execution_created ?? "unknown", ...(typeof cause.payload?.provider_called === "boolean" ? {provider_called: cause.payload.provider_called} : {}), input_errors: cause.payload?.input_errors ?? [cause.message], ...(schema ? {input_schema: schema} : {})});
    }
    try {
      adapter.runError(cause, serviceID, id);
    } catch (businessError) {
      if (!(businessError instanceof CommandContractError)) throw businessError;
      throw new CommandContractError(businessError.code,businessError.message,businessError.instruction,businessError.recovery,businessError.interaction,{
        ...businessError.result,service_id:serviceID,...(id?{service_execution_id:id,execution_created:true}:{}),
        ...(options.operationID?{operation_id:options.operationID}:{}),failure_stage:failureStage,
        ...(cause instanceof HttpError && cause.diagnostics.length?{network_diagnostics:cause.diagnostics}:{}),
        ...(cause instanceof HttpError && typeof cause.payload?.provider_called==="boolean"?{provider_called:cause.payload.provider_called}:{})
      });
    }
    if (cause instanceof HttpError && id) cause.executionContext={
      service_id:serviceID,service_execution_id:id,execution_created:true,
      ...(inputContext.operationID?{operation_id:inputContext.operationID}:{}),failure_stage:failureStage
    };
    // Keep authentication, compatibility and provider classification available to the CLI reporter.
    if (cause instanceof HttpError && hasSpecializedHTTPGuidance(cause)) throw cause;
    if (cause instanceof HttpError && id) {
      throw new CommandContractError(cause.code,cause.message,
        "原执行已创建；读取未完成不代表没有结果。保留原输入和执行编号，先核对同一执行；初态需要输入时使用原输入模板，不新建查询。",
        [{command:`itpay services get ${id} --json`,reason:"读取原执行及当前适用动作"}],
        failureStage === "read_initial_state" && input !== undefined ? {schema_version:"itpay.interaction.v1",stage:"input_required",input_template:operationInputTemplate({...inputContext,executionID:id},input)} : undefined,
        {service_id:serviceID,service_execution_id:id,...(cause.diagnostics.length?{network_diagnostics:cause.diagnostics}:{}),...(options.operationID?{operation_id:options.operationID}:{}),execution_created:true,failure_stage:failureStage,...(typeof cause.payload?.provider_called==="boolean"?{provider_called:cause.payload.provider_called}:{})});
    }
    if (cause instanceof CommandContractError || cause instanceof DeviceStateError) throw cause;
    if (cause instanceof HttpError) throw new CommandContractError(cause.code,cause.message,"创建请求未确认成功；保留原请求，不依据列表为空自动重发。",[],undefined,{service_id:serviceID,failure_stage:failureStage,execution_created:typeof cause.payload?.execution_created === "boolean" ? cause.payload.execution_created:"unknown"});
    if (!id) {
      throw new CommandContractError(
        "workflow_start_outcome_unknown",
        cause instanceof Error ? cause.message : "service creation outcome unknown",
        "创建服务执行时没有收到完整响应。先查询当前身份可见的执行；不要直接重跑并创建替代执行。",
        [{ command: "itpay services list --json", reason: "只读可见执行；空列表不能证明创建未发生，不自动重发" }],undefined,{service_id:serviceID,failure_stage:failureStage,execution_created:"unknown",...(cause instanceof HttpTransportError?{original_error_code:cause.code,network_diagnostics:cause.diagnostics}: {})},
      );
    }
    if (cause instanceof HttpTransportError) throw new CommandContractError("workflow_outcome_unknown", cause.message, "未收到完整响应；只读同一执行的权威事实，不重放写操作或创建替代执行。", [{ command: `itpay services next ${id} --json`, reason: "核对同一执行" }],undefined,{service_id:serviceID,service_execution_id:id,execution_created:true,failure_stage:failureStage,original_error_code:cause.code,network_diagnostics:cause.diagnostics});
    throw new CommandContractError(
      "workflow_run_failed",
      cause instanceof Error ? cause.message : "workflow run failed",
      "保留当前执行并按错误处理，不要重复创建服务执行。",
      [{ command: `itpay services next ${id} --json`, reason: "读取同一执行的当前事实与恢复动作" }],
    );
  }
}

export function writeServiceOverview(definition: import("../../client/types.js").PublicServiceDefinition, options: ServicesCommandOptions & {jsonOutput?:boolean}):void {
 const adapter=serviceAdapter({service_id:definition.service_id,service_contract_version_id:definition.definition_version,public_binding:{public_service_id:definition.service_id,service_definition_version:definition.definition_version,operation_id:"overview",adapter_key:definition.adapter_key}});
 if(!adapter.supported){writeCommandEnvelope({status:"presentation_contract_unavailable",result:{service_id:definition.service_id,definition_version:definition.definition_version},instruction:"当前公开定义不受此CLI支持；保留原任务并停止，使用兼容CLI，不猜操作或输入合同。",next:null,recovery:[]},options);return;}
 const operations=definition.operations.map(op=>({operation_id:op.id,title:op.display_names["zh-CN"],role:op.role,billing_mode:op.billing_mode,requires_continuation:op.requires_continuation ?? false,...(!op.requires_continuation?{input_schema:op.input_schema,input_template:operationInputTemplate({serviceID:definition.service_id,operationID:op.id},adapter.inputTemplate(op.input_schema),requiredInputFields(op.input_schema))}:{instruction:"使用已有结果详情返回的完整准备购买模板、输入合同和continuation；不自行拼凭据或重新发现购买服务。"})}));
 const result={service_id:definition.service_id,title:definition.display_names["zh-CN"],definition_version:definition.definition_version,...(definition.guide?{guide:`itpay docs show ${definition.guide.topic}`} : {}),operations};
 writeCommandEnvelope({status:"service_overview",result,instruction:adapter.overviewInstruction(definition.guide?.topic ?? ""),next:null,recovery:[]},{...options,plainResult:plainValueLines(result)});
}
