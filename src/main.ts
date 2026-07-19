// V3 CLI entrypoint. Each command maps 1:1 to a route family in
// services/backend/internal/httpapi/handlers/*.go. Commands only
// orchestrate; HTTP and rendering live in src/client and src/render.

import { Command } from "commander";
import { CLI_VERSION, loadConfig, cartSessionPath, newBackendClient } from "./state/config.js";
import { DeviceAuthority, DeviceAuthorizationError, DeviceStateError } from "./state/device_authority.js";
import { CartSession } from "./state/cart_session.js";
import { defaultHostForAgentType, normalizeHost, validateContext, type ClientHost } from "./state/client_context.js";
import { HttpError } from "./client/http.js";
import { runReadyz } from "./commands/readyz.js";
import { runBuy } from "./commands/buy.js";
import { runCatalogList } from "./commands/catalog.js";
import { requirePlatformCompatibility } from "./commands/compatibility.js";
import { runCheckoutPresentation } from "./commands/checkout.js";
import { runPay } from "./commands/pay.js";
import { runOrder } from "./commands/order.js";
import { runListOrders } from "./commands/orders.js";
import { runCancelRefund, runGetRefund, runListRefunds, runRefund, runWatchRefund } from "./commands/refund.js";
import {
  runCartAdd,
  runCartAddQuoteServer,
  runCartAddServer,
  runCartAbandonServer,
  runCartClear,
  runCartNext,
  runCartRemove,
  runCartRemoveServer,
  runCartShow,
  runCartShowServer,
} from "./commands/cart.js";
import { CommandContractError, errorRecoveryActions, printErrorRecovery, writeCommandEnvelope, type CommandAction } from "./commands/guidance.js";
import { runDocsList, runDocsShow, runDocsSearch } from "./commands/docs.js";
import { runInstall } from "./commands/install.js";
import { runSkillShow } from "./commands/skill.js";
import { runNext } from "./commands/next.js";
import {
  collectOption,
  parseKeyValueList,
  runServicesAction,
  runServicesCheckout,
  runServicesEvents,
  runServicesGet,
  runServicesInvoke,
  runServicesList,
  runServicesNext,
  runServicesReadResult,
  runServicesQuote,
  runServicesStart,
} from "./commands/services.js";

const program = new Command();
program
  .name("itpay")
  .description("V3 ItPay CLI — checkout, payment, order, and refund commands")
  .option("--agent-type <type>", "agent runtime type used for device enrollment and client-specific guidance")
  .version(CLI_VERSION);

function withHost(value: string | undefined): ClientHost {
  const host = normalizeHost(value);
  if (!host) {
    throw new Error(
      `invalid --host "${value ?? ""}". Supported: terminal, codex, claude-code, telegram, discord, whatsapp, feishu, lark, plain-chat`,
    );
  }
  return host;
}

function parseRequiredContactFields(value: string | undefined): Array<"email" | "phone"> | undefined {
  if (!value) {
    return undefined;
  }
  const values = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const invalid = values.filter((item) => item !== "email" && item !== "phone");
  if (invalid.length > 0) {
    throw new CommandContractError(
      "contact_field_invalid",
      `unsupported required contact fields: ${invalid.join(", ")}`,
      "--require-contact 只接受 email、phone 或二者组合。",
      [{ command: "itpay buy --help", reason: "查看 contact 参数" }],
    );
  }
  const parsed = values.filter((item): item is "email" | "phone" => item === "email" || item === "phone");
  return parsed.length > 0 ? parsed : undefined;
}

function positiveInteger(value: unknown, name: string): number {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text)) {
    throw new CommandContractError(
      "buy_parameter_invalid",
      `${name} must be a positive integer`,
      `${name} 必须是正整数；本次未创建或修改 Cart/Checkout。`,
      [{ command: "itpay buy --help", reason: "查看参数格式" }],
    );
  }
  return Number(text);
}

function resolveCheckoutPresentationArgs(input: {
  requestedCheckoutID?: string;
  requestedDisplayToken?: string;
  savedCheckoutID?: string;
  savedDisplayToken?: string;
}): { checkoutID: string; displayToken: string } {
  if (input.requestedCheckoutID && input.requestedDisplayToken) {
    return { checkoutID: input.requestedCheckoutID, displayToken: input.requestedDisplayToken };
  }
  if (input.requestedCheckoutID && !input.requestedDisplayToken) {
    if (input.savedCheckoutID === input.requestedCheckoutID && input.savedDisplayToken) {
      return { checkoutID: input.requestedCheckoutID, displayToken: input.savedDisplayToken };
    }
    const savedHint = input.savedCheckoutID ? ` Saved checkout is ${input.savedCheckoutID}.` : "";
    throw new Error(
      `display token is required for checkout ${input.requestedCheckoutID}.${savedHint} ` +
        "Pass --token for that checkout or run `itpay checkout` without --id to use the saved checkout.",
    );
  }
  if (input.requestedDisplayToken) {
    if (input.savedCheckoutID) {
      return { checkoutID: input.savedCheckoutID, displayToken: input.requestedDisplayToken };
    }
    throw new Error("checkout id is required when --token is provided and no saved checkout exists");
  }
  if (input.savedCheckoutID && input.savedDisplayToken) {
    return { checkoutID: input.savedCheckoutID, displayToken: input.savedDisplayToken };
  }
  throw new Error("checkout id and display token are required; pass --id/--token or create a checkout first");
}

function reportCLIError(
  error: unknown,
  contract?: { jsonOutput?: boolean; code: string; instruction: string; recovery?: CommandAction[] },
): void {
  const commandError = error instanceof CommandContractError ? error : undefined;
  const deviceError = error instanceof DeviceAuthorizationError ? error : undefined;
  const stateError = error instanceof DeviceStateError ? error : undefined;
  const httpRecovery = errorRecoveryActions(error).map((action) => ({
    command: action.command,
    reason: action.reason ?? action.label,
  }));
  const identityRecovery = error instanceof HttpError &&
    (error.code === "agent_identity_required" || error.code === "agent_device_session_required");
	const incompatible = error instanceof HttpError && (
		error.code === "client_upgrade_required" ||
		error.code === "client_compatibility_headers_required" ||
		error.code === "platform_release_unavailable" ||
		(error.status === 404 && error.code === "unknown_error")
	);
  const backendInternal = error instanceof HttpError && error.status === 500 && error.code === "internal_error";
  const providerConnectionUnavailable = error instanceof HttpError && error.code === "provider_connection_unavailable";
  const providerTemporary = error instanceof HttpError && error.code === "provider_temporarily_unavailable";
  const providerRejected = error instanceof HttpError && error.code === "provider_rejected";
  const providerInputRejected = error instanceof HttpError && error.code === "provider_input_rejected";
  const providerContractMismatch = error instanceof HttpError && error.code === "provider_contract_mismatch";
  const capabilityInputInvalid = error instanceof HttpError && error.code === "capability_input_invalid";
  const deviceRecovery: CommandAction[] = deviceError ? [{
    command: "itpay skill show itpay-buyer --json",
    reason: "读取身份边界；该错误需要用户或运营恢复 Backend 登记，不能通过换类型或删除本地身份绕过",
  }] : [];
  const stateRecovery: CommandAction[] = stateError ? [{
    command: "itpay skill show itpay-buyer --json",
    reason: "读取 Device 状态边界；修复当前 Host 的持久写权限后重试原命令",
  }] : [];
  const authorizationInstruction = stateError
    ? "当前运行环境无法写入 owner-only Device 状态；请保持同一 Node、CLI 和 Agent Type，在允许持久写入 ~/.itpay-v3 的执行环境中重试。不要手工创建 lock、删除 identity 或换运行时碰运气。"
    : error instanceof HttpError && error.code === "agent_device_session_required"
    ? "CLI 已自动续期并重试同一请求一次，仍被拒绝；停止重试，不要切换 Agent Type 或旋转身份。"
    : deviceError?.code === "agent_device_revoked"
      ? "Backend 已撤销当前 Device 登记；CLI 没有自动创建替代身份。停止重试并请用户或运营恢复登记。"
      : deviceError
        ? "Device 身份验证失败；停止重试，不要切换 Agent Type、删除状态或旋转私钥。"
        : undefined;
  if (contract || commandError) {
    writeCommandEnvelope({
      status: "error",
      error: {
        code: incompatible ? "backend_contract_incompatible" : commandError?.code ?? (error instanceof HttpError ? error.code : stateError?.code ?? deviceError?.code ?? contract?.code ?? "command_failed"),
        message: error instanceof Error ? error.message : String(error),
      },
      ...(error instanceof HttpError && error.payload?.service_execution_id ? {
        result: {
          service_execution_id: error.payload.service_execution_id,
          provider_called: error.payload.provider_called === true,
          ...(error.payload.effective_quota ? {
            quota: {
              remaining: error.payload.effective_quota.remaining,
              limit: error.payload.effective_quota.limit,
            },
          } : {}),
        },
      } : {}),
      instruction: incompatible
		? "立即向用户报告 error.message 并结束本次任务。不要运行任何其他 itpay、npm、which、device、docs、cart、orders 或 services 命令；不要寻找、安装或切换其他 CLI。只有运营明确提供兼容 CLI 后，才能在新的任务中重新开始。"
		: backendInternal
			? "Backend 内部故障；立即停止并向用户报告。不要重试、检查或删除 Device 身份、创建替代 Execution、切换 Backend，或尝试 quote、checkout、cart、buy、pay 等付费路径。"
		: providerConnectionUnavailable
			? "Provider 请求未发出，预留免费额度已释放；当前 Execution 已失败。立即向用户报告 error.message 并停止，不要自动重试、不要继续同一 Execution，也不要进入任何付费路径。只有运营确认连接恢复且用户明确要求重新查询后，才启动新的 Service Execution。"
		: providerTemporary
			? "上游服务暂时不可用；向用户逐字报告 error.message 和 result.quota 并停止，不要自动重试、不要创建新 Execution。只有用户之后明确提出新请求，才可重新开始。"
		: providerInputRejected
			? `Provider 明确拒绝了该输入：${error instanceof Error ? error.message : String(error)}。请向用户报告 error.message 和 result.quota 并停止。不要自行修改输入、不要重试、不要创建新 Execution；只有用户明确提供新输入后才能重新查询。`
		: providerContractMismatch
			? "Provider 响应与已发布契约不一致。这不是用户输入问题。立即停止，不要修改输入、不要重试、不要创建新 Execution，也不要进入付费路径；向用户报告平台故障和 result.quota。"
		: providerRejected
			? "Provider 拒绝了本次请求，但未声明这是输入错误；向用户逐字报告 error.message 和 result.quota 并停止。不要修改输入、不要重试、不要创建新 Execution。"
		: capabilityInputInvalid
			? "输入未通过本地校验，上游尚未被调用且用户额度未变化。向用户逐字报告 error.message 并停止，不要原样重试或运行其他恢复命令。用户提供修正后的输入后，继续使用当前未结束的 Execution。"
		: commandError?.instruction ?? authorizationInstruction ?? contract?.instruction ?? "检查命令参数后重试。",
      next: null,
      recovery: incompatible || backendInternal || providerConnectionUnavailable || providerTemporary || providerInputRejected || providerContractMismatch || providerRejected || capabilityInputInvalid ? [] : commandError?.recovery ?? (stateError ? stateRecovery : deviceError ? deviceRecovery : identityRecovery ? httpRecovery : contract?.recovery ?? []),
    }, {
      ...(contract?.jsonOutput !== undefined ? { jsonOutput: contract.jsonOutput } : {}),
      output: (text) => { process.stderr.write(text); },
    });
    process.exitCode = 1;
    return;
  }
  if (error instanceof HttpError) {
    process.stderr.write(`[${error.status}] ${error.code}: ${error.message}\n`);
    printErrorRecovery(error, (text) => process.stderr.write(text));
    process.exitCode = 1;
    return;
  }
  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  throw error;
}

function docsErrorFallback(jsonOutput: boolean): {
  jsonOutput: boolean;
  code: string;
  instruction: string;
  recovery: CommandAction[];
} {
  return {
    jsonOutput,
    code: "docs_unavailable",
    instruction: "内置文档缺失或损坏；重新安装同版本 CLI 后重试。",
    recovery: [{ command: `npm install -g @itpay/cli@${CLI_VERSION}`, reason: "恢复随包发布的文档" }],
  };
}

program
  .command("readyz")
  .description("Probe the V3 backend readiness endpoint")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await requirePlatformCompatibility(backend);
      await runReadyz(backend, { jsonOutput: Boolean(options.json), ...(config.agentType ? { agentType: config.agentType } : {}) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "backend_unavailable",
        instruction: "检查 ITPAY_BACKEND_URL 后重试；后端恢复前不要继续下单。",
        recovery: [
          { command: "echo $ITPAY_BACKEND_URL", reason: "确认当前 Backend URL" },
          { command: "itpay readyz", reason: "重试可用性检查" },
        ],
      });
    }
  });

// --- device ---------------------------------------------------------------

const deviceCmd = program.command("device").description("Recover local Device registration state after an operator-confirmed Backend reset");

deviceCmd
  .command("recover")
  .description("Forget only the selected Backend registration while preserving the local private key")
  .option("--confirm-backend-reset", "confirm that an operator reset the selected Backend registration database")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    try {
      if (!config.agentType) {
        throw new CommandContractError(
          "agent_type_required",
          "agent type is required for Backend-scoped Device recovery",
          "如实声明当前 Agent Type；恢复后必须用同一类型重新登记。",
          [{ command: "itpay install --json", reason: "选择当前真实 Agent Type" }],
        );
      }
      if (!options.confirmBackendReset) {
        throw new CommandContractError(
          "backend_reset_confirmation_required",
          "--confirm-backend-reset is required",
          "仅在运营已确认当前 Backend 的 Device 登记数据库被重建或清空后执行；普通 session 失效或 revoked 不得使用。",
          [{ command: "itpay docs show identity-and-sessions --json", reason: "检查适用边界" }],
        );
      }
      const recovered = await new DeviceAuthority({
        baseURL: config.baseURL,
        requestedAgentType: config.agentType,
        compatibilityHeaders: {},
      }).recoverBackendReset();
      writeCommandEnvelope({
        status: recovered.removed ? "backend_registration_removed" : "backend_registration_absent",
        result: {
          backend: config.baseURL,
          removed_agent_types: recovered.agentTypes,
          private_key_preserved: true,
          other_backend_registrations_preserved: true,
        },
        instruction: "只读列出 Service Executions，以同一私钥和 Agent Type 重新登记当前 Backend；不要删除 ~/.itpay-v3 或切换运行时。",
        next: {
          command: `itpay --agent-type ${config.agentType} services list --limit 1 --json`,
          reason: "用无业务写入的签名请求重新登记当前 Backend",
        },
        recovery: [],
      }, {
        jsonOutput: Boolean(options.json),
        plainResult: [
          `backend: ${config.baseURL}`,
          `registration: ${recovered.removed ? "removed" : "already absent"}`,
          "private_key: preserved",
          "other_backends: preserved",
        ],
      });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "device_recovery_failed",
        instruction: "仅恢复运营已确认重建的当前 Backend；不要删除整个 Device identity。",
        recovery: [{ command: "itpay docs show identity-and-sessions --json", reason: "检查 Device 恢复边界" }],
      });
    }
  });

// --- skill ----------------------------------------------------------------

const skillCmd = program.command("skill").description("Read complete packaged Agent skills");

skillCmd
  .command("show")
  .description("Show one complete packaged skill")
  .argument("<name>", "skill name")
  .option("--json", "output JSON instead of terminal text")
  .action((name: string, options) => {
    const config = loadConfig();
    try {
      runSkillShow(name, { jsonOutput: Boolean(options.json), ...(config.agentType ? { agentType: config.agentType } : {}) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "skill_unavailable",
        instruction: "内置 Skill 缺失或损坏；重新安装同版本 CLI 后重试。",
        recovery: [{ command: `npm install -g @itpay/cli@${CLI_VERSION}`, reason: "恢复随包发布的 Skill" }],
      });
    }
  });

program
  .command("next")
  .description("Show the next recommended agent action from remembered server handles")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    try {
      await requirePlatformCompatibility(newBackendClient(config));
      const session = CartSession.loadFromFile(cartSessionPath(), config.checkoutCurrency);
      runNext(session, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "next_unavailable",
        instruction: "Backend 合同可用后再读取本地恢复句柄；不要根据旧句柄继续交易。",
        recovery: [],
      });
    }
  });

// --- catalog --------------------------------------------------------------

const catalogCmd = program.command("catalog").description("Browse V3 service catalog");

catalogCmd
  .command("list")
  .description("List all available services from the published catalog manifest")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const backend = newBackendClient(loadConfig());
    try {
      await requirePlatformCompatibility(backend);
      await runCatalogList(backend, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "catalog_unavailable",
        instruction: "确认 ItPay 可用后重试目录读取；不要猜测 service_id。",
        recovery: [
          { command: "itpay readyz", reason: "确认 Backend 可用" },
          { command: "itpay catalog list", reason: "重新读取已发布目录" },
        ],
      });
    }
  });

// --- install --------------------------------------------------------------

const installCmd = program.command("install").description("Show setup instructions for each agent host");

installCmd
  .argument("[target]", "Agent Type, or list")
  .option("--json", "output JSON instead of terminal text")
  .description("Show agent-specific installation and configuration instructions")
  .action((target: string | undefined, options) => {
    try {
      runInstall(target, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "install_failed",
        instruction: "选择受支持的真实 Agent Type；本命令不会修改宿主配置。",
        recovery: [{ command: "itpay install --json", reason: "列出支持类型" }],
      });
    }
  });

// --- docs -----------------------------------------------------------------

const docsCmd = program.command("docs").description("Browse agent documentation");

docsCmd
  .command("list")
  .description("List all available agent doc topics")
  .option("--json", "output JSON instead of terminal text")
  .action((options) => {
    try {
      runDocsList({ jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, docsErrorFallback(Boolean(options.json)));
    }
  });

docsCmd
  .command("show")
  .description("Show a specific doc topic")
  .argument("<topic>", "doc topic name")
  .option("--json", "output JSON instead of terminal text")
  .action((topic: string, options) => {
    try {
      runDocsShow(topic, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, docsErrorFallback(Boolean(options.json)));
    }
  });

docsCmd
  .command("search")
  .description("Search doc topics by keyword")
  .argument("<query>", "search query")
  .option("--json", "output JSON instead of terminal text")
  .action((query: string, options) => {
    try {
      runDocsSearch(query, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, docsErrorFallback(Boolean(options.json)));
    }
  });

// --- cart ----------------------------------------------------------------

const cart = program.command("cart").description("V3 canonical server cart");

cart
  .command("add")
  .description("Add a variant/offer/quantity to the canonical server cart")
  .option("--item <catalog_item_id>")
  .option("--variant <catalog_variant_id>")
  .option("--offer <offer_id>")
  .option("--quote <service_quote_lock_id>", "add a prepared service quote")
  .option("--quantity <n>", "quantity", Number, 1)
  .option("--input <json>")
  .option("--host <host>", "client host (terminal, codex, telegram, feishu, lark, ...)")
  .option("--target <target>", "chat id / channel id / open id for IM hosts")
  .option("--json", "output JSON instead of terminal text")
  .option("--local", "only add to the local draft cache; not valid for service-backed flows")
  .action(async (options) => {
    const config = loadConfig();
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    const jsonOutput = Boolean(options.json);
    try {
			const quoteMode = Boolean(options.quote);
			if (quoteMode && (options.item || options.variant || options.offer || options.input || options.local)) {
				throw new CommandContractError(
					"cart_item_scope_invalid",
					"--quote cannot be combined with catalog fields, input, or --local",
					"服务报价只使用 services quote 返回的 quote ID；不要混入 Catalog 或 input 参数。",
					[{ command: "itpay cart add --help", reason: "查看两种添加方式" }],
				);
			}
			if (!quoteMode && (!options.item || !options.variant || !options.offer)) {
        throw new CommandContractError(
          "cart_item_required",
          "--item, --variant and --offer are required",
          "使用同一条 Catalog 记录返回的 item、variant 和 offer ID；不要猜测或混用。",
          [{ command: "itpay catalog list --json", reason: "读取已发布目录 ID" }],
        );
      }
			if (!quoteMode && (!Number.isInteger(options.quantity) || options.quantity < 1)) {
        throw new CommandContractError(
          "quantity_invalid",
          "--quantity must be a positive integer",
          "使用大于 0 的整数 quantity；本次未修改 Cart。",
          [{ command: "itpay cart show", reason: "确认当前 Cart 未变化" }],
        );
      }
			let input: Record<string, unknown> | undefined;
      if (options.input) {
        const parsed = JSON.parse(options.input) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new CommandContractError(
            "cart_input_invalid",
            "--input must be a JSON object",
            "按照服务合同传入 JSON object；本次未修改 Cart。",
            [{ command: "itpay catalog list --json", reason: "重新确认服务入口" }],
          );
        }
        input = parsed as Record<string, unknown>;
      }
			const addOptions = {
        catalogItemID: options.item,
        catalogVariantID: options.variant,
        offerID: options.offer,
        quantity: options.quantity,
        ...(input ? { input } : {}),
      };
			if (options.local) {
        runCartAdd(session, { ...addOptions, jsonOutput });
      } else {
        const host = withHost(options.host ?? defaultHostForAgentType(config.agentType));
        const contextError = validateContext(host, options.target);
        if (contextError) {
          throw new CommandContractError(
            contextError.code,
            contextError.message,
            "补齐当前客户端所需的 Host/target；本次未创建或修改 Cart。",
            [{ command: "itpay cart add --help", reason: "查看客户端参数" }],
          );
        }
				const backend = newBackendClient(config);
				if (quoteMode) {
					await runCartAddQuoteServer({
						serviceQuoteLockID: options.quote,
						backend, config, session, host,
						...(options.target ? { target: options.target } : {}),
						jsonOutput,
					});
				} else {
					await runCartAddServer({
						...addOptions,
						backend,
						config,
						session,
						host,
						...(options.target ? { target: options.target } : {}),
						jsonOutput,
					});
				}
      }
    } catch (error) {
			const quoteMode = Boolean(options.quote);
      reportCLIError(error, {
        jsonOutput,
        code: "cart_add_failed",
				instruction: quoteMode
					? "Quote 是否已加入 Cart 尚未确认；先恢复当前 Cart 或来源 Execution，不要重复准备报价或直接创建 Checkout。"
					: "核对 Catalog ID、输入和 Cart 状态；不要在失败后直接创建 Checkout。",
				recovery: quoteMode
					? [
						{ command: "itpay cart show --json", reason: "检查当前 canonical Cart" },
						{ command: "itpay services list --json", reason: "恢复 Quote 所属的 Service Execution" },
					]
					: [
						{ command: "itpay catalog list --json", reason: "核对已发布项目" },
						{ command: "itpay cart show", reason: "确认 canonical Cart 当前状态" },
					],
      });
    } finally {
      session.saveToFile(sessionPath);
    }
  });

cart
  .command("next")
  .description("Show the next recommended agent action for the remembered server cart")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    const session = CartSession.loadFromFile(cartSessionPath(), config.checkoutCurrency);
    try {
      await runCartNext(backend, session, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "cart_next_failed",
        instruction: "canonical Cart 无法读取；不要猜测 Cart 内容或创建重复订单。",
        recovery: [
          { command: "itpay services list --json", reason: "恢复当前设备可见的 Service Execution" },
          { command: "itpay catalog list --json", reason: "在没有可恢复执行时重新选择服务" },
        ],
      });
    }
  });

cart
  .command("remove")
  .description("Remove a line from the canonical server cart")
  .option("--line <cart_item_id>", "server cart item id; defaults to last remembered cart item")
  .option("--variant <catalog_variant_id>", "local draft variant id, only with --local")
  .option("--offer <offer_id>", "local draft offer id, only with --local")
  .option("--local", "only remove from the explicit local draft cache")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    const jsonOutput = Boolean(options.json);
    try {
      if (options.local) {
        if (!options.variant || !options.offer) {
          throw new CommandContractError(
            "local_cart_item_required",
            "--local remove requires --variant and --offer",
            "从 `cart show --local --json` 使用同一条草稿 line 的 variant 和 offer；不要猜测。",
            [{ command: "itpay cart show --local --json", reason: "读取本地草稿" }],
          );
        }
        if (options.line) {
          throw new CommandContractError(
            "cart_remove_scope_invalid",
            "--line cannot be combined with --local",
            "canonical line 使用 --line；本地草稿使用 --local --variant --offer，不要混用。",
            [{ command: "itpay cart remove --help", reason: "查看两种删除范围" }],
          );
        }
        runCartRemove(session, {
          catalogVariantID: options.variant,
          offerID: options.offer,
          jsonOutput,
        });
      } else {
        if (options.variant || options.offer) {
          throw new CommandContractError(
            "cart_remove_scope_invalid",
            "--variant and --offer require --local",
            "canonical Cart 使用 cart_item_id；先从 `cart show --json` 读取 line。",
            [{ command: "itpay cart show --json", reason: "读取 canonical line 句柄" }],
          );
        }
        if (!session.lastCartID) {
          throw new CommandContractError(
            "cart_handle_missing",
            "no canonical server cart is remembered",
            "本地没有 canonical Cart 句柄；不要用 local draft 代替服务端删除。",
            [{ command: "itpay next --json", reason: "检查其他可恢复句柄" }],
          );
        }
        const lineID = options.line ?? session.lastCartItemID;
        if (!lineID) {
          throw new CommandContractError(
            "cart_item_required",
            "cart item id is required",
            "从 `cart show --json` 选择 cart_item_id；不要使用 variant、offer 或 quote lock ID。",
            [{ command: "itpay cart show --json", reason: "读取 canonical line 句柄" }],
          );
        }
        const backend = newBackendClient(config);
        await runCartRemoveServer(backend, session, lineID, { jsonOutput });
      }
    } catch (error) {
      const locked = error instanceof HttpError && error.code === "cart_item_locked";
      reportCLIError(error, {
        jsonOutput,
        code: "cart_remove_failed",
        instruction: locked
          ? "该 line 已绑定 quote/Checkout，不能再删除；继续同一 Cart 的现有流程，不要清本地状态伪装成功。"
          : "删除失败；重新读取同一 Cart，不要假设 line 或 Service Execution 已取消。",
        recovery: [{ command: "itpay cart next --json", reason: "读取同一 Cart 的服务端首选动作" }],
      });
    } finally {
      session.saveToFile(sessionPath);
    }
  });

cart
  .command("show")
  .description("Print the canonical server cart or local draft fallback")
  .option("--json", "output JSON instead of terminal text")
  .option("--local", "show only the explicit local compatibility draft")
  .action(async (options) => {
    const config = loadConfig();
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    try {
      if (options.local) {
        runCartShow(session, { jsonOutput: Boolean(options.json) });
      } else {
        await runCartShowServer(newBackendClient(config), session, { jsonOutput: Boolean(options.json) });
      }
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "cart_show_failed",
        instruction: "canonical Cart 无法读取；不要根据本地旧句柄猜测服务端状态。",
        recovery: [
          { command: "itpay services list --json", reason: "恢复当前设备可见的 Service Execution" },
          { command: "itpay catalog list --json", reason: "在没有可恢复资源时重新选择" },
        ],
      });
    }
  });

cart
  .command("clear")
  .description("Abandon the canonical server cart or explicitly clear local state")
  .option("--local", "only clear local handles and explicit local draft")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    try {
      if (options.local) {
        runCartClear(session, { jsonOutput: Boolean(options.json) });
      } else {
        const backend = newBackendClient(config);
        await runCartAbandonServer(backend, session, { jsonOutput: Boolean(options.json) });
      }
    } catch (error) {
      const locked = error instanceof HttpError && (error.code === "cart_item_locked" || error.status === 409);
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "cart_clear_failed",
        instruction: locked
          ? "该 Cart 已绑定 quote/Checkout，不能放弃；保留本地句柄并继续同一流程。"
          : "放弃失败；不要清本地句柄或假设 Backend Cart 已改变。",
        recovery: [{ command: "itpay cart next --json", reason: "恢复同一 canonical Cart" }],
      });
    } finally {
      session.saveToFile(sessionPath);
    }
  });

// --- buy / checkout ------------------------------------------------------

program
  .command("buy")
  .description("Create a V3 cart and checkout, then render the checkout QR for the host")
  .option("--host <host>", "client host (terminal, telegram, feishu, lark, ...)")
  .option("--target <target>", "chat id / channel id / open id for IM hosts")
  .option("--item <catalog_item_id>")
  .option("--variant <catalog_variant_id>")
  .option("--offer <offer_id>")
  .option("--cart <cart_id>", "existing canonical server cart id")
  .option("--quantity <n>", "quantity", "1")
  .option("--ref <client_reference_id>")
  .option("--contact-email <email>")
  .option("--contact-phone <phone>")
  .option("--require-contact <fields>", "comma-separated required contact fields: email,phone")
  .option("--qr-format <format>", "unicode|utf8|ansi|terminal")
  .option("--qr-file <path>", "explicit QR file path")
  .option("--pay", "also create a payment intent and optionally wait for verification")
  .option("--method <alipay|wechatpay>", "payment method for --pay", "alipay")
  .option("--no-wait", "do not wait for payment verification after --pay")
  .option("--timeout <seconds>", "max seconds to wait for payment", "120")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    const jsonOutput = Boolean(options.json);
    try {
      const inline = [options.item, options.variant, options.offer].filter(Boolean).length;
      if (inline !== 0 && inline !== 3) {
        throw new CommandContractError(
          "buy_source_invalid",
          "--item, --variant and --offer must be provided together",
          "inline 购买必须同时使用 Catalog 返回的 item、variant 和 offer；不要猜测或部分提交。",
          [{ command: "itpay catalog list --json", reason: "读取已发布项目" }],
        );
      }
      if (options.cart && inline > 0) {
        throw new CommandContractError(
          "buy_source_invalid",
          "--cart cannot be combined with --item/--variant/--offer",
          "已有 canonical Cart 与 inline item 二选一；本次未修改任何资源。",
          [{ command: "itpay cart show --json", reason: "检查已有 Cart" }],
        );
      }
      if (options.method !== "alipay" && options.method !== "wechatpay") {
        throw new CommandContractError(
          "payment_method_invalid",
          `unsupported payment method: ${options.method}`,
          "--method 只接受 alipay 或 wechatpay。",
          [{ command: "itpay buy --help", reason: "查看付款参数" }],
        );
      }
      if (options.wait === false && !options.pay) {
        throw new CommandContractError(
          "buy_parameter_invalid",
          "--no-wait requires --pay",
          "普通 buy 不创建 Payment Intent；移除 --no-wait，或使用明确的付款运维流程。",
          [{ command: "itpay buy --help", reason: "查看参数关系" }],
        );
      }
      const quantity = positiveInteger(options.quantity, "--quantity");
      const timeout = positiveInteger(options.timeout, "--timeout");
      const host = withHost(options.host ?? defaultHostForAgentType(config.agentType));
      const contact: Record<string, unknown> = {};
      if (options.contactEmail) contact.email = options.contactEmail;
      if (options.contactPhone) contact.phone = options.contactPhone;
      const requiredContactFields = parseRequiredContactFields(options.requireContact);
      const missingContactFields = (requiredContactFields ?? []).filter((field) => {
        const value = contact[field];
        return typeof value !== "string" || value.trim().length === 0;
      });
      if (missingContactFields.length > 0) {
        throw new CommandContractError(
          "missing_contact",
          `missing required contact fields: ${missingContactFields.join(", ")}`,
          `向用户询问 ${missingContactFields.join(" 和 ")}，再补充对应 contact 参数重跑同一命令；禁止编造。`,
          [{ command: "itpay buy --help", reason: "查看 contact 参数" }],
        );
      }
      if (inline === 3) {
        runCartAdd(session, {
          catalogItemID: options.item,
          catalogVariantID: options.variant,
          offerID: options.offer,
          quantity,
          output: () => undefined,
        });
      }
      const buyOptions = {
        cartSession: session,
        host,
        ...(config.agentType ? { agentType: config.agentType } : {}),
        ...(options.cart ? { cartID: options.cart } : {}),
        ...(options.target ? { target: options.target } : {}),
        ...(options.ref ? { clientReferenceID: options.ref } : {}),
        ...(Object.keys(contact).length > 0 ? { contact } : {}),
        ...(requiredContactFields ? { requiredContactFields } : {}),
        ...(options.qrFormat ? { qrFormat: options.qrFormat } : {}),
        ...(options.qrFile ? { qrFilePath: options.qrFile } : {}),
        ...(options.pay ? { pay: true, payMethod: options.method, noWait: options.wait === false, payTimeoutSec: timeout } : {}),
        ...(jsonOutput ? { jsonOutput: true } : {}),
      };
      await runBuy(backend, config, buyOptions);
    } catch (error) {
      reportCLIError(error, {
        jsonOutput,
        code: "buy_failed",
		instruction: "Checkout 创建失败；保留当前 Cart/Checkout 句柄并按恢复命令继续，不要重复创建资源。",
        recovery: [
          { command: "itpay next --json", reason: "恢复最近资源" },
          { command: "itpay cart next --json", reason: "检查 canonical Cart" },
        ],
      });
    } finally {
      session.saveToFile(sessionPath);
    }
  });

program
  .command("checkout")
  .description("Read the canonical V3 checkout presentation by checkout_id + display_token")
  .option("--host <host>", "client host")
  .option("--target <target>")
  .option("--id <checkout_id>")
  .option("--token <display_token>")
  .option("--json", "output compact JSON")
  .action(async (options) => {
    const config = loadConfig();
    const host = withHost(options.host ?? defaultHostForAgentType(config.agentType));
    const session = CartSession.loadFromFile(cartSessionPath(), config.checkoutCurrency);
    const snap = session.show();
    const backend = newBackendClient(config);
    try {
      const { checkoutID, displayToken } = resolveCheckoutPresentationArgs({
        ...(options.id ? { requestedCheckoutID: options.id } : {}),
        ...(options.token ? { requestedDisplayToken: options.token } : {}),
        ...(snap.lastCheckoutID ? { savedCheckoutID: snap.lastCheckoutID } : {}),
        ...(snap.lastDisplayToken ? { savedDisplayToken: snap.lastDisplayToken } : {}),
      });
      await runCheckoutPresentation(backend, {
        checkoutID,
        displayToken,
        host,
        ...(config.agentType ? { agentType: config.agentType } : {}),
        baseURL: config.baseURL,
        jsonOutput: Boolean(options.json),
      });
    } catch (error) {
      const canResumeSavedService = Boolean(
        snap.lastServiceExecutionID && (!options.id || options.id === snap.lastCheckoutID),
      );
      const recovery: CommandAction[] = canResumeSavedService
        ? [{
            command: `itpay services checkout ${snap.lastServiceExecutionID} --resume --json`,
            reason: "为同一个 Service Execution 轮换 Checkout handoff",
          }]
        : [{ command: "itpay services list --json", reason: "查找当前设备可恢复的 Service Execution" }];
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "checkout_unavailable",
        instruction: error instanceof HttpError && error.status === 404
          ? "当前 Checkout 句柄已失效或不匹配；恢复原 Service Execution，不要创建无关购物车。"
          : "使用同一笔 Checkout 的完整 checkout_id 与 display token；不要拼接不同 Checkout 的句柄。",
        recovery,
      });
    }
  });

program
  .command("pay")
  .description("Create a V3 payment intent (CLI escape hatch — usually done by the checkout page)")
  .requiredOption("--checkout <checkout_id>")
  .requiredOption("--method <alipay|wechatpay>")
  .option("--token <display_token>", "checkout display token; defaults only from the same saved checkout")
  .option("--refresh", "request a fresh provider payment action for the existing intent")
  .option("--host <host>", "client host")
  .option("--target <target>")
  .option("--json", "output compact JSON")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    const session = CartSession.loadFromFile(cartSessionPath(), config.checkoutCurrency);
    const jsonOutput = Boolean(options.json);
    try {
      if (options.method !== "alipay" && options.method !== "wechatpay") {
        throw new CommandContractError(
          "payment_method_invalid",
          `unsupported payment method: ${options.method}`,
          "--method 只接受 alipay 或 wechatpay；本次未创建 Payment Intent。",
          [{ command: "itpay pay --help", reason: "查看受支持参数" }],
        );
      }
      const displayToken = options.token ?? (session.lastCheckoutID === options.checkout ? session.lastDisplayToken : undefined);
      if (!displayToken) {
        throw new CommandContractError(
          "checkout_token_required",
          "display token is required for this checkout",
          "提供同一 Checkout 的 display token；不要拼接其他 Checkout 的 token。",
          [{ command: "itpay next --json", reason: "恢复本机保存的同一 Checkout" }],
        );
      }
      const host = withHost(options.host ?? defaultHostForAgentType(config.agentType));
      const contextError = validateContext(host, options.target);
      if (contextError) {
        throw new CommandContractError(contextError.code, contextError.message, "为当前 Host 提供有效 target；本次未创建 Payment Intent。", [
          { command: "itpay pay --help", reason: "查看 Host 参数" },
        ]);
      }
      await runPay(backend, {
        checkoutID: options.checkout,
        displayToken,
        method: options.method,
        host,
        ...(config.agentType ? { agentType: config.agentType } : {}),
        ...(options.refresh ? { refreshAction: true } : {}),
        ...(jsonOutput ? { jsonOutput: true } : {}),
      });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput,
        code: "payment_intent_failed",
        instruction: "不要创建替代 Checkout；恢复同一 Checkout 并由用户在 ItPay 页面继续付款。",
        recovery: [{ command: "itpay next --json", reason: "恢复当前 Checkout" }],
      });
    }
  });

program
  .command("order")
  .description("Read a V3 order by id")
  .argument("<order_id>")
  .option("--host <host>", "client host")
  .option("--json", "output JSON instead of terminal text")
  .action(async (orderID: string, options: { host?: string; json?: boolean }) => {
    if (options.host) withHost(options.host);
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runOrder(backend, orderID, { ...(options.host ? { host: options.host } : {}), jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "order_read_failed",
        instruction: "确认订单属于当前账号或已绑定 Agent；不要通过错误差异探测其他账号的订单。",
        recovery: [{ command: "itpay services list --json", reason: "恢复当前身份可见的 Service Execution" }],
      });
    }
  });

program
  .command("orders")
  .description("List V3 orders for the account-scoped bearer session")
  .option("--limit <n>", "max orders", (value) => Number.parseInt(value, 10), 20)
  .option("--status <status>")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runListOrders(backend, config, {
        limit: options.limit,
        status: options.status,
        jsonOutput: Boolean(options.json),
      });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "orders_list_failed",
        instruction: "订单历史只对 account-scoped Buyer session 开放；不要通过错误差异探测其他账号。",
        recovery: [{ command: "itpay services list --json", reason: "恢复当前 Agent 设备可见的执行" }],
      });
    }
  });

const refund = program
  .command("refund")
	.enablePositionalOptions()
	.description("Create a V3 refund request for an order")
	.option("--order <order_id>")
  .option("--reason <reason>")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
	if (!options.order) {
		process.stdout.write(refund.helpInformation());
		process.stdout.write("\ninstruction: 使用 `itpay refund create --order <order_id>` 提交退款；本次未发送请求。\n");
		return;
	}
	await executeRefundCreate(options.order, options.reason, Boolean(options.json));
  });

refund.command("create").option("--order <order_id>").option("--reason <reason>").option("--json", "output JSON instead of terminal text").action(async (options) => {
	const inherited = refund.opts();
	const orderID = options.order ?? inherited.order;
	if (!orderID) {
		reportCLIError(new Error("--order is required"), {
			jsonOutput: Boolean(options.json ?? inherited.json),
			code: "order_required",
			instruction: "使用用户订单的 order_id；不要猜测或代填。",
			recovery: [{ command: "itpay services list --json", reason: "恢复当前身份可见的 Service Execution" }],
		});
		return;
	}
	const reason = options.reason ?? inherited.reason;
	await executeRefundCreate(orderID, reason, Boolean(options.json ?? inherited.json));
});
refund.command("list").option("--order <order_id>").option("--json", "output JSON instead of terminal text").action(async (options) => {
	const inherited = refund.opts();
	const orderID = options.order ?? inherited.order;
	const jsonOutput = Boolean(options.json ?? inherited.json);
	if (!orderID) {
		reportCLIError(new Error("--order is required"), {
			jsonOutput,
			code: "order_required",
			instruction: "使用用户订单的 order_id；不要猜测或代填。",
			recovery: [{ command: "itpay services list --json", reason: "恢复当前身份可见的 Service Execution" }],
		});
		return;
	}
	const config = loadConfig();
	try {
		await runListRefunds(newBackendClient(config), { orderID, jsonOutput });
	} catch (error) {
		reportCLIError(error, {
			jsonOutput,
			code: "refund_list_failed",
			instruction: "确认订单属于当前账号或已绑定 Agent；不要探测其他账号的退款。",
			recovery: [{ command: "itpay services list --json", reason: "恢复当前身份可见的 Service Execution" }],
		});
	}
});
refund.command("get").argument("<refund_request_id>").option("--json", "output JSON instead of terminal text").action(async (id, options) => {
	const config = loadConfig();
	try {
		await runGetRefund(newBackendClient(config), id, { jsonOutput: Boolean(options.json ?? refund.opts().json) });
	} catch (error) {
		reportCLIError(error, {
			jsonOutput: Boolean(options.json ?? refund.opts().json),
			code: "refund_read_failed",
			instruction: "确认退款属于当前账号或已绑定 Agent；不要探测其他账号的退款。",
			recovery: [{ command: "itpay services list --json", reason: "恢复当前身份可见的 Service Execution" }],
		});
	}
});
refund.command("watch").argument("<refund_request_id>").option("--interval <seconds>", "poll interval", Number, 2).option("--timeout <seconds>", "timeout", Number, 120).option("--json", "output JSON instead of terminal text").action(async (id, options) => {
	const config = loadConfig();
	try {
		await runWatchRefund(newBackendClient(config), id, {
			intervalSeconds: options.interval,
			timeoutSeconds: options.timeout,
			jsonOutput: Boolean(options.json ?? refund.opts().json),
		});
	} catch (error) {
		reportCLIError(error, {
			jsonOutput: Boolean(options.json ?? refund.opts().json),
			code: "refund_watch_failed",
			instruction: "检查退款 ID 和轮询参数后恢复同一退款；不要重复申请。",
			recovery: [{ command: `itpay refund get ${id} --json`, reason: "读取当前权威状态" }],
		});
	}
});
refund.command("cancel").argument("<refund_request_id>").option("--reason <reason>").option("--json", "output JSON instead of terminal text").action(async (id, options) => {
	const config = loadConfig();
	try {
		await runCancelRefund(newBackendClient(config), id, options.reason, { jsonOutput: Boolean(options.json ?? refund.opts().json) });
	} catch (error) {
		reportCLIError(error, {
			jsonOutput: Boolean(options.json ?? refund.opts().json),
			code: "refund_cancel_failed",
			instruction: "取消未生效；以 Refund Owner 当前状态为准，不要重复退款或自行解除交付锁。",
			recovery: [{ command: `itpay refund get ${id} --json`, reason: "读取当前权威状态" }],
		});
	}
});

async function executeRefundCreate(orderID: string, reason: string | undefined, jsonOutput: boolean): Promise<void> {
	const config = loadConfig();
	try {
		await runRefund(newBackendClient(config), config, { orderID, ...(reason ? { reason } : {}), jsonOutput });
	} catch (error) {
		reportCLIError(error, {
			jsonOutput,
			code: "refund_create_failed",
			instruction: "确认订单属于当前账号且可退款；不要修改金额、支付或消费事实。",
			recovery: [
				{ command: `itpay order ${orderID} --json`, reason: "检查订单和交付锁" },
				{ command: `itpay refund list --order ${orderID} --json`, reason: "检查已有退款" },
			],
		});
	}
}

// --- service execution ----------------------------------------------------

const services = program.command("services").description("Generic V3 Service Execution commands");

services
  .command("start")
  .description("Start a contract-backed service execution")
  .argument("<service_id>")
  .option("--host <host>", "client host")
  .option("--target <target>")
  .option("--json", "output JSON instead of terminal text")
  .action(async (serviceID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runServicesStart(backend, serviceID, {
        host: withHost(options.host ?? defaultHostForAgentType(config.agentType)),
        ...(options.target ? { target: options.target } : {}),
        jsonOutput: Boolean(options.json),
      });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "service_start_failed",
        instruction: "只使用已发布 Catalog 返回的 service_id；设备身份问题应由 CLI 自动恢复。",
        recovery: [
          { command: "itpay catalog list", reason: "重新取得有效 service_id" },
          { command: "itpay readyz", reason: "确认 Backend 可用" },
        ],
      });
    }
  });

services
  .command("invoke")
  .description("Invoke an agent-visible service capability")
  .argument("<service_execution_id>")
  .requiredOption("--capability <capability_id>")
  .option("--input <key=value>", "redacted input summary", collectOption, [])
  .option("--json", "output JSON")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runServicesInvoke(
        backend,
        config,
        serviceExecutionID,
        options.capability,
        parseKeyValueList(options.input),
        { jsonOutput: Boolean(options.json) },
      );
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "service_invoke_failed",
        instruction: "读取当前 Service Execution 的合法下一步后重试；不要复用已结束的 execution。",
        recovery: [
          { command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前合法动作" },
          { command: `itpay services get ${serviceExecutionID} --json`, reason: "检查执行状态" },
        ],
      });
    }
  });

services
  .command("action")
  .description("Record a service execution action or human handoff result")
  .argument("<service_execution_id>")
  .requiredOption("--action <action_type>")
  .option("--actor-type <actor_type>")
  .option("--actor-id <actor_id>")
  .option("--status <status>", "pending, approved, rejected, expired, or cancelled")
  .option("--candidate <rank>", "select a displayed candidate by its rank", Number)
  .option("--result-item <service_capability_result_item_id>")
  .option("--required-before <step>")
  .option("--input <key=value>", "action input snapshot", collectOption, [])
  .option("--json", "output JSON instead of terminal text")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runServicesAction(
        backend,
        serviceExecutionID,
        options.action,
        parseKeyValueList(options.input),
        {
          ...(options.actorType ? { actorType: options.actorType } : {}),
          ...(options.actorId ? { actorID: options.actorId } : {}),
          ...(options.status ? { status: options.status } : {}),
          ...(options.candidate !== undefined ? { candidateRank: options.candidate } : {}),
          ...(options.resultItem ? { resultItemID: options.resultItem } : {}),
          ...(options.requiredBefore ? { requiredBefore: options.requiredBefore } : {}),
          jsonOutput: Boolean(options.json),
        },
      );
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "service_action_failed",
        instruction: "读取当前 Service Execution 的合法 action 后重试；不要猜测状态或候选 ID。",
        recovery: [
          { command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前可选动作" },
          { command: `itpay services get ${serviceExecutionID} --json`, reason: "检查执行状态" },
        ],
      });
    }
  });

services
  .command("quote")
  .description("Prepare a paid service quote without creating a Cart or Checkout")
  .argument("<service_execution_id>")
  .requiredOption("--capability <capability_id>")
  .option("--input <key=value>", "input to lock into the paid service quote", collectOption, [])
  .option("--email <delivery_email>")
  .option("--json", "output compact JSON")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    try {
      await runServicesQuote(
        newBackendClient(config),
        serviceExecutionID,
        options.capability,
        parseKeyValueList(options.input),
        { ...(options.email ? { email: options.email } : {}), jsonOutput: Boolean(options.json) },
      );
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "service_quote_failed",
        instruction: "按当前 Execution 的合法付费 capability 和可信输入重试；本次不要自行创建 Cart 或 Checkout。",
        recovery: [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前合法动作" }],
      });
    }
  });

services
  .command("checkout")
  .description("Create checkout from a service execution and render the ItPay checkout handoff")
  .argument("<service_execution_id>")
  .option("--capability <capability_id>")
	.option("--input <key=value>", "input to lock into the paid service quote", collectOption, [])
  .option("--email <delivery_email>")
  .option("--resume", "reissue the existing checkout handoff without creating another checkout")
  .option("--host <host>", "client host (terminal, codex, telegram, feishu, lark, ...)")
  .option("--target <target>", "chat id / channel id / open id for IM hosts")
  .option("--qr-format <format>", "unicode|utf8|ansi|terminal")
  .option("--qr-file <path>", "explicit QR file path")
  .option("--json", "output JSON instead of terminal text")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    try {
      await runServicesCheckout(backend, config, serviceExecutionID, options.capability, {
        ...(options.email ? { email: options.email } : {}),
        lockedInput: parseKeyValueList(options.input),
        resume: Boolean(options.resume),
        host: withHost(options.host ?? defaultHostForAgentType(config.agentType)),
        ...(config.agentType ? { agentType: config.agentType } : {}),
        ...(options.target ? { target: options.target } : {}),
        ...(options.qrFormat ? { qrFormat: options.qrFormat } : {}),
        ...(options.qrFile ? { qrFilePath: options.qrFile } : {}),
        jsonOutput: Boolean(options.json),
        persistHandoff: (handoff) => {
          session.rememberCheckout({
            checkoutID: handoff.checkoutID,
            displayToken: handoff.displayToken,
            checkoutURL: handoff.checkoutURL,
            serviceExecutionID: handoff.serviceExecutionID,
          });
          session.saveToFile(sessionPath);
        },
      });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "service_checkout_failed",
        instruction: "读取当前 Service Execution 后按服务端允许的 capability、输入和交付要求重试；不要创建替代 Checkout。",
        recovery: [
          { command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前合法下一步" },
          { command: `itpay services get ${serviceExecutionID} --json`, reason: "检查 Checkout 与执行状态" },
        ],
      });
    }
  });

services
  .command("list")
  .description("Recover service executions visible to this enrolled device or account")
  .option("--limit <number>", "maximum executions", "10")
  .option("--json", "output compact JSON")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runServicesList(backend, { limit: Number.parseInt(options.limit, 10), jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "services_list_failed",
        instruction: "确认当前设备身份和 Backend 后重试；不要猜测 Service Execution ID。",
        recovery: [
          { command: "itpay readyz --json", reason: "确认 Backend 可用" },
          { command: "itpay services list --limit 10 --json", reason: "重新读取最近执行" },
        ],
      });
    }
  });

services
  .command("get")
  .description("Read a service execution timeline")
  .argument("<service_execution_id>")
  .option("--json", "output compact JSON")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runServicesGet(backend, serviceExecutionID, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "service_get_failed",
        instruction: "确认 execution 属于当前设备或账号；不要通过错误差异探测其他账号。",
        recovery: [{ command: "itpay services list --json", reason: "读取当前身份可见的执行" }],
      });
    }
  });

services
  .command("next")
  .description("Show the next recommended agent action for a Service Execution")
  .argument("<service_execution_id>")
  .option("--json", "output JSON instead of terminal text")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runServicesNext(backend, serviceExecutionID, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "service_next_failed",
        instruction: "检查 Service Execution 是否属于当前设备或账号，然后读取完整时间线。",
        recovery: [{ command: `itpay services get ${serviceExecutionID} --json`, reason: "检查执行状态与归属" }],
      });
    }
  });

services
  .command("read-result")
  .description("Read a human-granted service result for this agent")
  .argument("<service_execution_id>")
  .option("--json", "output JSON instead of terminal text")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runServicesReadResult(backend, serviceExecutionID, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "agent_access_denied",
        instruction: "请用户在订单页面重新授权；不要使用开发者权限绕过授权或退款锁。",
        recovery: [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "检查交付模式和 grant 状态" }],
      });
    }
  });

services
  .command("events")
  .description("List redacted service execution events")
  .argument("<service_execution_id>")
  .option("--after-sequence <number>", "return events after this sequence", "0")
  .option("--limit <number>", "maximum events (1-100)", "50")
  .option("--json", "output compact JSON")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    try {
      await runServicesEvents(backend, serviceExecutionID, {
        afterSequence: Number(options.afterSequence),
        limit: Number(options.limit),
        jsonOutput: Boolean(options.json),
      });
    } catch (error) {
      reportCLIError(error, {
        jsonOutput: Boolean(options.json),
        code: "service_events_failed",
        instruction: "确认 execution 属于当前身份；事件只用于诊断，不要据此重放业务步骤。",
        recovery: [
          { command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前业务动作" },
          { command: "itpay services list --json", reason: "列出当前身份可见执行" },
        ],
      });
    }
  });

program.parseAsync(process.argv).catch((error) => {
  reportCLIError(error);
});
