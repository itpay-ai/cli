// V3 CLI entrypoint. Each command maps 1:1 to a route family in
// services/backend/internal/httpapi/handlers/*.go. Commands only
// orchestrate; HTTP and rendering live in src/client and src/render.

import { Command } from "commander";
import { loadConfig, cartSessionPath, newBackendClient } from "./state/config.js";
import { CartSession } from "./state/cart_session.js";
import { defaultHostForAgentType, normalizeHost, type ClientHost } from "./state/client_context.js";
import { HttpError } from "./client/http.js";
import { runReadyz } from "./commands/readyz.js";
import { runBuy } from "./commands/buy.js";
import { runCatalogList } from "./commands/catalog.js";
import { runCheckoutPresentation } from "./commands/checkout.js";
import { runPay } from "./commands/pay.js";
import { runOrder } from "./commands/order.js";
import { runListOrders } from "./commands/orders.js";
import { runCancelRefund, runGetRefund, runListRefunds, runRefund, runWatchRefund } from "./commands/refund.js";
import {
  runCartAdd,
  runCartAddServer,
  runCartAbandonServer,
  runCartClear,
  runCartNext,
  runCartRemove,
  runCartRemoveServer,
  runCartShowServer,
} from "./commands/cart.js";
import { printErrorRecovery } from "./commands/guidance.js";
import { runDocsList, runDocsShow, runDocsSearch } from "./commands/docs.js";
import { runInstall } from "./commands/install.js";
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
  runServicesStart,
} from "./commands/services.js";

const program = new Command();
program
  .name("itpay")
  .description("V3 ItPay CLI — checkout, payment, order, and refund commands")
  .option("--agent-type <type>", "agent runtime type used for device enrollment and client-specific guidance")
  .version("2.0.4");

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
  const parsed = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is "email" | "phone" => item === "email" || item === "phone");
  return parsed.length > 0 ? parsed : undefined;
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

function reportCLIError(error: unknown): void {
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

program
  .command("readyz")
  .description("Probe the V3 backend readiness endpoint")
  .action(async () => {
    await withBackend(async (backend) => runReadyz(backend));
  });

program
  .command("next")
  .description("Show the next recommended agent action from remembered server handles")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    const session = CartSession.loadFromFile(cartSessionPath(), config.checkoutCurrency);
    try {
      await runCartNext(backend, session, { jsonOutput: Boolean(options.json) });
    } catch (error) {
      reportCLIError(error);
    }
  });

// --- catalog --------------------------------------------------------------

const catalogCmd = program.command("catalog").description("Browse V3 service catalog");

catalogCmd
  .command("list")
  .description("List all available services from the published catalog manifest")
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    await withBackend(async (backend) => runCatalogList(backend, { jsonOutput: Boolean(options.json) }));
  });

// --- install --------------------------------------------------------------

const installCmd = program.command("install").description("Show setup instructions for each agent host");

installCmd
  .argument("[target]", "install target: claude-code, codex, terminal, telegram, feishu")
  .description("Show agent-specific installation and configuration instructions")
  .action((target?: string) => {
    runInstall(target);
  });

// --- docs -----------------------------------------------------------------

const docsCmd = program.command("docs").description("Browse agent documentation");

docsCmd
  .command("list")
  .description("List all available agent doc topics")
  .action(() => {
    runDocsList();
  });

docsCmd
  .command("show")
  .description("Show a specific doc topic")
  .argument("<topic>", "doc topic name")
  .action((topic: string) => {
    runDocsShow(topic);
  });

docsCmd
  .command("search")
  .description("Search doc topics by keyword")
  .argument("<query>", "search query")
  .action((query: string) => {
    runDocsSearch(query);
  });

// --- cart ----------------------------------------------------------------

const cart = program.command("cart").description("V3 canonical server cart");

cart
  .command("add")
  .description("Add a variant/offer/quantity to the canonical server cart")
  .requiredOption("--item <catalog_item_id>")
  .requiredOption("--variant <catalog_variant_id>")
  .requiredOption("--offer <offer_id>")
  .option("--quantity <n>", "quantity", (value) => Number.parseInt(value, 10), 1)
  .option("--input <json>")
  .option("--host <host>", "client host (terminal, codex, telegram, feishu, lark, ...)", "terminal")
  .option("--target <target>", "chat id / channel id / open id for IM hosts")
  .option("--json", "output JSON instead of terminal text")
  .option("--local", "only add to the local draft cache; not valid for service-backed flows")
  .action(async (options) => {
    const config = loadConfig();
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    const addOptions = {
      catalogItemID: options.item,
      catalogVariantID: options.variant,
      offerID: options.offer,
      quantity: options.quantity,
      ...(options.input ? { input: JSON.parse(options.input) as Record<string, unknown> } : {}),
    };
    try {
      if (options.local) {
        runCartAdd(session, addOptions);
      } else {
        const backend = newBackendClient(config);
        await runCartAddServer({
          ...addOptions,
          backend,
          config,
          session,
          host: withHost(options.host),
          ...(options.target ? { target: options.target } : {}),
          jsonOutput: Boolean(options.json),
        });
      }
    } catch (error) {
      reportCLIError(error);
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
      reportCLIError(error);
    }
  });

cart
  .command("remove")
  .description("Remove a line from the canonical server cart")
  .option("--line <cart_item_id>", "server cart item id; defaults to last remembered cart item")
  .option("--variant <catalog_variant_id>", "local draft variant id, only with --local")
  .option("--offer <offer_id>", "local draft offer id, only with --local")
  .option("--local", "only remove from the explicit local draft cache")
  .action(async (options) => {
    const config = loadConfig();
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    try {
      if (options.local) {
        if (!options.variant || !options.offer) {
          throw new Error("--local remove requires --variant and --offer");
        }
        runCartRemove(session, {
          catalogVariantID: options.variant,
          offerID: options.offer,
        });
      } else {
        const backend = newBackendClient(config);
        await runCartRemoveServer(backend, session, options.line);
      }
    } catch (error) {
      reportCLIError(error);
    } finally {
      session.saveToFile(sessionPath);
    }
  });

cart
  .command("show")
  .description("Print the canonical server cart or local draft fallback")
  .action(async () => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    try {
      await runCartShowServer(backend, session);
    } catch (error) {
      reportCLIError(error);
    }
  });

cart
  .command("clear")
  .description("Abandon the canonical server cart or clear local draft fallback")
  .option("--local", "only clear local handles and explicit local draft")
  .action(async (options) => {
    const config = loadConfig();
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    try {
      if (options.local) {
        runCartClear(session);
      } else {
        const backend = newBackendClient(config);
        await runCartAbandonServer(backend, session);
      }
    } catch (error) {
      reportCLIError(error);
    } finally {
      session.saveToFile(sessionPath);
    }
  });

// --- buy / checkout ------------------------------------------------------

program
  .command("buy")
  .description("Create a V3 cart and checkout, then render the checkout QR for the host")
  .option("--host <host>", "client host (terminal, telegram, feishu, lark, ...)", "terminal")
  .option("--target <target>", "chat id / channel id / open id for IM hosts")
  .option("--item <catalog_item_id>")
  .option("--variant <catalog_variant_id>")
  .option("--offer <offer_id>")
  .option("--cart <cart_id>", "existing canonical server cart id")
  .option("--quantity <n>", "quantity", (value) => Number.parseInt(value, 10), 1)
  .option("--ref <client_reference_id>")
  .option("--contact-email <email>")
  .option("--contact-phone <phone>")
  .option("--require-contact <fields>", "comma-separated required contact fields: email,phone")
  .option("--qr-format <format>", "unicode|utf8|ansi|terminal")
  .option("--qr-file <path>", "explicit QR file path")
  .option("--pay", "also create a payment intent and optionally wait for verification")
  .option("--method <alipay|wechatpay>", "payment method for --pay", "alipay")
  .option("--no-wait", "do not wait for payment verification after --pay")
  .option("--timeout <seconds>", "max seconds to wait for payment", (value) => Number.parseInt(value, 10), 120)
  .option("--json", "output JSON instead of terminal text")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    const sessionPath = cartSessionPath();
    const session = CartSession.loadFromFile(sessionPath, config.checkoutCurrency);
    const host = withHost(options.host);

    if (options.item && options.variant && options.offer) {
      runCartAdd(session, {
        catalogItemID: options.item,
        catalogVariantID: options.variant,
        offerID: options.offer,
        quantity: options.quantity,
      });
      session.saveToFile(sessionPath);
    }

    const contact: Record<string, unknown> = {};
    if (options.contactEmail) contact.email = options.contactEmail;
    if (options.contactPhone) contact.phone = options.contactPhone;
    const requiredContactFields = parseRequiredContactFields(options.requireContact);

    const method: "alipay" | "wechatpay" = options.method === "wechatpay" ? "wechatpay" : "alipay";

    const buyOptions = {
      cartSession: session,
      host,
      ...(options.cart ? { cartID: options.cart } : {}),
      ...(options.target ? { target: options.target } : {}),
      ...(options.ref ? { clientReferenceID: options.ref } : {}),
      ...(Object.keys(contact).length > 0 ? { contact } : {}),
      ...(requiredContactFields ? { requiredContactFields } : {}),
      ...(options.qrFormat ? { qrFormat: options.qrFormat } : {}),
      ...(options.qrFile ? { qrFilePath: options.qrFile } : {}),
      ...(options.pay ? { pay: true, payMethod: method, noWait: options.wait === false, payTimeoutSec: options.timeout } : {}),
      ...(options.json ? { jsonOutput: true } : {}),
    };
    try {
      await runBuy(backend, config, buyOptions);
    } catch (error) {
      reportCLIError(error);
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
  .action(async (options) => {
    const config = loadConfig();
    const host = withHost(options.host ?? defaultHostForAgentType(config.agentType));
    const session = CartSession.loadFromFile(cartSessionPath(), config.checkoutCurrency);
    const snap = session.show();
    const { checkoutID, displayToken } = resolveCheckoutPresentationArgs({
      ...(options.id ? { requestedCheckoutID: options.id } : {}),
      ...(options.token ? { requestedDisplayToken: options.token } : {}),
      ...(snap.lastCheckoutID ? { savedCheckoutID: snap.lastCheckoutID } : {}),
      ...(snap.lastDisplayToken ? { savedDisplayToken: snap.lastDisplayToken } : {}),
    });
    const backend = newBackendClient(config);
    try {
      await runCheckoutPresentation(backend, {
        checkoutID,
        displayToken,
        host,
        baseURL: config.baseURL,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && snap.lastServiceExecutionID) {
        process.stderr.write(`[${error.status}] ${error.code}: ${error.message}\n`);
        process.stderr.write("recovery:\n");
        process.stderr.write("  - Reissue the existing Service Execution checkout handoff\n");
        process.stderr.write(`    itpay services checkout ${snap.lastServiceExecutionID} --resume --json\n`);
        process.exitCode = 1;
        return;
      }
      reportCLIError(error);
    }
  });

program
  .command("pay")
  .description("Create a V3 payment intent (CLI escape hatch — usually done by the checkout page)")
  .requiredOption("--checkout <checkout_id>")
  .requiredOption("--method <alipay|wechatpay>")
  .option("--provider <name>")
  .option("--buyer <buyer_id>")
  .option("--refresh", "request a fresh provider payment action for the existing intent")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    const method: "alipay" | "wechatpay" = options.method === "wechatpay" ? "wechatpay" : "alipay";
    const payOptions = {
      checkoutID: options.checkout,
      method,
      ...(options.provider ? { preferredProvider: options.provider } : {}),
      ...(options.buyer ? { buyerID: options.buyer } : {}),
      ...(options.refresh ? { refreshAction: true } : {}),
    };
    await runPay(backend, config, payOptions);
  });

program
  .command("order")
  .description("Read a V3 order by id")
  .argument("<order_id>")
  .option("--host <host>", "client host")
  .action(async (orderID: string, options: { host?: string }) => {
    const host = withHost(options.host ?? "terminal");
    await withBackend(async (backend) => runOrder(backend, orderID, { host }));
  });

program
  .command("orders")
  .description("List V3 orders for the account-scoped bearer session")
  .option("--limit <n>", "max orders", (value) => Number.parseInt(value, 10), 20)
  .option("--status <status>")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    await runListOrders(backend, config, {
      limit: options.limit,
      status: options.status,
    });
  });

const refund = program
  .command("refund")
	.description("Create a V3 refund request for an order")
	.option("--order <order_id>")
  .option("--reason <reason>")
  .action(async (options) => {
	if (!options.order) throw new Error("--order is required; or use `itpay refund create --order <order_id>`");
    const config = loadConfig();
    const backend = newBackendClient(config);
    const refundOptions = {
      orderID: options.order,
      ...(options.reason ? { reason: options.reason } : {}),
    };
    await runRefund(backend, config, refundOptions);
  });

refund.command("create").requiredOption("--order <order_id>").option("--reason <reason>").action(async (options) => {
	const config = loadConfig(); await runRefund(newBackendClient(config), config, { orderID: options.order, ...(options.reason ? { reason: options.reason } : {}) });
});
refund.command("list").requiredOption("--order <order_id>").action(async (options) => {
	const config = loadConfig(); await runListRefunds(newBackendClient(config), options.order);
});
refund.command("get").argument("<refund_request_id>").action(async (id) => {
	const config = loadConfig(); await runGetRefund(newBackendClient(config), id);
});
refund.command("watch").argument("<refund_request_id>").option("--interval <seconds>", "poll interval", Number, 2).option("--timeout <seconds>", "timeout", Number, 120).action(async (id, options) => {
	const config = loadConfig(); await runWatchRefund(newBackendClient(config), id, options.interval, options.timeout);
});
refund.command("cancel").argument("<refund_request_id>").option("--reason <reason>").action(async (id, options) => {
	const config = loadConfig(); await runCancelRefund(newBackendClient(config), id, options.reason);
});

// --- service execution ----------------------------------------------------

const services = program.command("services").description("Generic V3 Service Execution commands");

services
  .command("start")
  .description("Start a contract-backed service execution")
  .argument("<service_id>")
  .option("--host <host>", "client host")
  .option("--target <target>")
  .option("--buyer <buyer_id>")
  .action(async (serviceID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    await runServicesStart(backend, config, serviceID, {
      host: withHost(options.host ?? defaultHostForAgentType(config.agentType)),
      ...(options.target ? { target: options.target } : {}),
      ...(options.buyer ? { buyerID: options.buyer } : {}),
    });
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
    await runServicesInvoke(
      backend,
      config,
      serviceExecutionID,
      options.capability,
      parseKeyValueList(options.input),
      { jsonOutput: Boolean(options.json) },
    );
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
  .option("--selected-candidate-hash <hash>")
  .option("--required-before <step>")
  .option("--input <key=value>", "action input snapshot", collectOption, [])
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
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
        ...(options.selectedCandidateHash ? { selectedCandidateHash: options.selectedCandidateHash } : {}),
        ...(options.requiredBefore ? { requiredBefore: options.requiredBefore } : {}),
      },
    );
  });

services
  .command("checkout")
  .description("Create checkout from a service execution and render the ItPay checkout handoff")
  .argument("<service_execution_id>")
  .option("--capability <capability_id>")
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
    await runServicesCheckout(backend, config, serviceExecutionID, options.capability, {
      ...(options.email ? { email: options.email } : {}),
      resume: Boolean(options.resume),
      host: withHost(options.host ?? defaultHostForAgentType(config.agentType)),
      ...(options.target ? { target: options.target } : {}),
      ...(options.qrFormat ? { qrFormat: options.qrFormat } : {}),
      ...(options.qrFile ? { qrFilePath: options.qrFile } : {}),
      jsonOutput: Boolean(options.json),
      persistHandoff: (handoff) => {
        session.rememberCheckout({
          cartID: handoff.cartID,
          checkoutID: handoff.checkoutID,
          displayToken: handoff.displayToken,
          checkoutURL: handoff.checkoutURL,
          serviceExecutionID: handoff.serviceExecutionID,
        });
        session.saveToFile(sessionPath);
      },
    });
  });

services
  .command("list")
  .description("Recover service executions visible to this enrolled device or account")
  .option("--limit <number>", "maximum executions", "50")
  .option("--json", "output compact JSON")
  .action(async (options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    await runServicesList(backend, { limit: Number.parseInt(options.limit, 10), jsonOutput: Boolean(options.json) });
  });

services
  .command("get")
  .description("Read a service execution timeline")
  .argument("<service_execution_id>")
  .option("--json", "output compact JSON")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    await runServicesGet(backend, serviceExecutionID, { jsonOutput: Boolean(options.json) });
  });

services
  .command("next")
  .description("Show the next recommended agent action for a Service Execution")
  .argument("<service_execution_id>")
  .option("--json", "output JSON instead of terminal text")
  .action(async (serviceExecutionID: string, options) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    await runServicesNext(backend, serviceExecutionID, { jsonOutput: Boolean(options.json) });
  });

services
  .command("read-result")
  .description("Read a human-granted service result for this agent")
  .argument("<service_execution_id>")
  .action(async (serviceExecutionID: string) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    await runServicesReadResult(backend, serviceExecutionID);
  });

services
  .command("events")
  .description("List redacted service execution events")
  .argument("<service_execution_id>")
  .action(async (serviceExecutionID: string) => {
    const config = loadConfig();
    const backend = newBackendClient(config);
    await runServicesEvents(backend, serviceExecutionID);
  });

async function withBackend(action: (backend: ReturnType<typeof newBackendClient>) => Promise<void>): Promise<void> {
  const config = loadConfig();
  const backend = newBackendClient(config);
  try {
    await action(backend);
  } catch (error) {
    if (error instanceof HttpError) {
      reportCLIError(error);
      return;
    }
    throw error;
  }
}

program.parseAsync(process.argv).catch((error) => {
  reportCLIError(error);
});
