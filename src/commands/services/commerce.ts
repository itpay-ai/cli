import {presentAgent} from "../../services/shared/agent_facts.generated.js";
import {purchaseEnvelope} from "../../services/shared/purchase.js";
import type { ServiceExecutionReadModel, ServiceExecutionCheckoutCreated } from "../../client/types.js";
import {assertAccountCheckout,assertCheckoutCreation,assertCheckoutPayable} from "../checkout_handoff.js";
import { serviceAdapter, projectCheckoutPresentation } from "../../services/registry.js";
import { type BackendClient } from "../../client/backend.js";
import { HttpError } from "../../client/http.js";
import { OFFICIAL_BACKEND_URLS, type CLIConfig } from "../../state/config.js";
import {isPresentableURL} from "../../render/browser.js";
import { type ClientHost, validateContext } from "../../state/client_context.js";
import { dispatchRender, type DispatchOptions } from "../../render/index.js";
import { downloadBrandQRToTmp, ensureIdeImageAttach } from "../../render/ide.js";
import { shouldPrepareLocalCheckoutImage } from "../../render/checkout_handoff.js";
import { localizeCardURL, normalizeCardLocale, type CardLocale } from "../../render/locale.js";
import { platformKeyForHost } from "../../render/plan.js";
import { buildCheckoutQRPlan } from "../../render/checkout_plan.js";
import { CommandContractError, fileInputTemplate, writeCommandEnvelope, plainValueLines } from "../../services/shared/envelope.js";
import { ServicesCommandOptions, missingRequiredInput, formatInputOptions, tokenizedCheckoutURL, absolutePublicURL, fallbackCardURL, fallbackCardPNGURL, buildServicesCheckoutEnvelope, formatMoney } from "../../services/shared/platform.js";

export async function runServicesCheckout(
  backend: BackendClient,
  config: CLIConfig,
  serviceExecutionID: string,
  capabilityID: string | undefined,
  options: ServicesCommandOptions & {
    readModel?: ServiceExecutionReadModel;
    email?: string;
    deliveryContact?: Record<string, unknown>;
		lockedInput?: Record<string, unknown>;
    host?: ClientHost;
    target?: string;
    qrFormat?: DispatchOptions["qrFormat"];
    qrFilePath?: string;
    isTTY?: boolean;
    jsonOutput?: boolean;
    fetchImpl?: typeof fetch;
    agentType?: string;
    locale?: CardLocale;
    resume?: boolean;
    persistHandoff?: (handoff: {
      serviceExecutionID: string;
      cartID: string;
      checkoutID: string;
      displayToken: string;
      checkoutURL: string;
    }) => void;
  } = {},
): Promise<void> {
  const deadline = options.deadline ?? Date.now()+60000;
  const host = options.host ?? "terminal";
  const contextError = validateContext(host, options.target);
  if (contextError) {
    throw new CommandContractError(
      contextError.code,
      contextError.message,
      "从当前可信会话上下文补齐 Host/target；本次未创建 Checkout。",
      [],
    );
  }
  const deliveryContact = {
    ...(options.deliveryContact ?? {}),
    ...(options.email ? { email: options.email } : {}),
  };
  const currentModel = options.readModel ?? (!options.resume ? await backend.getServiceExecution(serviceExecutionID,{deadline}) : undefined);
  if(!options.resume && currentModel?.purchase_preparation && !currentModel.purchase_review){throw new CommandContractError(currentModel.purchase_preparation==="expired"?"purchase_review_expired":"purchase_review_unavailable","current purchase material unavailable","保留原购买并停止使用过期或缺失材料，不切换下单路径。",[{command:`itpay services purchase ${serviceExecutionID} --json`,reason:"读取原购买当前事实"}],undefined,{service_execution_id:serviceExecutionID,purchase_preparation:currentModel.purchase_preparation});}
  if(!options.resume && currentModel?.purchase_review){writeCommandEnvelope(purchaseEnvelope({status:"confirmation_required",service_execution_id:serviceExecutionID,completed_stage:"selected",review:currentModel.purchase_review,effects:{page_created:false,page_reused:false,payment_requested:false,charged:false,human_page_action_required:false}}),options);return;}
  if (!options.resume && !capabilityID) capabilityID = currentModel?.workflow_entry?.capability_id;
  if (!options.resume && !capabilityID) {
    throw new CommandContractError(
      "capability_required",
      "--capability is required when creating a service checkout",
      "使用当前 Service Execution 返回的付费 capability；恢复已有 Checkout 时改用 --resume。",
      [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前允许的付费 capability" }],
    );
  }
  if (!options.resume) {
    if (!currentModel) throw new Error("current execution model is required for checkout validation");
    const readModel = currentModel;
    const capability = readModel.capabilities.find((item) => item.capability_id === capabilityID);
    if (!capability || !capability.requires_payment) {
      throw new CommandContractError(
        "capability_not_checkoutable",
        `capability ${capabilityID} is not available for checkout on service execution ${serviceExecutionID}`,
        "只为当前 Service Execution 返回的 requires_payment capability 创建 Checkout。",
        [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前允许的下一步" }],
      );
    }
    if(readModel.checkout_bindings.length===0 && !readModel.actions.some(action=>action.action_type==="approve_purchase"&&action.status==="approved")) {
      await runServicesQuote(backend,serviceExecutionID,capability.capability_id,options.lockedInput ?? {},{...options,readModel,deadline});
      return;
    }
    const lockedInput = options.lockedInput ?? {};
    const missingInput = missingRequiredInput(capability.input_schema, lockedInput);
    if (missingInput.length > 0 && !readModel.workflow_entry && readModel.execution.next_action !== "create_checkout") {
      throw new CommandContractError(
        "capability_input_invalid",
        `missing required capability input: ${missingInput.join(", ")}`,
        "补齐付费 capability 的 required_input；本次没有创建 quote、Checkout 或订单。",
        [], { schema_version: "itpay.interaction.v1", stage: "input_required", input_template:fileInputTemplate(`itpay services checkout ${serviceExecutionID} --capability ${capability.capability_id} --input-json <file> --json`,serviceAdapter(readModel.execution).inputTemplate(capability.input_schema ?? {},lockedInput),missingInput,{executionID:serviceExecutionID}) },
      );
    }
    if (capability.delivery_email_required && readModel.workflow_entry?.capability_id !== capability.capability_id && String(deliveryContact.email ?? "").trim() === "") {
      throw new CommandContractError(
        "delivery_email_required",
        "delivery email is required before creating this service checkout",
        "该 capability 的交付链接会发送到用户邮箱；先向用户说明用途并询问邮箱，不要代填。",
        [], { schema_version: "itpay.interaction.v1", stage: "input_required", input_template:fileInputTemplate(`itpay services checkout ${serviceExecutionID} --capability ${capability.capability_id} --input-json <file> --email <email> --json`,lockedInput,["email"],{executionID:serviceExecutionID}) },
      );
    }
  }
  let response;
  try {response = await backend.createServiceExecutionCheckout(serviceExecutionID, {
    ...(capabilityID ? { capability_id: capabilityID } : {}),
    ...(Object.keys(deliveryContact).length > 0 ? { delivery_contact: deliveryContact } : {}),
		...(options.lockedInput && Object.keys(options.lockedInput).length > 0 ? { locked_input: options.lockedInput } : {}),
    ...(options.resume ? { resume: true } : {}),
  },{deadline});
  } catch(error) {
    if(error instanceof HttpError && error.code === "purchase_approval_required") {
      throw new CommandContractError(error.code,error.message,"先读当前报价及完整范围模板。沿用覆盖同条件的真实批准；缺少哪部分才补哪部分，不把候选选择当作价格同意，也不代付。",[{command:capabilityID ? `itpay services quote ${serviceExecutionID} --capability ${capabilityID}${formatInputOptions(options.lockedInput ?? {})} --json` : `itpay services next ${serviceExecutionID} --json`,reason:"读取同一执行的当前批准范围，不新建购买"}]);
    }
    throw error;
  }
  return presentServiceCheckout(backend,config,serviceExecutionID,response,{...options,...(currentModel ? {readModel:currentModel}:{}),deadline});
}

export async function presentServiceCheckout(backend:BackendClient,config:CLIConfig,serviceExecutionID:string,response:ServiceExecutionCheckoutCreated,options:NonNullable<Parameters<typeof runServicesCheckout>[4]>={}):Promise<void> {
 const deadline=options.deadline ?? Date.now()+60000;
 const host=options.host ?? "terminal";
 const currentModel=options.readModel;
  const checkout = response.checkout;
  const checkoutID = checkout.checkout.checkout_id;
  const agentType=options.agentType ?? config.agentType;
  if(agentType==="dot" || agentType==="muse") {
    const entry=checkout.official_entry;
    let url:URL|undefined;
    try{if(entry)url=new URL(entry.url);}catch{/* invalid owner entry is rejected below */}
    const readOriginal={command:`itpay --agent-type ${agentType} services get ${serviceExecutionID} --json`,reason:"用户完成页面操作后读取原任务事实"};
    if(!entry || entry.access!=="account_session" || entry.purpose!=="checkout" || entry.url!==checkout.checkout_url || !url || !isPresentableURL(entry.url,config.baseURL) || url.protocol!=="https:" || url.username || url.password || url.search || url.hash || url.pathname!==`/checkout/${encodeURIComponent(checkoutID)}`) {
      throw new CommandContractError("secure_handoff_unavailable","original purchase has no verified account-session entry","保留原购买；当前账号安全入口不可用，不展示或拼接 bearer 链接，不换身份或重建购买。",[readOriginal],undefined,{service_execution_id:serviceExecutionID,checkout_id:checkoutID});
    }
    assertAccountCheckout(checkout,response.cart.cart_id,serviceExecutionID);
    const expectedCard = `${url.origin}/v1/service-executions/${encodeURIComponent(serviceExecutionID)}/purchase/card.png`;
    // Only the owner-advertised original asset is fetched, through the existing
    // signed device client. An optional image cannot replace the human URL.
    const card = config.ideImageAttach && checkout.card_png_url === expectedCard
      ? await downloadBrandQRToTmp(expectedCard, "checkout", checkoutID, {
          baseURL: config.baseURL,
          fetchImpl: async (_url, init) => {
            const bytes = await backend.getServicePurchaseCard(serviceExecutionID, {deadline: Math.min(deadline, Date.now()+2000), ...(init?.signal ? {signal: init.signal} : {})});
            return new Response(Buffer.from(bytes), {headers: {"Content-Type": "image/png"}});
          },
        })
      : undefined;
    const cardHandoff = card?.ok && card.attach
      ? {card_png_url: expectedCard, qr_local_path: card.attach.localPath, markdown: `![ItPay 官方办理卡](${card.attach.localPath})`, image_status: "downloaded"}
      : {image_status: config.ideImageAttach ? "unavailable" : "disabled"};
    const effects={page_created:!response.handoff_reissued,page_reused:response.handoff_reissued===true,payment_requested:false,charged:false,human_page_action_required:true};
    writeCommandEnvelope({status:"human_checkout_required",result:{service_execution_id:serviceExecutionID,checkout_id:checkoutID,amount:formatMoney(checkout.checkout.amount_minor,checkout.checkout.currency),effects,agent_facts:presentAgent({service_execution_id:serviceExecutionID,checkout_id:checkoutID,status:"human_checkout_required",checkout:{official_entry:entry},effects},{allowedOrigins:OFFICIAL_BACKEND_URLS})},handoff:{url:entry.url,purpose:entry.purpose,status:"human_checkout_required",access:entry.access,...cardHandoff,...(entry.expires_at?{expires_at:entry.expires_at}:{})},instruction:"立即展示官方办理卡、原官方链接及金额；图片不可用时只展示原链接，不自行编码二维码；用户登录发起连接的账号完成当前步骤。二维码不是前置条件，打开链接不代表付款或出票。用户表示完成后读取原任务事实，不重复确认、换单或自动付款。",next:readOriginal,recovery:[]},{...(options.jsonOutput!==undefined?{jsonOutput:options.jsonOutput}:{}),...(options.output?{output:options.output}:{})});
    return;
  }
  assertCheckoutCreation(checkout,response.cart.cart_id,serviceExecutionID);
  options.persistHandoff?.({
    serviceExecutionID,
    cartID: response.cart.cart_id,
    checkoutID:checkout.checkout.checkout_id,
    displayToken:checkout.display_token,
    checkoutURL:tokenizedCheckoutURL(checkout.checkout_url,checkout.display_token,checkout.qr_payload),
  });
  const authoritative = checkout.display_token ? await backend.getCheckoutPresentation(checkout.checkout.checkout_id,checkout.display_token,undefined,{deadline}) : undefined;
  assertCheckoutPayable(checkout,authoritative,response.cart.cart_id,serviceExecutionID);
  if (authoritative) response.cart.items=authoritative.items;
  const displayToken = checkout.display_token;
  const locale = normalizeCardLocale(options.locale);
  const checkoutURL = tokenizedCheckoutURL(checkout.checkout_url, displayToken, checkout.qr_payload);
  const cardURL = localizeCardURL(absolutePublicURL(
    config.baseURL,
    checkout.card_url ?? fallbackCardURL(config.baseURL, checkoutID, displayToken),
  ), locale);
  const cardPNGURL = localizeCardURL(absolutePublicURL(
    config.baseURL,
    checkout.card_png_url ?? checkout.qr_png_url ?? fallbackCardPNGURL(config.baseURL, checkoutID, displayToken),
  ), locale);
  const {itinerary,itineraryTitle} = authoritative ? projectCheckoutPresentation(authoritative,currentModel) : {};
  const plan = buildCheckoutQRPlan({
    localSimulation: backend.localSimulation,
    host,
    checkoutID,
    checkoutURL,
    cardURL,
    displayToken,
    qrPayload: checkout.qr_payload,
    qrPNGURL: cardPNGURL,
    nextAction: checkout.checkout.next_action,
    orderItems: response.cart.items.map((item) => ({
      title: itineraryTitle || item.title,
      quantity: item.quantity,
      amountMinor: item.amount_minor,
      currency: item.currency,
    })),
    orderCurrency: checkout.checkout.currency,
    ...(options.agentType ? { agentType: options.agentType } : {}),
    locale,
  });



  const platform = platformKeyForHost(plan.host);
  const fetchWithinBudget: typeof fetch = async (url,init) => {
    const remaining=Math.min(2000,deadline-Date.now());
    if(remaining<=0) throw new DOMException("command deadline reached","TimeoutError");
    return (options.fetchImpl ?? globalThis.fetch)(url,{...init,signal:AbortSignal.timeout(remaining)});
  };
  if (!options.jsonOutput && (platform === "telegram" || platform === "feishu" || platform === "lark")) {
    await dispatchRender(plan, {
      host,
      ...(options.target ? { target: options.target } : {}),
      ...(options.qrFormat ? { qrFormat: options.qrFormat } : {}),
      ...(options.qrFilePath ? { qrFilePath: options.qrFilePath } : {}),
      ...(options.output ? { output: options.output } : {}),
      fetchImpl:fetchWithinBudget,
      baseURL: config.baseURL,
    });
    return;
  }
  if (shouldPrepareLocalCheckoutImage(platform)) {
    await ensureIdeImageAttach(plan, {
      enabled: config.ideImageAttach,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      fetchImpl:fetchWithinBudget,
    });
  }
  const envelope = buildServicesCheckoutEnvelope(response, checkoutURL, plan, options.agentType, options.target);
  envelope.result = {...envelope.result,effects:{page_created:!response.handoff_reissued,page_reused:response.handoff_reissued===true,payment_requested:false,charged:false,human_page_action_required:true}};
  if (itinerary) {
    envelope.result = {...envelope.result, itinerary};
    envelope.instruction = "整程一次付款，各段分别出票；展示入口不等于付款，付款成功不等于全部出票。" + envelope.instruction;
  }
  const plainResult = plainValueLines(envelope.result);
  if (!options.jsonOutput && platform === "terminal") {
  }
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult,
  });
}

export async function runServicesQuote(
  backend: BackendClient,
  serviceExecutionID: string,
  capabilityID: string,
  input: Record<string, unknown>,
  options: ServicesCommandOptions & { readModel?: ServiceExecutionReadModel; email?: string; deliveryContact?: Record<string, unknown>; jsonOutput?: boolean } = {},
): Promise<void> {
  const deadline = options.deadline ?? Date.now()+60000;
  const model = options.readModel ?? await backend.getServiceExecution(serviceExecutionID,{deadline});
  const capability = model.capabilities.find((item) => item.capability_id === capabilityID);
  if (!capability || !capability.requires_payment) {
    throw new CommandContractError(
      "capability_not_quoteable",
      `capability ${capabilityID} is not available for quote on service execution ${serviceExecutionID}`,
      "只为当前 Service Execution 返回的付费 capability 创建报价。",
      [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前合法动作" }],
    );
  }
  const selectionBacked = model.execution.status === "human_action_approved" &&
    model.allowed_actions?.some((action) => action.type === "prepare_quote" && action.capability_id === capabilityID);
  const missingInput = missingRequiredInput(capability.input_schema, input);
  if (missingInput.length > 0 && !selectionBacked && model.workflow_entry?.capability_id !== capability.capability_id) {
    throw new CommandContractError(
      "capability_input_invalid",
      `missing required capability input: ${missingInput.join(", ")}`,
      "补齐付费 capability 输入；本次没有创建 Quote、Cart 或 Checkout。",
      [], { schema_version: "itpay.interaction.v1", stage: "input_required", input_template:fileInputTemplate(`itpay services quote ${serviceExecutionID} --capability ${capability.capability_id} --input-json <file> --json`,serviceAdapter(model.execution).inputTemplate(capability.input_schema ?? {},input),missingInput,{executionID:serviceExecutionID}) },
    );
  }
  const deliveryContact = {
    ...(options.deliveryContact ?? {}),
    ...(options.email ? { email: options.email } : {}),
  };
  if (capability.delivery_email_required && model.workflow_entry?.capability_id !== capability.capability_id && String(deliveryContact.email ?? "").trim() === "") {
    throw new CommandContractError(
      "delivery_email_required",
      "delivery email is required before preparing this service quote",
      "交付链接会发送到用户邮箱；说明用途并询问邮箱，不要代填。",
      [], { schema_version: "itpay.interaction.v1", stage: "input_required", input_template:fileInputTemplate(`itpay services quote ${serviceExecutionID} --capability ${capability.capability_id} --input-json <file> --email <email> --json`,input,["email"],{executionID:serviceExecutionID}) },
    );
  }
  const quote = await backend.prepareServiceQuote(serviceExecutionID, {
    capability_id: capabilityID,
    ...(Object.keys(deliveryContact).length > 0 ? { delivery_contact: deliveryContact } : {}),
    ...(Object.keys(input).length > 0 ? { locked_input: input } : {}),
  },{deadline});
  const result = {
    service_quote_lock_id: quote.service_quote_lock_id,
    service_execution_id: quote.service_execution_id,
    capability_id: quote.capability_id,
    price: formatMoney(quote.amount_minor, quote.currency),
    ...(quote.purchase_summary?{purchase_summary:quote.purchase_summary}:{}),
    expires_at: quote.expires_at,
    ...(quote.approval_template ? {approval_template:quote.approval_template} : {}),
  };
  writeCommandEnvelope({
    status: "quote_ready",
    result,
    instruction: quote.approval_template
      ? "报价已锁定。先展示服务端商品名称、对象、范围、数量和金额；与用户请求不符时让用户决定，不自称基础报告或换商品。选择候选不是价格同意；模板中的user_approved=false表示尚未记录批准。仅在用户已有真实批准覆盖本范围时改为true并提交，不重复询问同条件已明确同意。用户授权预算时用capped及真实maximum_minor；仅委托准备入口、最终金额在官方页确认时用confirm_on_official_page。不要伪造接受未知金额或条款。"
      : "报价已锁定当前 Execution 的可信输入和价格；可单独付款，也可与其他独立 Execution 的报价合并。",
    ...(quote.approval_template ? {interaction: {schema_version:"itpay.interaction.v1" as const,stage:"purchase_approval_required",consent_rule:"先核对聊天明确确认或已存同意是否覆盖当前对象、范围、数量、价格及条款；已覆盖则沿用，不重复询问。缺少同意或实质变化才问缺失或变化部分；模板false只表示尚未记录批准，不判断聊天事实。",input_template:fileInputTemplate(`itpay services action ${serviceExecutionID} --action approve_purchase --actor-type agent --status approved --input-json <file> --json`,{...quote.approval_template},["user_approved"],{executionID:serviceExecutionID})}} : {}),
    next: quote.approval_template ? null : {
      command: `itpay cart add --quote ${quote.service_quote_lock_id} --json`,
      reason: "加入 canonical Cart",
    },
    recovery: [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "重新读取当前 Execution 状态" }],
  }, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: plainValueLines(result),
  });
}
