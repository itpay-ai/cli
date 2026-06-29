import {
  appendURLQuery, booleanFlag, cliCommand, cryptoRandom, csvValues, deleteSessionCredential, intFlag, output, positional, readConfig, readCredentials,
  readSessionToken, readState, safeErrorMessage, sleep, splitCSV, stripInternalBuyerFields, updateRun, writeConfig,
  writeCredentials, writeSessionCredentials, writeState, shellQuote
} from "./env.js";
import { clientCommandArgs, clientHost, clientTarget } from "./client-context.js";
import { coreApi, coreApiBase } from "./http.js";
import { buildHumanActionRenderPlan, renderHumanAction, renderItPayPaymentAction, shouldReturnAfterAgentTextQR, writeWaitHeartbeat } from "./render-human.js";

async function buyerBuy(flags) {
  rejectBuyerSandboxFlag(flags);
  const showThenWait = shouldReturnAfterAgentTextQR(flags);
  const selectionID = flags.selection || flags.variant || flags.catalog_variant_id || flags.item || flags.catalog_item_id;
  if (!selectionID) throw new Error("catalog variant id is required, for example: itp buy <variant_id> --email <buyer_email> --json");
  const selection = await resolveBuyerCatalogSelection(selectionID, flags);
  const cart = await createBuyerCart(selection, flags);
  let checkout = await createBuyerCheckoutFromCart(cart, selection, flags);
  if (checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth") {
    await renderHumanAction(checkout.human_action, flags);
    if (flags.no_wait || flags.no_wait_auth || showThenWait) {
      output(buyerRunOutput({
        status: "waiting_human_auth",
        selection,
        cart,
        checkout,
        human_action: checkout.human_action,
        render_plan: buildHumanActionRenderPlan(checkout.human_action, {}, flags),
        agent_next_actions: checkout.agent_next_actions || ["wait_human_auth", "poll_checkout"],
        next: {
          command: cliCommand("buyer", "checkout", "resume", checkout.checkout_id, "--json"),
          safe_for_agent: true,
          instruction: "After presenting the first-purchase auth-to-payment QR, keep this resume command running/waiting. Do not stop at QR display unless the human explicitly asks you to pause."
        }
      }));
      return;
    }
    checkout = await waitBuyerCheckoutAuth(checkout, flags);
  }
  if (!buyerSessionReadyForPayment()) {
    output(buyerRunOutput(buyerSessionRequiredBeforePayment(checkout, flags, { selection, cart })));
    return;
  }
  const intent = checkout.payment_intent_id
    ? await getBuyerPaymentIntent(checkout.payment_intent_id, flags)
    : await createBuyerPaymentIntent(checkout.checkout_id, flags);
  await renderItPayPaymentAction(intent, flags);

  if (flags.no_wait || flags.no_wait_payment || showThenWait) {
    output(buyerRunOutput({
      status: "payment_handoff_required",
      selection,
      cart,
      checkout,
      payment_intent: intent,
      ...paymentHandoffFields(intent, flags),
      agent_next_actions: paymentHandoffAgentNextActions(),
      next: paymentHandoffNext()
    }));
    return;
  }

  const event = await waitBuyerPayment(intent, flags);
  const delivery = await waitBuyerDelivery(checkout.checkout_id, flags);
  const finalCheckout = delivery.checkout || checkout;
  const delivered = isBuyerDeliveryComplete(finalCheckout);
  output(buyerRunOutput({
    status: delivered ? "delivery_claimable" : event.event_type === "payment_intent.verified" ? "payment_verified" : "waiting_user_payment",
    selection,
    cart,
    checkout: finalCheckout,
    payment_intent: intent,
    payment_event: event,
    delivery: delivery.delivery || finalCheckout.delivery || null,
    agent_next_actions: delivered ? deliveryAwareAgentNextActions(finalCheckout) : (finalCheckout.agent_next_actions || event.agent_next_actions || intent.agent_next_actions || ["poll_checkout"]),
    optional_agent_read_grant: optionalAgentReadGrantHint(finalCheckout.checkout_id || checkout.checkout_id, finalCheckout),
    next: delivered
      ? { type: "human_check_email", safe_for_agent: true }
      : { command: cliCommand("buyer", "checkout", "status", checkout.checkout_id, "--json"), safe_for_agent: true }
  }));
}

async function buyer(command, rest, flags) {
  rejectBuyerSandboxFlag(flags);
  const subcommand = rest[0] && !String(rest[0]).startsWith("--") ? rest[0] : "";
  if (command === "catalog") {
    if (subcommand === "search") {
      const query = flags.query || flags.q || "";
      const body = {
        query,
        filters: buyerCatalogSearchFilters(flags),
        context: {},
        pagination: {}
      };
      if (flags.currency) body.context.currency = String(flags.currency);
      if (flags.page_size || flags.limit) body.pagination.limit = Number(flags.page_size || flags.limit);
      if (flags.cursor) body.pagination.cursor = String(flags.cursor);
      const catalog = await coreApi("/v1/catalog/search", { method: "POST", body }, flags);
      output(buyerRunOutput({
        status: "catalog_search_results",
        catalog,
        products: catalog.products || [],
        catalog_guidance: catalogSearchGuidance(catalog, body),
        agent_next_actions: ["compare_services", "explain_options_to_human", "ask_human_to_confirm_purchase_option"]
      }));
      return;
    }
    if (subcommand === "get") {
      const selectionID = flags.variant || flags.catalog_variant_id || flags.item || flags.catalog_item_id || rest[1];
      const detail = await getBuyerUCPProduct(selectionID, flags);
      const selection = selectionFromUCPProduct(detail, selectionID, flags);
      output(buyerRunOutput({
        status: "catalog_product",
        product: detail.product,
        messages: detail.messages || [],
        selection,
        catalog_guidance: catalogSelectionGuidance(selection),
        agent_next_actions: ["explain_selected_service", "ask_human_to_confirm_purchase", "create_cart_after_confirmation"]
      }));
      return;
    }
  }
  if (command === "cart") {
    if (subcommand === "create") {
      const selectionIDs = buyerCartSelectionIDs(rest, flags);
      const selections = await resolveBuyerCatalogSelections(selectionIDs, flags);
      const cart = await createBuyerCartFromSelections(selections, flags);
      output(buyerRunOutput({
        status: "cart_created",
        selection: selections.length === 1 ? selections[0] : undefined,
        selections,
        cart,
        cart_id: cart.cart_id || cart.id,
        cart_guidance: cartConfirmationGuidance(cart, selections),
        agent_next_actions: cart.agent_next_actions || ["show_cart_to_human", "confirm_cart_before_checkout"]
      }));
      return;
    }
    if (subcommand === "add") {
      const cartID = flags.cart || flags.cart_id || positional(rest, 1) || readState().last_core_cart_id;
      if (!cartID) throw new Error("cart_id is required");
      const selectionIDs = buyerCartSelectionIDs(["add"], flags);
      const selections = await resolveBuyerCatalogSelections(selectionIDs, flags);
      if (selections.length !== 1) throw new Error("buyer cart add requires exactly one --variant");
      const cart = await addBuyerCartLineItem(cartID, selections[0], flags);
      output(buyerRunOutput({
        status: "cart_updated",
        selection: selections[0],
        cart,
        cart_id: cart.cart_id || cart.id,
        cart_guidance: cartConfirmationGuidance(cart, selections),
        agent_next_actions: cart.agent_next_actions || ["show_cart_to_human", "confirm_cart_before_checkout"]
      }));
      return;
    }
    if (subcommand === "remove" || subcommand === "delete") {
      const cartID = flags.cart || flags.cart_id || positional(rest, 1) || readState().last_core_cart_id;
      const lineID = flags.line || flags.line_id || flags.cart_line_item_id || positional(rest, 2);
      if (!cartID) throw new Error("cart_id is required");
      if (!lineID) throw new Error("cart_line_item_id is required; run buyer cart show <cart_id> --json first");
      const cart = await removeBuyerCartLineItem(cartID, lineID, flags);
      output(buyerRunOutput({
        status: "cart_updated",
        cart,
        cart_id: cart.cart_id || cart.id,
        removed_line_item_id: lineID,
        cart_guidance: cartConfirmationGuidance(cart),
        agent_next_actions: cart.agent_next_actions || ["show_cart_to_human", "confirm_cart_before_checkout"]
      }));
      return;
    }
    if (subcommand === "show" || subcommand === "status") {
      const cartID = flags.cart || flags.cart_id || positional(rest, 1) || readState().last_core_cart_id;
      if (!cartID) throw new Error("cart_id is required");
      const cart = await getBuyerCart(cartID, flags);
      output(buyerRunOutput({
        status: cart.status || "cart_ready",
        cart,
        cart_id: cart.cart_id || cart.id,
        cart_guidance: cartConfirmationGuidance(cart),
        agent_next_actions: cart.agent_next_actions || ["show_cart_to_human", "confirm_cart_before_checkout"]
      }));
      return;
    }
  }
  if (command === "shelf") {
    if (subcommand === "manifest") {
      output(await coreApi("/v1/catalog/manifests/current", { method: "GET" }, flags));
      return;
    }
    if (subcommand === "snapshot") {
      const version = flags.version || positional(rest, 1);
      if (!version) throw new Error("snapshot version is required");
      output(await coreApi(`/v1/catalog/snapshots/${encodeURIComponent(version)}`, { method: "GET" }, flags));
      return;
    }
    if (subcommand === "delta") {
      const since = flags.since || positional(rest, 1);
      if (!since) throw new Error("delta --since version is required");
      const params = new URLSearchParams({ since });
      output(await coreApi(`/v1/catalog/delta?${params.toString()}`, { method: "GET" }, flags));
      return;
    }
  }
  if (command === "checkout") {
    if (subcommand === "create") {
      const cartID = flags.cart || flags.cart_id;
      if (cartID) {
        const cart = await getBuyerCart(cartID, flags);
        const checkout = await createBuyerCheckoutFromCart(cart, null, flags);
        if (checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth") {
          await renderHumanAction(checkout.human_action, flags);
        }
        output(buyerRunOutput({
          status: "checkout_created",
          cart,
          checkout,
          buyer_session: buyerSessionClaimStatus(),
          checkout_guidance: checkoutAuthorizationGuidance(checkout),
          render_plan: checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth"
            ? buildHumanActionRenderPlan(checkout.human_action, {}, flags)
            : undefined,
          agent_next_actions: checkout.agent_next_actions || checkoutAgentNextActions(checkout),
          next: checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth"
            ? {
              command: cliCommand("buyer", "checkout", "resume", checkout.checkout_id, "--json"),
              safe_for_agent: true,
              instruction: "After presenting the first-purchase auth-to-payment QR, keep this resume command running/waiting. Do not stop at QR display unless the human explicitly asks you to pause."
            }
            : undefined
        }));
        return;
      }
      const selectionID = flags.variant || flags.catalog_variant_id || flags.item || flags.catalog_item_id;
      const selection = await resolveBuyerCatalogSelection(selectionID, flags);
      const cart = await createBuyerCart(selection, flags);
      const checkout = await createBuyerCheckoutFromCart(cart, selection, flags);
      if (checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth") {
        await renderHumanAction(checkout.human_action, flags);
      }
      output(buyerRunOutput({
        status: "checkout_created",
        selection,
        cart,
        checkout,
        buyer_session: buyerSessionClaimStatus(),
        checkout_guidance: checkoutAuthorizationGuidance(checkout),
        render_plan: checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth"
          ? buildHumanActionRenderPlan(checkout.human_action, {}, flags)
          : undefined,
        agent_next_actions: checkout.agent_next_actions || checkoutAgentNextActions(checkout),
        next: checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth"
          ? {
            command: cliCommand("buyer", "checkout", "resume", checkout.checkout_id, "--json"),
            safe_for_agent: true,
            instruction: "After presenting the first-purchase auth-to-payment QR, keep this resume command running/waiting. Do not stop at QR display unless the human explicitly asks you to pause."
          }
          : undefined
      }));
      return;
    }
    if (subcommand === "status") {
      const checkoutID = flags.checkout || flags.checkout_id || positional(rest, 1) || readState().last_core_checkout_id;
      if (!checkoutID) throw new Error("checkout_id is required");
      const checkout = await getBuyerCheckout(checkoutID, flags);
      const claimedSession = await maybeClaimBuyerSessionForCheckout(checkout, flags);
        output(buyerRunOutput({
          status: checkout.delivery_status || checkout.status,
          checkout,
          delivery: checkout.delivery,
          buyer_session: buyerSessionClaimStatus(claimedSession),
          delivery_guidance: deliveryAccessGuidance(checkout),
          agent_next_actions: deliveryAwareAgentNextActions(checkout),
          optional_agent_read_grant: optionalAgentReadGrantHint(checkout.checkout_id, checkout)
      }));
      return;
    }
    if (subcommand === "resume") {
      const checkoutID = flags.checkout || flags.checkout_id || positional(rest, 1) || readState().last_core_checkout_id;
      if (!checkoutID) throw new Error("checkout_id is required");
      let checkout = await getBuyerCheckout(checkoutID, flags);
      if (checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth") {
        await renderHumanAction(checkout.human_action, flags);
        if (flags.no_wait || flags.no_wait_auth) {
          output(buyerRunOutput({
            status: "waiting_human_auth",
            checkout,
            human_action: checkout.human_action,
            render_plan: buildHumanActionRenderPlan(checkout.human_action, {}, flags),
            agent_next_actions: checkout.agent_next_actions || ["wait_human_auth", "poll_checkout"],
            next: {
              command: cliCommand("buyer", "checkout", "resume", checkoutID, "--json"),
              safe_for_agent: true,
              instruction: "Run this resume command and keep it active; do not stop after showing the auth-to-payment QR unless the human explicitly asks you to pause."
            }
          }));
          return;
        }
        checkout = await waitBuyerCheckoutAuth(checkout, flags);
        if (checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth") {
          output(buyerRunOutput({
            status: "waiting_human_auth",
            checkout,
            human_action: checkout.human_action,
            render_plan: buildHumanActionRenderPlan(checkout.human_action, {}, flags),
            agent_next_actions: checkout.agent_next_actions || ["wait_human_auth", "poll_checkout"],
            next: {
              command: cliCommand("buyer", "checkout", "resume", checkoutID, "--json"),
              safe_for_agent: true,
              instruction: "Auth is still pending. Keep waiting/resuming the same checkout; do not create a new checkout."
            }
          }));
          return;
          }
        }
        const claimedSession = await maybeClaimBuyerSessionForCheckout(checkout, flags);
        if (checkout.payment_intent_id) {
          if (!buyerSessionReadyForPayment()) {
            output(buyerRunOutput(buyerSessionRequiredBeforePayment(checkout, flags, {
              buyer_session: buyerSessionClaimStatus(claimedSession)
            })));
            return;
          }
          let intent = await getBuyerPaymentIntent(checkout.payment_intent_id, flags);
          intent = await ensureTelegramPaymentDisplay(intent, flags);
          await renderItPayPaymentAction(intent, flags);
          output(buyerRunOutput({
            status: intent.status === "verified" ? "payment_verified" : "payment_handoff_required",
            checkout,
            payment_intent: intent,
            ...(intent.status === "verified" ? {} : paymentHandoffFields(intent, flags)),
            buyer_session: buyerSessionClaimStatus(claimedSession),
            agent_next_actions: intent.status === "verified" ? (intent.agent_next_actions || checkout.agent_next_actions || ["poll_checkout"]) : paymentHandoffAgentNextActions(),
            next: intent.status === "verified"
              ? { command: cliCommand("buyer", "checkout", "status", checkout.checkout_id, "--json"), safe_for_agent: true }
              : paymentHandoffNext()
          }));
          return;
        }
      if (checkout.agent_next_actions?.includes("create_payment_intent") || checkout.next_required_action === "create_payment_intent") {
        if (!buyerSessionReadyForPayment()) {
          output(buyerRunOutput(buyerSessionRequiredBeforePayment(checkout, flags, {
            buyer_session: buyerSessionClaimStatus(claimedSession)
          })));
          return;
        }
        const intent = await createBuyerPaymentIntent(checkout.checkout_id, flags);
        await renderItPayPaymentAction(intent, flags);
        output(buyerRunOutput({
          status: "payment_handoff_required",
          checkout,
          payment_intent: intent,
          ...paymentHandoffFields(intent, flags),
          agent_next_actions: paymentHandoffAgentNextActions(),
          next: paymentHandoffNext()
        }));
        return;
      }
      output(buyerRunOutput({
        status: checkout.delivery_status || checkout.status,
        checkout,
        delivery: checkout.delivery,
        buyer_session: buyerSessionClaimStatus(claimedSession),
        agent_next_actions: deliveryAwareAgentNextActions(checkout),
        optional_agent_read_grant: optionalAgentReadGrantHint(checkout.checkout_id, checkout)
      }));
      return;
    }
  }
  if (command === "payment" && subcommand === "wait") {
    const paymentIntentID = flags.payment_intent || flags.payment_intent_id || positional(rest, 1) || readState().last_core_payment_intent_id;
    if (!paymentIntentID) throw new Error("payment_intent_id is required");
    let intent = await getBuyerPaymentIntent(paymentIntentID, flags);
    if (intent.status !== "verified" && shouldReturnPaymentHandoffBeforeWait(flags)) {
      intent = await ensureTelegramPaymentDisplay(intent, flags);
      await renderItPayPaymentAction(intent, flags);
      const context = await optionalBuyerPaymentContext(intent, flags);
      output(buyerRunOutput({
        status: "payment_handoff_required",
        ...context,
        payment_intent: intent,
        ...paymentHandoffFields(intent, flags),
        payment_guidance: paymentRecoveryGuidance(intent, { event_type: "payment_display_required" }),
        agent_next_actions: paymentHandoffAgentNextActions(),
        next: paymentHandoffNext()
      }));
      return;
    }
    const event = intent.status === "verified"
      ? { event_type: "payment_intent.verified", payment_intent_id: paymentIntentID, agent_next_actions: intent.agent_next_actions || ["poll_checkout"] }
      : await waitBuyerPayment(intent, flags);
    output(buyerRunOutput({
      status: event.event_type === "payment_intent.verified" ? "payment_verified" : "waiting_user_payment",
      payment_intent: intent,
      payment_event: event,
      payment_guidance: paymentRecoveryGuidance(intent, event),
      agent_next_actions: event.agent_next_actions || intent.agent_next_actions || paymentAgentNextActions(intent, event),
      next: event.event_type === "payment_intent.verified"
        ? { command: intent.checkout_id ? cliCommand("buyer", "checkout", "status", intent.checkout_id, "--json") : undefined, safe_for_agent: true }
        : { command: paymentStatusCheckCommand(paymentIntentID, flags), safe_for_agent: true }
    }));
    return;
  }
  if (command === "payment" && subcommand === "refresh-qr") {
    const paymentIntentID = flags.payment_intent || flags.payment_intent_id || positional(rest, 1) || readState().last_core_payment_intent_id;
    if (!paymentIntentID) throw new Error("payment_intent_id is required");
    const refreshed = await refreshBuyerPaymentQR(paymentIntentID, flags);
    await renderItPayPaymentAction(refreshed, flags);
    const context = refreshed.status === "verified" ? {} : await optionalBuyerPaymentContext(refreshed, flags);
    output(buyerRunOutput({
      status: refreshed.status === "verified" ? "payment_verified" : "payment_handoff_required",
      ...context,
      payment_intent: refreshed,
      ...(refreshed.status === "verified" ? {} : paymentHandoffFields(refreshed, flags)),
      payment_guidance: paymentRecoveryGuidance(refreshed, { event_type: refreshed.status === "verified" ? "payment_intent.verified" : "qr_refreshed" }),
      agent_next_actions: refreshed.status === "verified" ? (refreshed.agent_next_actions || paymentAgentNextActions(refreshed, { event_type: "payment_intent.verified" })) : paymentHandoffAgentNextActions(),
      next: refreshed.status === "verified"
        ? { command: cliCommand("buyer", "checkout", "status", refreshed.checkout_id, "--json"), safe_for_agent: true }
        : paymentHandoffNext()
    }));
    return;
  }
  if (command === "deliveries") {
    if (subcommand === "list") {
      const checkoutID = flags.checkout || flags.checkout_id || readState().last_core_checkout_id;
      if (!checkoutID) throw new Error("--checkout is required");
      const checkout = await getBuyerCheckout(checkoutID, flags);
      output(buyerDeliveryListOutput(checkout));
      return;
    }
    if (subcommand === "show") {
      const checkoutID = flags.checkout || flags.checkout_id || readState().last_core_checkout_id;
      if (!checkoutID) throw new Error("--checkout is required for agent-safe delivery status");
      const checkout = await getBuyerCheckout(checkoutID, flags);
      output({
        schema_version: "itp.buyer.v1",
        status: checkout.delivery?.status || checkout.delivery_status,
        delivery_id: positional(rest, 1) || flags.delivery || flags.delivery_id || null,
        checkout_id: checkout.checkout_id,
        delivery: checkout.delivery || null,
        agent_next_actions: deliveryAwareAgentNextActions(checkout),
        optional_agent_read_grant: optionalAgentReadGrantHint(checkout.checkout_id, checkout),
        secrets: { raw_content_included: false, claim_token_included: false }
      });
      return;
    }
  }
  if (command === "refund") {
    if (subcommand === "create") {
      const orderID = flags.order || flags.order_id || positional(rest, 1);
      if (!orderID) throw new Error("order_id is required");
      const refund = await createBuyerRefund(orderID, flags);
      if (refund.status === "policy_risk_confirmation_required") {
        output(buyerRunOutput({
          ...refund,
          refund_guidance: refundGuidance({ order_id: orderID, refund, phase: "policy_risk" })
        }));
        return;
      }
      output(buyerRunOutput({
        status: refund.status || "refund_requested",
        refund,
        refund_eligibility: refund.refund_eligibility || null,
        refund_guidance: refundGuidance({ order_id: orderID, refund, phase: "created" }),
        agent_next_actions: ["watch_refund_status", "explain_refund_policy"]
      }));
      return;
    }
    if (subcommand === "list") {
      const orderID = flags.order || flags.order_id || positional(rest, 1);
      if (!orderID) throw new Error("order_id is required");
      const refunds = await listBuyerRefunds(orderID, flags);
      output(buyerRunOutput({
        status: "refunds",
        order_id: orderID,
        ...refunds,
        refund_guidance: refundGuidance({ order_id: orderID, refunds, phase: "list" }),
        agent_next_actions: ["show_refund_status"]
      }));
      return;
    }
    if (subcommand === "show") {
      const refundID = flags.refund || flags.refund_id || positional(rest, 1);
      if (!refundID) throw new Error("refund_id is required");
      const refund = await getBuyerRefund(refundID, flags);
      output(buyerRunOutput({
        status: refund.status || "refund",
        refund,
        refund_guidance: refundGuidance({ refund, phase: "show" }),
        agent_next_actions: ["show_refund_status"]
      }));
      return;
    }
    if (subcommand === "cancel") {
      const refundID = flags.refund || flags.refund_id || positional(rest, 1);
      if (!refundID) throw new Error("refund_id is required");
      const refund = await cancelBuyerRefund(refundID, flags);
      output(buyerRunOutput({
        status: refund.status || "refund_canceled",
        refund,
        refund_guidance: refundGuidance({ refund, phase: "cancel" }),
        agent_next_actions: ["show_refund_status", "claim_delivery_if_still_needed"]
      }));
      return;
    }
  }
  if (command === "vault") {
    if (subcommand === "grants") {
      const action = rest[1] && !String(rest[1]).startsWith("--") ? rest[1] : "list";
      if (action === "list") {
        const claimedSession = await ensureBuyerSessionForVaultAccess(flags);
        const grants = await listBuyerAgentReadGrants(flags);
        output(buyerRunOutput({
          status: "agent_read_grants",
          ...grants,
          buyer_session: buyerSessionClaimStatus(claimedSession),
          vault_guidance: vaultAccessGuidance(grants),
          agent_next_actions: grants.agent_readable_grants?.length ? ["read_agent_grant_view"] : ["wait_for_human_agent_read_grant"]
        }));
        return;
      }
      if (action === "read" || action === "show") {
        const grantID = flags.grant || flags.grant_id || flags.agent_read_grant_id || positional(rest, 2);
        if (!grantID) throw new Error("agent_read_grant_id is required");
        await ensureBuyerSessionForVaultAccess(flags);
        const view = await readBuyerAgentReadGrant(grantID, flags);
        output(buyerRunOutput({
          status: "agent_read_grant_view",
          grant: view,
          vault_guidance: vaultAccessGuidance({ agent_readable_grants: [view] }, view),
          agent_next_actions: ["use_human_approved_fields_only"]
        }));
        return;
      }
    }
    if (subcommand === "read") {
      await ensureBuyerSessionForVaultAccess(flags);
      const view = await readBuyerVaultArtifactGrant(flags);
      output(buyerRunOutput({
        status: "agent_read_grant_view",
        grant: view,
        vault_guidance: vaultAccessGuidance({ agent_readable_grants: [view.discovered_grant || view] }, view),
        agent_next_actions: ["use_human_approved_fields_only"]
      }));
      return;
    }
  }
  if (command === "account" && subcommand === "login-link") {
    await accountLoginLink(flags);
    return;
  }
  if (command === "auth" && subcommand === "status") {
    output(await buyerAuthStatusOutput(flags));
    return;
  }
  throw new Error(`unknown buyer command: ${[command, subcommand].filter(Boolean).join(" ") || ""}`);
}

function buyerCatalogSearchFilters(flags = {}) {
  const filters = {};
  const categories = csvValues(flags.category || flags.categories);
  if (categories.length) filters.categories = categories;

  const mappings = [
    ["service_type", "ai.itpay.service_type"],
    ["delivery_method", "ai.itpay.delivery_method"],
    ["provider", "ai.itpay.provider"],
    ["provider_product_id", "ai.itpay.provider_product_id"],
    ["provider_product", "ai.itpay.provider_product_id"],
    ["sensitivity_level", "ai.itpay.sensitivity_level"],
    ["sensitivity", "ai.itpay.sensitivity_level"],
    ["delivery_mode", "ai.itpay.delivery_mode"],
    ["settlement_group", "ai.itpay.settlement_group"]
  ];
  for (const [flagName, filterName] of mappings) {
    if (flags[flagName]) filters[filterName] = String(flags[flagName]);
  }

  const listMappings = [
    ["use_case", "ai.itpay.taxonomy.use_cases"],
    ["use_cases", "ai.itpay.taxonomy.use_cases"],
    ["input_facet", "ai.itpay.taxonomy.input_facets"],
    ["input_facets", "ai.itpay.taxonomy.input_facets"],
    ["output_facet", "ai.itpay.taxonomy.output_facets"],
    ["output_facets", "ai.itpay.taxonomy.output_facets"],
    ["required_profile_field", "ai.itpay.required_profile_fields"],
    ["required_profile_fields", "ai.itpay.required_profile_fields"],
    ["agent_runtime", "ai.itpay.agent_runtimes"],
    ["agent_runtimes", "ai.itpay.agent_runtimes"]
  ];
  for (const [flagName, filterName] of listMappings) {
    const values = csvValues(flags[flagName]);
    if (values.length) filters[filterName] = values;
  }

  const boolMappings = [
    ["payment_qr_mpm", "ai.itpay.payment.qr_mpm"],
    ["merchant_verified", "ai.itpay.merchant_verified"],
    ["requires_human_input", "ai.itpay.requires_human_input"],
    ["requires_webauthn_reveal", "ai.itpay.requires_webauthn_reveal"],
    ["agent_may_execute_query", "ai.itpay.agent_may_execute_query"],
    ["agent_may_view_raw_result", "ai.itpay.agent_may_view_raw_result"]
  ];
  for (const [flagName, filterName] of boolMappings) {
    if (flags[flagName] !== undefined) filters[filterName] = booleanFlag(flags[flagName]);
  }

  const hasMin = flags.price_min !== undefined || flags.min_price !== undefined;
  const hasMax = flags.price_max !== undefined || flags.max_price !== undefined;
  const min = hasMin ? Number(flags.price_min ?? flags.min_price) : NaN;
  const max = hasMax ? Number(flags.price_max ?? flags.max_price) : NaN;
  if (Number.isFinite(min) || Number.isFinite(max)) {
    filters.price = {};
    if (Number.isFinite(min)) filters.price.min = min;
    if (Number.isFinite(max)) filters.price.max = max;
  }
  return filters;
}

async function resolveBuyerCatalogSelection(selectionID, flags = {}) {
  if (!selectionID) throw new Error("catalog selection id is required");
  const detail = await getBuyerUCPProduct(selectionID, flags);
  return selectionFromUCPProduct(detail, selectionID, flags);
}

async function resolveBuyerCatalogSelections(selectionIDs, flags = {}) {
  const ids = selectionIDs.map((id) => String(id).trim()).filter(Boolean);
  if (!ids.length) throw new Error("at least one catalog variant id is required");
  const selections = [];
  for (const id of ids) {
    selections.push(await resolveBuyerCatalogSelection(id, flags));
  }
  return selections;
}

async function getBuyerUCPProduct(selectionID, flags = {}) {
  if (!selectionID) throw new Error("catalog selection id is required");
  const body = {
    id: String(selectionID),
    filters: {},
    context: {}
  };
  if (flags.currency) body.context.currency = String(flags.currency);
  return await coreApi("/v1/catalog/selections/resolve", { method: "POST", body }, flags);
}

function selectionFromUCPProduct(detail, selectionID, flags = {}) {
  const product = detail?.product;
  if (!product) throw new Error(`catalog selection not found: ${selectionID}`);
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const selectedVariantID = product.selected?.variant_id || selectionID;
  const variant = variants.find((candidate) => candidate.id === selectionID) ||
    variants.find((candidate) => candidate.id === selectedVariantID) ||
    variants[0];
  if (!variant) throw new Error(`catalog product has no variants: ${selectionID}`);
  const metadata = {
    ...(product.metadata || {}),
    ...(variant.metadata || {})
  };
  const requiredFields = Array.isArray(metadata["ai.itpay.required_profile_fields"])
    ? metadata["ai.itpay.required_profile_fields"].map((field) => String(field)).filter(Boolean)
    : [];
  return {
    catalog_item_id: product.id,
    catalog_variant_id: variant.id,
    ucp_variant_id: variant.id,
    offer_id: flags.offer || flags.offer_id || metadata["ai.itpay.offer_id"] || "",
    catalog_version: metadata["ai.itpay.catalog_version"] || product.selected?.catalog_version || "",
    expected_amount: Number(flags.expected_amount || variant.price?.amount || 0),
    currency: flags.currency || variant.price?.currency || metadata.currency || "",
    title: product.title,
    description: product.description || variant.description || "",
    variant_title: variant.title,
    required_contact_fields: requiredFields,
    product,
    variant,
    metadata,
    purchasable: variant.availability?.available !== false
  };
}

async function createBuyerCart(selection, flags = {}) {
  return await createBuyerCartFromSelections([selection], flags);
}

async function createBuyerCartFromSelections(selections, flags = {}) {
  if (!Array.isArray(selections) || !selections.length) throw new Error("at least one catalog selection is required");
  const quantities = buyerCartQuantities(selections.length, flags);
  const lineItems = selections.map((selection, index) => {
    if (!selection?.purchasable) throw new Error(`catalog variant is not purchasable: ${selection?.catalog_variant_id || selection?.ucp_variant_id || index}`);
    return {
      item: { id: selection.catalog_variant_id || selection.ucp_variant_id },
      quantity: quantities[index],
      input: buyerLineInputForSelection(selection, flags, index)
    };
  });
  const currencies = new Set(selections.map((selection) => String(flags.currency || selection.currency || "")).filter(Boolean));
  if (currencies.size > 1) {
    throw new Error(`selected variants have different currencies: ${Array.from(currencies).join(", ")}`);
  }
  const currency = flags.currency || selections[0]?.currency || "";
  const body = {
    line_items: lineItems,
    context: {},
    client_reference_id: flags.cart_client_reference_id || flags.client_reference_id || `cli_cart_${Date.now()}`
  };
  if (currency) body.context.currency = String(currency);
  const cart = await coreApi("/v1/carts", {
    method: "POST",
    idempotencyKey: flags.cart_idempotency_key || `idem_cli_cart_${cryptoRandom()}`,
    body
  }, flags);
  rememberBuyerCartDisplayContext(cart, selections, lineItems);
  writeState({ ...readState(), last_core_cart_id: cart.cart_id || cart.id });
  return mergeBuyerCartDisplayContext(cart);
}

function rememberBuyerCartDisplayContext(cart = {}, selections = [], lineItems = []) {
  const cartID = cart.cart_id || cart.id;
  if (!cartID) return;
  const state = readState();
  const contexts = state.cart_display_contexts && typeof state.cart_display_contexts === "object" ? state.cart_display_contexts : {};
  const entries = Object.entries({
    ...contexts,
    [cartID]: {
      line_items: lineItems.map((line, index) => compactObject({
        quantity: line.quantity,
        input: line.input,
        title: selections[index]?.title || selections[index]?.variant_title
      }))
    }
  }).slice(-20);
  writeState({ ...state, cart_display_contexts: Object.fromEntries(entries) });
}

function mergeBuyerCartDisplayContext(cart = {}) {
  if (!cart || typeof cart !== "object") return cart;
  const context = readState().cart_display_contexts?.[cart.cart_id || cart.id];
  if (!context?.line_items?.length || !Array.isArray(cart.line_items)) return cart;
  return {
    ...cart,
    line_items: cart.line_items.map((line, index) => ({
      ...line,
      input: line.input || context.line_items[index]?.input,
      item: {
        ...(line.item || {}),
        title: line.item?.title || context.line_items[index]?.title
      }
    }))
  };
}

function buyerCartSelectionIDs(rest, flags = {}) {
  const raw = flags.variants || flags.variant_ids || flags.variant || flags.catalog_variant_id || flags.item || flags.catalog_item_id || positional(rest, 1);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.flatMap((value) => splitCSV(value));
  return splitCSV(raw);
}

function buyerCartQuantities(count, flags = {}) {
  const raw = flags.quantities || flags.quantity || flags.qty;
  const values = raw === undefined || raw === null || raw === true
    ? []
    : splitCSV(raw).map((value) => Number(value));
  if (values.length && values.length !== count) {
    throw new Error(`--quantities must provide ${count} value(s), got ${values.length}`);
  }
  const quantities = values.length ? values : Array(count).fill(1);
  for (const quantity of quantities) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`cart quantity must be a positive integer, got ${quantity}`);
    }
  }
  return quantities;
}

function buyerLineInputForSelection(selection, flags = {}, index = 0) {
  const input = parseBuyerInputs(flags, index);
  const providerProductID = String(selection?.metadata?.["ai.itpay.provider_product_id"] || selection?.variant?.metadata?.["ai.itpay.provider_product_id"] || "");
  if (providerProductID === "81api_company_fuzzy_search") {
    if (!input.company_name && flags.company_name) input.company_name = String(flags.company_name).trim();
    if (!input.company_name && flags.keyword) input.company_name = String(flags.keyword).trim();
    if (!input.PageNum && flags.page_num) input.PageNum = String(flags.page_num).trim();
    if (!input.PageNum) input.PageNum = "1";
    if (!input.company_name) {
      throw new Error("企业工商数据模糊查询 requires --input company_name=<关键词> or --company-name <关键词>. Ask the user for a company keyword/short name before checkout.");
    }
  }
  if (providerProductID === "81api_company_base_info") {
    if (!input.company_name_or_credit_no && flags.company_name_or_credit_no) input.company_name_or_credit_no = String(flags.company_name_or_credit_no).trim();
    if (!input.company_name_or_credit_no && flags.company_name) input.company_name_or_credit_no = String(flags.company_name).trim();
    if (!input.isRaiseErrorCode && flags.is_raise_error_code !== undefined) input.isRaiseErrorCode = String(flags.is_raise_error_code).trim();
    if (!input.isRaiseErrorCode) input.isRaiseErrorCode = "0";
    if (!input.company_name_or_credit_no) {
      throw new Error("企业工商数据精准查询 requires --input company_name_or_credit_no=<完整企业名称或统一社会信用代码>. If the user only gave a brand/short name, run fuzzy search first or resolve the exact registered company name before checkout.");
    }
  }
  return input;
}

function parseBuyerInputs(flags = {}, index = 0) {
  const input = {};
  const rawValues = [];
  for (const key of ["input", "inputs"]) {
    const raw = flags[key];
    if (Array.isArray(raw)) rawValues.push(...raw);
    else if (raw !== undefined && raw !== true) rawValues.push(raw);
  }
  for (const raw of rawValues) {
    for (const part of splitInputParts(raw)) {
      const eq = part.indexOf("=");
      if (eq <= 0) throw new Error(`invalid --input ${part}; expected key=value`);
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key) input[key] = value;
    }
  }
  const indexed = flags[`input_${index + 1}`] || flags[`inputs_${index + 1}`];
  if (indexed && indexed !== true) {
    for (const part of splitInputParts(indexed)) {
      const eq = part.indexOf("=");
      if (eq <= 0) throw new Error(`invalid indexed input ${part}; expected key=value`);
      input[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return input;
}

function splitInputParts(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    return Object.entries(parsed).map(([key, value]) => `${key}=${value}`);
  }
  return text.split(",").map((part) => part.trim()).filter(Boolean);
}

async function getBuyerCart(cartID, flags = {}) {
  if (!cartID) throw new Error("cart_id is required");
  return mergeBuyerCartDisplayContext(await coreApi(`/v1/carts/${encodeURIComponent(cartID)}`, { method: "GET" }, flags));
}

async function addBuyerCartLineItem(cartID, selection, flags = {}) {
  if (!cartID) throw new Error("cart_id is required");
  if (!selection?.purchasable) throw new Error(`catalog variant is not purchasable: ${selection?.catalog_variant_id || selection?.ucp_variant_id || ""}`);
  const quantity = buyerCartQuantities(1, flags)[0];
  const body = {
    item: { id: selection.catalog_variant_id || selection.ucp_variant_id },
    quantity,
    input: buyerLineInputForSelection(selection, flags, 0)
  };
  const cart = await coreApi(`/v1/carts/${encodeURIComponent(cartID)}/line-items`, {
    method: "POST",
    idempotencyKey: flags.cart_idempotency_key || `idem_cli_cart_add_${cryptoRandom()}`,
    body
  }, flags);
  writeState({ ...readState(), last_core_cart_id: cart.cart_id || cart.id });
  return cart;
}

async function removeBuyerCartLineItem(cartID, lineID, flags = {}) {
  if (!cartID) throw new Error("cart_id is required");
  if (!lineID) throw new Error("cart_line_item_id is required");
  const cart = await coreApi(`/v1/carts/${encodeURIComponent(cartID)}/line-items/${encodeURIComponent(lineID)}`, {
    method: "DELETE"
  }, flags);
  writeState({ ...readState(), last_core_cart_id: cart.cart_id || cart.id });
  return cart;
}

async function createBuyerCheckoutFromCart(cart, selection = null, flags = {}) {
  const cartID = typeof cart === "string" ? cart : (cart?.cart_id || cart?.id);
  if (!cartID) throw new Error("cart_id is required");
  const deliveryContact = {};
  if (flags.email) deliveryContact.email = realBuyerEmail(flags.email);
  if (flags.phone) deliveryContact.phone = flags.phone;
  const missing = requiredDeliveryContactFields(selection).filter((field) => !deliveryContact[field]);
  if (missing.length) {
    throw new Error(`missing required delivery contact: ${missing.join(", ")}; provide ${missing.map((field) => `--${field} <value>`).join(" ")}`);
  }
  const request = {
    method: "POST",
    idempotencyKey: flags.checkout_idempotency_key || flags.idempotency_key || `idem_cli_checkout_${cartID}`,
    body: {
      cart_id: cartID,
      client_reference_id: flags.checkout_client_reference_id || flags.client_reference_id || `cli_checkout_${cartID}`,
      delivery_contact: deliveryContact
    }
  };
  let checkout;
  try {
    checkout = await coreApi("/v1/checkouts", request, flags);
  } catch (error) {
    if (error?.status === 401 && readSessionToken(readCredentials()) && !flags.access_token) {
      writeCredentials(deleteSessionCredential(readCredentials()));
      checkout = await coreApi("/v1/checkouts", request, flags);
    } else {
      throw error;
    }
  }
  writeState({ ...readState(), last_core_cart_id: cartID, last_core_checkout_id: checkout.checkout_id });
  rememberCoreAuthAction(checkout.checkout_id, checkout.human_action);
  return checkout;
}

function requiredDeliveryContactFields(selection) {
  if (Array.isArray(selection?.required_contact_fields)) {
    return selection.required_contact_fields.map((field) => String(field).trim()).filter(Boolean);
  }
  const fields = selection?.delivery?.requires_contact_fields;
  return Array.isArray(fields) ? fields.map((field) => String(field).trim()).filter(Boolean) : [];
}

function rejectBuyerSandboxFlag(flags = {}) {
  if (!flags?.sandbox) return;
  throw new Error("--sandbox is not used by buyer commands; environment is selected by the ItPay API base. Run the command without --sandbox.");
}

function realBuyerEmail(value) {
  const email = String(value || "").trim();
  if (!email) return "";
  const domain = email.split("@").pop().toLowerCase();
  if (["example.com", "example.net", "example.org"].includes(domain)) {
    throw new Error("placeholder email rejected; ask the human for their real delivery email before checkout.");
  }
  return email;
}

async function createBuyerPaymentIntent(checkoutID, flags = {}) {
  if (!checkoutID) throw new Error("checkout_id is required");
  const method = String(flags.method || flags.payment_method || "alipay").toLowerCase();
  const provider = String(flags.provider || flags.preferred_provider || method).toLowerCase();
  const intent = await coreApi(`/v1/checkouts/${encodeURIComponent(checkoutID)}/payment-intents`, {
    method: "POST",
    idempotencyKey: flags.payment_idempotency_key || flags.idempotency_key || `idem_cli_payment_${cryptoRandom()}`,
    body: {
      payment_method_type: method,
      preferred_provider: provider
    }
  }, flags);
  writeState({ ...readState(), last_core_checkout_id: checkoutID, last_core_payment_intent_id: intent.payment_intent_id });
  return intent;
}

async function waitBuyerCheckoutAuth(checkout, flags = {}) {
  const checkoutID = checkout?.checkout_id || checkout;
  if (!checkoutID) throw new Error("checkout_id is required");
  const timeoutMs = Number(flags.auth_timeout || flags.timeout || 900) * 1000;
  const started = Date.now();
  let lastHeartbeatAt = Date.now();
  let current = typeof checkout === "string" ? await getBuyerCheckout(checkoutID, flags) : checkout;
  const authAction = current?.human_action || readCoreAuthAction(checkoutID) || null;
  rememberCoreAuthAction(checkoutID, authAction);
  while (Date.now() - started < timeoutMs) {
    if (current.payment_intent_id || current.identity_status === "identity_resolved" || current.next_required_action !== "auth_qr") {
      await maybeClaimBuyerSessionFromAuthAction(authAction, flags);
      return current;
    }
    lastHeartbeatAt = writeWaitHeartbeat({
      kind: "ItPay buyer auth",
      idName: "checkout_id",
      idValue: checkoutID,
      status: current.identity_status || current.next_required_action || "waiting_human_auth",
      action: current.human_action || null,
      lastHeartbeatAt,
      flags,
      command: cliCommand("buyer", "checkout", "resume", checkoutID, "--json")
    });
    await sleep(Number(flags.auth_poll_ms || flags.poll_ms || 2000));
    current = await getBuyerCheckout(checkoutID, flags);
  }
  await maybeClaimBuyerSessionFromAuthAction(authAction, flags);
  return current;
}

async function maybeClaimBuyerSessionFromAuthAction(action, flags = {}) {
  const parsed = parseBuyerAuthActionURL(action);
  if (!parsed.authSessionID || !parsed.displayToken) return null;
  try {
    const response = await coreApi(`/v1/session-exchanges/auth-sessions/${encodeURIComponent(parsed.authSessionID)}/agent-session?display_token=${encodeURIComponent(parsed.displayToken)}`, {
      method: "POST"
    }, flags);
    const rawToken = response.raw_session_token || response.session_token || response.session?.raw_session_token;
    if (!rawToken) return response;
    writeSessionCredentials({
      account_id: response.buyer_account_id,
      device_id: response.agent_device_id,
      session_token: rawToken
    });
    writeConfig({
      api_base: coreApiBase(flags),
      account_id: response.buyer_account_id,
      device_id: response.agent_device_id
    });
    forgetCoreAuthAction(response.checkout_id);
    return response;
  } catch (error) {
    if (!flags.quiet) {
      process.stderr.write(`ItPay buyer session claim skipped: ${safeErrorMessage(error)}\n`);
    }
    return null;
  }
}

function buyerSessionClaimStatus(claimed = null) {
  const config = readConfig();
  const hasSession = Boolean(readSessionToken());
  if (!claimed && !hasSession) return undefined;
  if (!hasSession) {
    return {
      status: "buyer_session_missing",
      session_stored: false,
      buyer_account_id: claimed?.buyer_account_id || config.account_id || null,
      agent_device_id: claimed?.agent_device_id || config.device_id || null,
      token_included: false,
      agent_next_actions: ["resume_checkout_to_save_buyer_session"]
    };
  }
  return {
    status: "buyer_session_saved",
    session_stored: true,
    buyer_account_id: claimed?.buyer_account_id || config.account_id || null,
    agent_device_id: claimed?.agent_device_id || config.device_id || null,
    token_included: false,
    agent_next_actions: ["reuse_buyer_session", "list_agent_read_grants"]
  };
}

function buyerSessionReadyForPayment() {
  return Boolean(readSessionToken());
}

function checkoutAgentNextActions(checkout = {}) {
  if (checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth") {
    return ["show_auth_qr", "resume_same_checkout"];
  }
  if (checkout.payment_intent_id || checkout.agent_next_actions?.includes("create_payment_intent") || checkout.next_required_action === "create_payment_intent") {
    return buyerSessionReadyForPayment()
      ? ["continue_to_payment"]
      : ["resume_checkout_to_save_buyer_session"];
  }
  return ["resume_checkout"];
}

function checkoutAuthorizationGuidance(checkout = {}) {
  const hasSession = buyerSessionReadyForPayment();
  return {
    buyer_session_ready: hasSession,
    payment_intent_id: checkout.payment_intent_id || null,
    auth_required: checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth",
    next_step: hasSession && checkout.payment_intent_id
      ? "已有有效 buyer session 且 payment_intent_id 已就绪，可以进入付款模块。"
      : hasSession
        ? "已有有效 buyer session；继续同一个 checkout 直到 payment_intent_id 就绪。"
        : checkout.next_required_action === "auth_qr" || checkout.identity_status === "waiting_human_auth"
          ? "展示首次购买授权入口，然后继续 resume 同一个 checkout；这是授权，不是付款。"
          : "没有有效 buyer session 时不能进入付款；先 resume/status 同一个 checkout，领取并保存 buyer session。",
    do_not: [
      "不要把 auth_qr 说成付款二维码或付款证明。",
      "不要在 buyer session 未保存时展示付款 QR。",
      "不要为了修复授权状态新建 checkout。"
    ]
  };
}

function buyerSessionRequiredBeforePayment(checkout = {}, flags = {}, extra = {}) {
  return {
    status: "buyer_session_required_before_payment",
    ...extra,
    checkout,
    buyer_session: extra.buyer_session || buyerSessionClaimStatus(),
    checkout_guidance: checkoutAuthorizationGuidance(checkout),
    agent_next_actions: ["resume_checkout_to_save_buyer_session"],
    next: {
      command: cliCommand("buyer", "checkout", "resume", checkout.checkout_id || flags.checkout || flags.checkout_id || readState().last_core_checkout_id, "--json"),
      safe_for_agent: true,
      instruction: "payment_intent_id is not enough. Save or verify the buyer session before showing a payment QR."
    }
  };
}

function paymentAgentNextActions(intent = {}, event = {}) {
  if (event.event_type === "payment_intent.verified" || intent.status === "verified") {
    return ["poll_checkout_delivery"];
  }
  if (event.event_type === "wait.timeout") {
    return ["check_same_payment_intent", "resume_checkout_status_if_needed"];
  }
  if (event.event_type === "qr_refreshed") {
    return ["show_returned_qr", "check_same_payment_intent"];
  }
  return ["show_payment_qr_if_needed", "check_same_payment_intent"];
}

function paymentHandoffFields(intent = {}, flags = {}) {
  return {
    render_plan: buildHumanActionRenderPlan(intent.human_action || {}, intent, flags),
    after_human_response: paymentHandoffAfterHumanResponse(intent, flags)
  };
}

function paymentStatusCheckCommand(paymentIntentID, flags = {}) {
  if (!paymentIntentID) return "";
  return cliCommand("buyer", "payment", "wait", paymentIntentID, "--timeout", "1", ...clientCommandArgs(flags), "--json");
}

function shouldReturnPaymentHandoffBeforeWait(flags = {}) {
  if (booleanFlag(flags.wait || flags.long_wait || false)) return false;
  if (flags.timeout === undefined) return true;
  const timeout = Number(flags.timeout);
  return !Number.isFinite(timeout) || timeout > 5;
}

async function ensureTelegramPaymentDisplay(intent = {}, flags = {}) {
  if (!isTelegramBuyerHost(flags) || paymentDisplayAvailable(intent) || !intent.qr_refresh_url) return intent;
  try {
    return await refreshBuyerPaymentQR(intent.payment_intent_id, flags);
  } catch {
    return intent;
  }
}

function paymentDisplayAvailable(intent = {}) {
  const action = intent.human_action || {};
  return Boolean(
    action.url ||
    action.local_qr_path ||
    action.qr_png_url ||
    action.qr_image_url ||
    action.preferred_qr_url ||
    action.mobile_wallet_url ||
    intent.payment_url ||
    intent.payment_entry_url ||
    intent.qr_png_url ||
    intent.qr_image_url ||
    intent.mobile_wallet_url
  );
}

async function optionalBuyerPaymentContext(intent = {}, flags = {}) {
  if (!isTelegramBuyerHost(flags) || !intent.checkout_id) return {};
  try {
    const checkout = await getBuyerCheckout(intent.checkout_id, flags);
    return compactObject({
      checkout,
      cart: checkout.cart_id ? await getBuyerCart(checkout.cart_id, flags) : undefined
    });
  } catch {
    return {};
  }
}

function isTelegramBuyerHost(flags = {}) {
  return clientHost(flags) === "telegram";
}

function paymentHandoffAgentNextActions() {
  return ["send_agent_instruction_to_human"];
}

function paymentHandoffNext() {
  return {
    type: "reply_to_human",
    safe_for_agent: false,
    instruction: "Send agent_instruction to the human now. Do not run payment wait until this message is visible to the human."
  };
}

function paymentHandoffAfterHumanResponse(intent = {}, flags = {}) {
  const paymentIntentID = intent.payment_intent_id || intent.human_action?.id || "";
  return {
    check_payment_command: paymentStatusCheckCommand(paymentIntentID, flags),
    refresh_qr_command: paymentIntentID ? cliCommand("buyer", "payment", "refresh-qr", paymentIntentID, "--reason", "order-not-found", ...clientCommandArgs(flags), "--json") : "",
    safe_for_agent: true,
    instruction: "Use check_payment_command after the human says they paid or a platform button requests a status check. User text is not proof; only payment_intent.verified is."
  };
}

function paymentRecoveryGuidance(intent = {}, event = {}) {
  const paymentIntentID = intent.payment_intent_id || event.payment_intent_id || null;
  return {
    invariant: "所有付款异常都优先回到同一个 payment_intent_id / checkout_id；不要重复创建 checkout。",
    payment_intent_id: paymentIntentID,
    checkout_id: intent.checkout_id || null,
    status: intent.status || null,
    event_type: event.event_type || null,
    qr_display_order: ["local_qr_path", "qr_png_url", "preferred_qr_url", "qr_image_url_fallback", "mobile_wallet_url_as_link"],
    next_step: event.event_type === "payment_intent.verified" || intent.status === "verified"
      ? "付款已验证；进入 checkout status / 交付模块。"
      : event.event_type === "wait.timeout"
        ? "wait.timeout 不是付款失败；继续查询同一个 payment_intent_id，或用 checkout status/resume 确认状态。"
        : event.event_type === "qr_refreshed"
          ? "展示 ItPay 返回的 QR，然后继续查询同一个 payment_intent_id。"
          : "展示 ItPay 返回的付款入口；用户反馈后查询 payment_intent.verified，用户口头说已付款不算证明。",
    network_or_interrupt: "断网、无响应、进程中断时，重新运行 payment wait 或 checkout status/resume，使用同一个 payment_intent_id / checkout_id。",
    qr_problem: "QR 未显示时不要自造二维码；先用返回的 local_qr_path/qr_png_url/preferred_qr_url。扫码提示订单不存在或过期时，先等 30-60 秒重扫同一 QR，仍失败才 refresh-qr。",
    do_not: [
      "不要把用户说“已付款”当证明。",
      "不要因为 timeout、断网或没回应创建新 checkout。",
      "不要改写、缩短、重新编码或自造付款 QR。",
      "不要从买家流程调用 provider query 或 ops recovery。"
    ]
  };
}

function deliveryAccessGuidance(checkout = {}) {
  return {
    boundary: "交付是人类优先；agent 只能看到脱敏状态，不能读取 claim link、claim token 或原始内容。",
    next_step: "如果 delivery_claimable/check_email/claim_link_sent，请让用户打开邮箱或 ItPay 领取/订单页面。",
    if_user_wants_agent_to_use_result: [
      "请用户在 ItPay 页面找到 Give to Agent / 一键给 Agent。",
      "让用户选择愿意授权给 agent 读取的字段。",
      "让用户用 Passkey/WebAuthn 确认。",
      "完成后 agent 运行 buyer vault grants list --checkout <checkout_id> --json 自动发现授权；不要让用户复制链接、token 或 grant_id。"
    ],
    checkout_id: checkout.checkout_id || null,
    order_id: checkout.order_id || null,
    do_not: [
      "不要让用户把 claim link、claim token、portal text、session token、grant id 或原始交付内容贴进聊天。",
      "不要用浏览器/自动化工具代替人类打开领取页。",
      "不要猜交付内容；读不到就解释原因并继续同一个 checkout/grant 流程。"
    ]
  };
}

function vaultAccessGuidance(grants = {}, view = null) {
  const list = Array.isArray(grants.agent_readable_grants) ? grants.agent_readable_grants : [];
  const expiresAt = view?.expires_at || view?.grant?.expires_at || view?.valid_until || view?.grant?.valid_until || null;
  const selectedFields = view?.selected_fields || view?.grant?.selected_fields || view?.structured_view || view?.grant?.structured_view || null;
  if (!view && !list.length) {
    return {
      status: "no_agent_read_grant_found",
      likely_reasons: [
        "用户还没有点击 Give to Agent / 一键给 Agent。",
        "用户选错了订单或领取页。",
        "授权还没同步，等几秒后用同一个 checkout 再查。",
        "checkout/order/artifact 不匹配。",
        "buyer session 过期，需要先运行 buyer checkout status <checkout_id> --json。",
        "授权已过期或被撤销。"
      ],
      next_step: "指导用户在 ItPay 领取/订单页面选择字段并用 Passkey 确认，然后重新运行 grants list；不要让用户复制 grant_id 或 token。"
    };
  }
  return {
    status: "agent_read_grant_available",
    readable_scope: "只能使用本次返回的已授权字段；未返回字段不可读取、不可推断。",
    selected_fields_present: Boolean(selectedFields),
    expires_at: expiresAt,
    expires_at_note: expiresAt ? "把授权有效期告诉用户；过期后需要重新授权。" : "返回里没有明确过期时间；不要编造有效期。",
    if_fields_insufficient: "如果当前字段不足以完成任务，请用户回到 ItPay 页面重新 Give to Agent，增加需要的字段后确认。",
    do_not: [
      "不要要求用户复制原文、claim link、session token、grant id 或 Passkey/WebAuthn token。",
      "不要声称能看到未授权字段。",
      "不要把授权字段长期保存到本地，除非用户明确要求创建本地产物。"
    ]
  };
}

function refundGuidance({ order_id: orderID = null, refund = null, refunds = null, phase = "" } = {}) {
  const refundID = refund?.refund_id || refund?.refund?.refund_id || null;
  return {
    boundary: "退款支线必须基于已确认 order_id；不要猜订单、金额或退款范围。",
    order_id: orderID || refund?.order_id || refund?.refund?.order_id || null,
    refund_id: refundID,
    amount_rule: "金额必须使用 --amount-minor；CNY 1000 表示 CNY 10.00。不要使用 --amount。",
    scope_rule: "当前 buyer refund 走整单退款思路；不要发明 line-item refund scope。",
    next_step: phase === "policy_risk"
      ? "先解释 refund_eligibility.policy / agent_guidance，并等待用户明确确认；只有确认后才用 --confirm-policy-risk true 重试。"
      : phase === "created"
        ? "退款请求已提交；用 refund list/show 查看状态，不要重复提交。"
        : phase === "cancel"
          ? "取消后用 refund show/list 确认状态；交付是否重新可领取以服务端返回为准。"
          : "向用户展示退款状态；如需取消，先确认是否仍在供应商/资金动作前。",
    cancel_rule: "只有供应商或资金动作前才适合取消；如果已进入资金/供应商动作，不能保证取消。",
    session_rule: "退款需要 buyer session，不是 vault grant。session 过期时先运行 status --refresh 或 checkout status 恢复。",
    do_not: [
      "不要猜 order_id；没有 order_id 先查 checkout status。",
      "不要把 CNY minor units 当成人民币元。",
      "不要自动越过 policy_risk_confirmation_required。",
      "不要因为没立刻成功就重复提交退款。",
      "不要用 vault grant 代替 buyer session。"
    ],
    refunds_count: Array.isArray(refunds?.refunds) ? refunds.refunds.length : undefined
  };
}

async function maybeClaimBuyerSessionForCheckout(checkout, flags = {}) {
  if (!checkout?.checkout_id) return null;
  if (readSessionToken()) return null;
  if (checkout.identity_status !== "identity_resolved" && !checkout.payment_intent_id) return null;
  const action = checkout.human_action || readCoreAuthAction(checkout.checkout_id);
  return await maybeClaimBuyerSessionFromAuthAction(action, flags);
}

async function ensureBuyerSessionForVaultAccess(flags = {}) {
  if (readSessionToken()) return null;
  const checkoutID =
    flags.checkout ||
    flags.checkout_id ||
    readState().last_core_checkout_id ||
    readState().last_core_auth_checkout_id;
  if (checkoutID) {
    try {
      const checkout = await getBuyerCheckout(checkoutID, flags);
      rememberCoreAuthAction(checkout.checkout_id || checkoutID, checkout.human_action);
      const claimed = await maybeClaimBuyerSessionForCheckout(checkout, { ...flags, quiet: true });
      if (claimed || readSessionToken()) return claimed;
    } catch {
      // Continue with the locally remembered auth action below.
    }
    const action = readCoreAuthAction(checkoutID);
    const claimed = await maybeClaimBuyerSessionFromAuthAction(action, { ...flags, quiet: true });
    if (claimed || readSessionToken()) return claimed;
  }
  const state = readState();
  const entries = Object.entries(state.core_auth_actions || {});
  for (const [, action] of entries.reverse()) {
    const claimed = await maybeClaimBuyerSessionFromAuthAction(action, { ...flags, quiet: true });
    if (claimed || readSessionToken()) return claimed;
  }
  return null;
}

function parseBuyerAuthActionURL(action) {
  if (!action || typeof action !== "object") return {};
  let authSessionID = String(action.auth_session_id || "").trim();
  if (!authSessionID && String(action.id || "").startsWith("auth_")) {
    authSessionID = String(action.id).trim();
  }
  let displayToken = "";
  let sourceURL = "";
  for (const rawURL of buyerAuthActionCandidateURLs(action)) {
    try {
      const parsed = new URL(rawURL);
      const token = parsed.searchParams.get("display_token") || "";
      if (token && !displayToken) displayToken = token;
      const match = parsed.pathname.match(/(?:^|\/)v1\/session-exchanges\/auth-sessions\/([^/?#]+)(?:\/|$)/);
      if (match && !authSessionID) authSessionID = decodeURIComponent(match[1]);
      if (!sourceURL && (match || token)) sourceURL = rawURL;
      if (authSessionID && displayToken) break;
    } catch {
      // Ignore non-URL display entries.
    }
  }
  return { authSessionID, displayToken, sourceURL };
}

function buyerAuthActionCandidateURLs(action) {
  const urls = [];
  for (const key of ["url", "web_url", "auth_url", "oauth_start_url", "mobile_wallet_url"]) {
    if (action?.[key]) urls.push(String(action[key]));
  }
  const presentationDisplay = action?.presentation?.display;
  if (Array.isArray(presentationDisplay)) {
    for (const entry of presentationDisplay) {
      if (entry?.url) urls.push(String(entry.url));
    }
  }
  if (Array.isArray(action?.display)) {
    for (const entry of action.display) {
      if (entry?.url) urls.push(String(entry.url));
    }
  }
  return urls;
}

function rememberCoreAuthAction(checkoutID, action) {
  if (!checkoutID || action?.kind !== "auth_qr") return;
  const parsed = parseBuyerAuthActionURL(action);
  if (!parsed.authSessionID || !parsed.displayToken) return;
  const state = readState();
  const existing = state.core_auth_actions && typeof state.core_auth_actions === "object" ? state.core_auth_actions : {};
  const entries = Object.entries(existing).slice(-19);
  const next = Object.fromEntries(entries);
  next[checkoutID] = {
    kind: "auth_qr",
    id: action.id || action.auth_session_id || parsed.authSessionID,
    auth_session_id: parsed.authSessionID,
    url: action.url || parsed.sourceURL,
    web_url: action.web_url || action.url || parsed.sourceURL,
    expires_at: action.expires_at || null,
    saved_at: new Date().toISOString()
  };
  writeState({ ...state, core_auth_actions: next, last_core_auth_checkout_id: checkoutID });
}

function readCoreAuthAction(checkoutID) {
  if (!checkoutID) return null;
  const state = readState();
  return state.core_auth_actions?.[checkoutID] || null;
}

function forgetCoreAuthAction(checkoutID) {
  if (!checkoutID) return;
  const state = readState();
  if (!state.core_auth_actions?.[checkoutID]) return;
  const next = { ...state.core_auth_actions };
  delete next[checkoutID];
  writeState({ ...state, core_auth_actions: next });
}

async function getBuyerCheckout(checkoutID, flags = {}) {
  return await coreApi(`/v1/checkouts/${encodeURIComponent(checkoutID)}`, { method: "GET" }, flags);
}

async function createBuyerRefund(orderID, flags = {}) {
  if (flags.amount !== undefined) {
    throw new Error("use --amount-minor for refund amount");
  }
  if (flags.refund_scope && flags.refund_scope !== "order") {
    throw new Error("unsupported_refund_scope");
  }
  const order = await getBuyerOrderDetail(orderID, flags);
  const eligibility = order.refund_eligibility || order.order_detail?.refund_eligibility || null;
  if (eligibility && eligibility.likely_refundable === false && !booleanFlag(flags.confirm_policy_risk || false)) {
    return {
      status: "policy_risk_confirmation_required",
      order_id: orderID,
      refund_eligibility: eligibility,
      agent_next_actions: [
        "explain_refund_policy",
        "ask_human_to_confirm_policy_risk",
        `retry_with_${cliCommand("buyer", "refund", "create", orderID, "--confirm-policy-risk", "true", "--json")}`
      ],
      submitted: false
    };
  }
  return await coreApi(`/v1/me/orders/${encodeURIComponent(orderID)}/refunds`, {
    method: "POST",
    headers: { "X-ItPay-Client-Surface": "cli" },
    idempotencyKey: flags.idempotency_key || `idem_cli_refund_create_${orderID}`,
    body: {
      refund_scope: flags.refund_scope || "order",
      order_line_item_ids: csvValues(flags.order_line_item_ids || flags.line_ids || flags.line_id),
      amount_minor: intFlag(flags.amount_minor, "amount_minor"),
      currency: flags.currency || "CNY",
      reason_code: flags.reason || flags.reason_code || "buyer_requested",
      reason_note: flags.note || flags.reason_note || ""
    }
  }, flags);
}

async function getBuyerOrderDetail(orderID, flags = {}) {
  return await coreApi(`/v1/me/orders/${encodeURIComponent(orderID)}`, { method: "GET" }, flags);
}

async function listBuyerRefunds(orderID, flags = {}) {
  return await coreApi(`/v1/me/orders/${encodeURIComponent(orderID)}/refunds`, { method: "GET" }, flags);
}

async function getBuyerRefund(refundID, flags = {}) {
  return await coreApi(`/v1/me/refunds/${encodeURIComponent(refundID)}`, { method: "GET" }, flags);
}

async function cancelBuyerRefund(refundID, flags = {}) {
  return await coreApi(`/v1/me/refunds/${encodeURIComponent(refundID)}/cancel`, {
    method: "POST",
    headers: { "X-ItPay-Client-Surface": "cli" },
    idempotencyKey: flags.idempotency_key || `idem_cli_refund_cancel_${refundID}`,
    body: {
      reason_code: flags.reason || flags.reason_code || "buyer_changed_mind",
      reason_note: flags.note || flags.reason_note || ""
    }
  }, flags);
}

async function getBuyerPaymentIntent(paymentIntentID, flags = {}) {
  return await coreApi(`/v1/payment-intents/${encodeURIComponent(paymentIntentID)}`, { method: "GET" }, flags);
}

async function refreshBuyerPaymentQR(paymentIntentID, flags = {}) {
  const intent = await getBuyerPaymentIntent(paymentIntentID, flags);
  if (intent.status === "verified") return intent;
  const refreshURL = intent.qr_refresh_url;
  if (!refreshURL) {
    throw new Error("payment intent does not expose qr_refresh_url; refresh is supported only for refreshable provider QR intents");
  }
  return await coreApi(refreshURL, {
    method: "POST",
    body: {
      reason: normalizeQRRefreshReasonForCLI(flags.reason || flags.refresh_reason || "order_not_found")
    }
  }, flags);
}

function normalizeQRRefreshReasonForCLI(reason) {
  const normalized = String(reason || "").trim().toLowerCase().replaceAll("-", "_");
  if (["order_not_found", "qr_unavailable", "manual_refresh", "human_open"].includes(normalized)) return normalized;
  return "manual_refresh";
}

async function waitBuyerPayment(intent, flags = {}) {
  const paymentIntentID = intent?.payment_intent_id || intent;
  if (!paymentIntentID) throw new Error("payment_intent_id is required");
  let cursor = flags.cursor || intent?.agent_wait?.cursor || "";
  const waitURL = flags.wait_url || intent?.agent_wait?.wait_url || `/v1/payment-intents/${encodeURIComponent(paymentIntentID)}/events/wait`;
  const timeoutMs = Number(flags.timeout || 900) * 1000;
  const started = Date.now();
  let lastHeartbeatAt = Date.now();
  let lastEvent = null;
  while (Date.now() - started < timeoutMs) {
    const remainingMs = Math.max(1000, timeoutMs - (Date.now() - started));
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    params.set("timeout", String(flags.poll_timeout || `${Math.ceil(Math.min(30000, remainingMs) / 1000)}s`));
    const event = await coreApi(appendURLQuery(waitURL, params), { method: "GET" }, flags);
    lastEvent = event;
    cursor = event.cursor || cursor;
    if (event.event_type === "payment_intent.verified") return event;
    if (event.event_type && event.event_type !== "wait.timeout") return event;
    lastHeartbeatAt = writeWaitHeartbeat({
      kind: "ItPay payment notify",
      idName: "payment_intent_id",
      idValue: paymentIntentID,
      status: event.event_type === "wait.timeout" ? "still_waiting" : (event.event_type || "still_waiting"),
      action: intent?.human_action || null,
      lastHeartbeatAt,
      flags,
      command: paymentStatusCheckCommand(paymentIntentID)
    });
  }
  return lastEvent || { event_type: "wait.timeout", payment_intent_id: paymentIntentID, cursor, agent_next_actions: ["check_payment_status"] };
}

async function waitBuyerDelivery(checkoutID, flags = {}) {
  const timeoutMs = Number(flags.delivery_timeout || 30) * 1000;
  const started = Date.now();
  let checkout = await getBuyerCheckout(checkoutID, flags);
  while (!isBuyerDeliveryComplete({ checkout }) && Date.now() - started < timeoutMs) {
    await sleep(Number(flags.delivery_poll_ms || 2000));
    checkout = await getBuyerCheckout(checkoutID, flags);
  }
  return { checkout, delivery: checkout.delivery || null };
}

function isBuyerDeliveryComplete(result) {
  const checkout = result?.checkout || result || {};
  const delivery = checkout.delivery || result?.delivery || {};
  return checkout.delivery_status === "delivered" ||
    delivery.status === "delivery_claimable" ||
    delivery.next_required_action === "check_email" ||
    checkout.agent_next_actions?.includes("stop_check_email");
}

function buyerRunOutput(value = {}, flags = {}) {
  const body = compactBuyerOutput(value, flags);
  return normalizeBuyerMoneyFields(stripInternalBuyerFields({
    schema_version: "itp.buyer.v1",
    ...body,
    docs: value.docs || buyerDocsFor(value),
    secrets: {
      raw_content_included: false,
      claim_token_included: false,
      provider_raw_payload_included: false
    }
  }));
}

function compactBuyerOutput(value = {}, flags = {}) {
  const clientInstruction = clientBuyerInstruction(value, flags);
  if (clientInstruction) return clientInstruction;
  const result = {};
  if (value.status !== undefined) result.status = value.status;
  for (const [key, item] of Object.entries(value)) {
    if (["docs", "status"].includes(key)) continue;
    result[key] = compactBuyerField(key, item);
  }
  return result;
}

function clientBuyerInstruction(value = {}, flags = {}) {
  const plan = value.render_plan || {};
  const selected = plan.selected || {};
  if (!plan.kind || !selected.platform) return null;
  if (selected.platform === "telegram" && selected.openclaw_message) return telegramBuyerInstruction(value, flags);
  if ((selected.platform === "codex_app" || selected.platform === "claude_code") && selected.markdown) {
    return markdownBuyerInstruction(value, flags, selected.platform, selected.markdown);
  }
  if (selected.platform === "plain_chat") return plainChatBuyerInstruction(value, flags, selected);
  if (selected.platform === "terminal") return terminalBuyerInstruction(value, flags);
  return null;
}

function telegramBuyerInstruction(value = {}, flags = {}) {
  const plan = value.render_plan || {};
  const selected = plan.selected || {};
  if (selected.platform !== "telegram" || !selected.openclaw_message) return null;
  const summary = buyerOrderSummary(value, plan.kind);
  const rawMessage = selected.openclaw_message;
  const presentation = telegramBuyerPresentation(plan.kind, rawMessage);
  const media = rawMessage.command_args?.media || rawMessage.media || selected.media?.[0]?.local_path || selected.media?.[0]?.fallback_url || "";
  const hasHumanEntry = Boolean(media || presentation.blocks?.some((block) => block.type === "buttons" && block.buttons?.some((button) => button.url)));
  const text = telegramBuyerInstructionText(plan.kind, summary, hasHumanEntry);
  const callbacks = rawMessage.callbacks || {};
  const commandArgs = compactObject({
    channel: "telegram",
    target: clientTarget(flags) || undefined,
    message: text,
    media: media || undefined,
    presentation
  });
  const action = telegramAgentAction(commandArgs);
  const instruction = "必须先执行顶层 agent_action.command 或 agent_action.argv，把二维码、说明和 Telegram 原生按钮发给用户。不要手写 Markdown 表格，不要只贴链接，不要先运行 wait/status；如果不能执行 openclaw message send，就停止并说明工具缺失。";
  return compactObject({
    status: value.status,
    instruction,
    must_send_to_human_before_next_command: true,
    must_execute_agent_action_before_reply: true,
    order_summary: summary,
    agent_action: action,
    agent_instruction: {
      type: plan.kind === "auth_qr" ? "send_telegram_auth_handoff" : "send_telegram_payment_handoff",
      platform: "telegram",
      proof_rule: plan.proof_rule,
      instruction,
      openclaw_message: {
        command: "openclaw message send",
        command_args: commandArgs,
        telegram_rule: "Telegram 原生按钮必须通过 openclaw message send --presentation 发送；presentation.blocks[].type=\"buttons\" 才会生成 Inline Keyboard。",
        callbacks
      }
    },
    after_human_response: telegramAfterHumanResponse(value, callbacks),
    agent_next_actions: ["execute_agent_action"],
    next: {
      type: "reply_to_human",
      safe_for_agent: false,
      instruction: "先执行 agent_action.command/argv；用户点击按钮或回复后，再运行 after_human_response 里的命令。"
    }
  });
}

function telegramAgentAction(commandArgs = {}) {
  const argv = ["openclaw", "message", "send"];
  if (commandArgs.channel) argv.push("--channel", commandArgs.channel);
  if (commandArgs.target) argv.push("--target", commandArgs.target);
  if (commandArgs.message) argv.push("--message", commandArgs.message);
  if (commandArgs.media) argv.push("--media", commandArgs.media);
  if (commandArgs.presentation) argv.push("--presentation", JSON.stringify(commandArgs.presentation));
  return {
    type: "openclaw_message_send",
    tool: "shell",
    instruction: "现在立刻执行这个 shell 命令发送 Telegram 原生消息；不要改写为普通聊天回复。执行成功后再简短告诉用户已发出。",
    command: argv.map((item) => shellQuote(String(item))).join(" "),
    argv,
    if_unavailable: "如果当前 agent 不能执行 openclaw message send，停止并告诉用户：当前 agent 缺少 Telegram 原生按钮发送工具；不要降级成 Markdown 表格或普通链接。"
  };
}

function markdownBuyerInstruction(value = {}, flags = {}, platform = "codex_app", markdown = "") {
  const plan = value.render_plan || {};
  const summary = buyerOrderSummary(value, plan.kind);
  const instruction = markdownBuyerInstructionText(platform);
  return handoffInstructionOutput(value, flags, {
    type: plan.kind === "auth_qr" ? "send_markdown_auth_handoff" : "send_markdown_payment_handoff",
    platform,
    proof_rule: plan.proof_rule,
    instruction,
    markdown
  }, summary, {
    instruction,
    agent_action: markdownAgentAction(platform, markdown),
    after_visible_action: afterVisibleAction(value, flags, summary),
    agent_next_actions: ["send_agent_action_to_human"]
  });
}

function plainChatBuyerInstruction(value = {}, flags = {}, selected = {}) {
  const plan = value.render_plan || {};
  const summary = buyerOrderSummary(value, plan.kind);
  return handoffInstructionOutput(value, flags, {
    type: plan.kind === "auth_qr" ? "send_plain_auth_handoff" : "send_plain_payment_handoff",
    platform: "plain_chat",
    proof_rule: plan.proof_rule,
    instruction: "把 message 和 links 发给用户后停下，等用户回复再查状态。",
    message: selected.text,
    links: selected.links || []
  }, summary);
}

function terminalBuyerInstruction(value = {}, flags = {}) {
  const plan = value.render_plan || {};
  const summary = buyerOrderSummary(value, plan.kind);
  const instruction = "必须先执行 agent_action.command，让 CLI 在人类正在看的终端里打印二维码、链接和摘要；不要把 terminal 当成 Codex 桌面端。如果人类不是直接看这个终端，改用 --host codex 重跑。";
  return handoffInstructionOutput(value, flags, {
    type: plan.kind === "auth_qr" ? "terminal_auth_handoff" : "terminal_payment_handoff",
    platform: "terminal",
    proof_rule: plan.proof_rule,
    instruction,
    print_terminal_qr: true
  }, summary, {
    instruction,
    agent_action: terminalAgentAction(summary, flags, plan.kind),
    after_visible_action: afterVisibleAction(value, flags, summary),
    agent_next_actions: ["execute_agent_action"]
  });
}

function handoffInstructionOutput(value = {}, flags = {}, agentInstruction = {}, summary = {}, extra = {}) {
  return compactObject({
    status: value.status,
    instruction: extra.instruction,
    must_send_to_human_before_next_command: true,
    order_summary: summary,
    agent_action: extra.agent_action,
    agent_instruction: agentInstruction,
    after_human_response: genericAfterHumanResponse(value, flags, summary),
    after_visible_action: extra.after_visible_action,
    agent_next_actions: extra.agent_next_actions || ["send_agent_instruction_to_human"],
    next: {
      type: "reply_to_human",
      safe_for_agent: false,
      instruction: extra.next_instruction || "先把 agent_instruction 发送给用户；用户点击按钮或回复后，再运行 after_human_response 里的命令。"
    }
  });
}

function markdownBuyerInstructionText(platform = "codex_app") {
  const label = platform === "claude_code" ? "Claude Code app" : "Codex desktop app";
  return `你在 ${label}。必须先把顶层 agent_action.markdown 原样发到当前聊天，让人类真正看到二维码、订单摘要和链接；不要因为你用 shell 跑 itp 就改用 --host terminal。发出后，如果你能确认消息已经对人类可见，可以继续执行 after_visible_action.command 等 30 秒；如果不能确认，就停止等人类回复。`;
}

function markdownAgentAction(platform = "codex_app", markdown = "") {
  const label = platform === "claude_code" ? "Claude Code app" : "Codex desktop app";
  return {
    type: "markdown_reply",
    platform,
    instruction: `现在立刻把 markdown 原样发送到当前聊天。${label} 可以用绝对路径 Markdown 图片显示本地二维码。不要只贴文件路径，不要先运行 wait/status。`,
    markdown,
    if_unavailable: "如果当前客户端不能让这段 Markdown 对人类可见，停止并说明无法展示二维码；不要先运行 wait/status。"
  };
}

function terminalAgentAction(summary = {}, flags = {}, kind = "") {
  const args = kind === "auth_qr" && summary.checkout_id
    ? ["buyer", "checkout", "resume", summary.checkout_id, ...clientCommandArgs(flags), "--no-wait-auth"]
    : summary.payment_intent_id
      ? ["buyer", "payment", "wait", summary.payment_intent_id, ...clientCommandArgs(flags)]
      : [];
  if (!args.length) return undefined;
  return {
    type: "terminal_handoff_command",
    tool: "shell",
    instruction: "只有当人类直接看这个终端窗口时才执行。它会让 CLI 打印二维码和链接。若你在 Codex 桌面聊天里，请改用 --host codex 重跑原命令。",
    command: cliCommand(...args),
    if_unavailable: "如果不能确认人类正在看该终端，停止并用正确的 --host 重跑；不要把终端输出当成 Codex 桌面端回复。"
  };
}

function afterVisibleAction(value = {}, flags = {}, summary = {}) {
  if (summary.payment_intent_id) {
    return {
      optional: true,
      command: cliCommand("buyer", "payment", "wait", summary.payment_intent_id, "--timeout", "30", ...clientCommandArgs(flags), "--json"),
      instruction: "只有在二维码、订单摘要和链接已经对人类可见后才能执行。用户说已付款不算证明，只有 payment_intent.verified 算付款成功。"
    };
  }
  if (summary.checkout_id) {
    return {
      optional: true,
      command: cliCommand("buyer", "checkout", "resume", summary.checkout_id, ...clientCommandArgs(flags), "--json"),
      instruction: "只有在授权入口已经对人类可见后才能执行；继续同一个 checkout，不要新建 checkout。"
    };
  }
  return undefined;
}

function buyerOrderSummary(value = {}, kind = "") {
  const cart = value.cart || {};
  const checkout = value.checkout || {};
  const intent = value.payment_intent || {};
  const context = checkout.cart_id ? readState().cart_display_contexts?.[checkout.cart_id] : null;
  const line = cart.line_items?.[0] || context?.line_items?.[0] || {};
  const title = value.selection?.title || line.item?.title || line.title || "ItPay 服务";
  const quantity = line.quantity || 1;
  const amount = intent.amount ?? checkout.amount ?? cart.amount ?? value.selection?.expected_amount ?? value.selection?.amount;
  const currency = intent.currency || checkout.currency || cart.currency || value.selection?.currency || "";
  return compactObject({
    kind,
    title,
    quantity,
    input_summary: buyerInputSummary(line.input),
    amount_display: buyerHumanAmount(amount, currency),
    order_id: checkout.order_id || intent.order_id,
    checkout_id: checkout.checkout_id || intent.checkout_id,
    payment_intent_id: intent.payment_intent_id,
    status: intent.status || checkout.status || value.status
  });
}

function buyerInputSummary(input = {}) {
  if (!input || typeof input !== "object") return "";
  return input.company_name || input.company_name_or_credit_no || Object.values(input).find((value) => value && value !== "1" && value !== "0") || "";
}

function buyerHumanAmount(amount, currency = "") {
  if (!Number.isFinite(Number(amount))) return "";
  if (String(currency).toUpperCase() === "CNY") return `¥${(Number(amount) / 100).toFixed(2)}`;
  return `${String(currency).toUpperCase()} ${(Number(amount) / 100).toFixed(2)}`.trim();
}

function telegramBuyerInstructionText(kind, summary = {}, hasHumanEntry = true) {
  const amount = summary.amount_display ? `，金额 ${summary.amount_display}` : "";
  if (!hasHumanEntry) {
    return [
      `购物车和结算已创建，但当前付款入口需要刷新${amount}。`,
      "请点“支付遇到问题 / 刷新”，或运行 after_human_response.refresh_qr_command 后重新发送付款入口。",
      "",
      `摘要：${telegramOrderSummaryText(summary)}`
    ].join("\n");
  }
  const action = kind === "auth_qr" ? "完成首次授权/付款" : "完成付款";
  const open = kind === "auth_qr" ? "打开授权" : "打开付款页面";
  const done = kind === "auth_qr" ? "我已完成，查询状态" : "我已付款，查询状态";
  return [
    `购物车和结算已创建。现在需要你${action}${amount}。`,
    `可扫二维码，或点“${open}”进入页面。`,
    `完成后点“${done}”，我会继续查支付和交付状态。`,
    "",
    `摘要：${telegramOrderSummaryText(summary)}`
  ].join("\n");
}

function telegramOrderSummaryText(summary = {}) {
  const input = summary.input_summary ? `，关键词「${summary.input_summary}」` : "";
  const amount = summary.amount_display ? `，${summary.amount_display}` : "";
  return `${summary.title} × ${summary.quantity || 1} 次${input}${amount}。`;
}

function telegramBuyerPresentation(kind, rawMessage = {}) {
  const rawBlocks = rawMessage.command_args?.presentation?.blocks || rawMessage.presentation?.blocks || [];
  const buttons = rawBlocks.find((block) => block.type === "buttons")?.buttons || [];
  return {
    blocks: [{
      type: "buttons",
      buttons: buttons.map((button) => telegramBuyerButton(kind, button)).filter(Boolean)
    }]
  };
}

function telegramBuyerButton(kind, button = {}) {
  if (button.url) {
    if (kind === "auth_qr") return { text: "🔓 打开授权", url: button.url };
    if (button.text === "手机钱包打开") return { text: "📱 手机钱包打开", url: button.url };
    return { text: "💳 打开付款页面", url: button.url };
  }
  if (button.callback_data?.includes("refresh_payment_qr")) return { text: "🔄 支付遇到问题 / 刷新", callback_data: button.callback_data };
  if (button.callback_data?.includes("check_payment_status")) return { text: "✅ 我已付款，查询状态", callback_data: button.callback_data };
  if (button.callback_data?.includes("check_checkout_status")) return { text: "✅ 我已完成，查询状态", callback_data: button.callback_data };
  return button.text && button.callback_data ? { text: button.text, callback_data: button.callback_data } : null;
}

function telegramAfterHumanResponse(value = {}, callbacks = {}) {
  return compactObject({
    check_status_command: callbacks.check_payment_status || callbacks.check_checkout_status || value.after_human_response?.check_payment_command,
    refresh_qr_command: callbacks.refresh_payment_qr || value.after_human_response?.refresh_qr_command,
    help_command: cliCommand("docs", "show", "payment-qr", "--role", "buyer", "--json"),
    instruction: "用户点击查询按钮或回复已完成后，运行 check_status_command。用户口头说已付款不是证明。"
  });
}

function genericAfterHumanResponse(value = {}, flags = {}, summary = {}) {
  const paymentIntentID = summary.payment_intent_id;
  const checkoutID = summary.checkout_id;
  return compactObject({
    check_status_command: value.after_human_response?.check_payment_command ||
      (paymentIntentID ? paymentStatusCheckCommand(paymentIntentID, flags) : undefined) ||
      (checkoutID ? cliCommand("buyer", "checkout", "resume", checkoutID, ...clientCommandArgs(flags), "--json") : undefined),
    refresh_qr_command: value.after_human_response?.refresh_qr_command,
    help_command: cliCommand("docs", "show", "payment-qr", "--role", "buyer", "--json"),
    instruction: "用户点击查询按钮或回复已完成后，运行 check_status_command。用户口头说已付款不是证明。"
  });
}

function compactBuyerField(key, value) {
  if (key === "selection") return compactSelection(value);
  if (key === "selections") return Array.isArray(value) ? value.map(compactSelection) : value;
  if (key === "product") return compactProduct(value);
  if (key === "products") return Array.isArray(value) ? value.map(compactProduct) : value;
  if (key === "cart") return compactCart(value);
  if (key === "checkout") return compactCheckout(value);
  if (key === "payment_intent") return compactPaymentIntent(value);
  return value;
}

function compactSelection(selection = {}) {
  if (!selection || typeof selection !== "object") return selection;
  return compactObject({
    catalog_item_id: selection.catalog_item_id,
    catalog_variant_id: selection.catalog_variant_id,
    ucp_variant_id: selection.ucp_variant_id,
    offer_id: selection.offer_id,
    title: selection.title,
    variant_title: selection.variant_title,
    amount: selection.expected_amount,
    currency: selection.currency,
    required_contact_fields: selection.required_contact_fields,
    purchasable: selection.purchasable
  });
}

function compactProduct(product = {}) {
  if (!product || typeof product !== "object") return product;
  return compactObject({
    id: product.id,
    title: product.title,
    description: product.description,
    selected: product.selected,
    variants: Array.isArray(product.variants) ? product.variants.map(compactVariant) : undefined
  });
}

function compactVariant(variant = {}) {
  const metadata = variant.metadata || {};
  return compactObject({
    id: variant.id,
    title: variant.title,
    description: variant.description,
    price: variant.price,
    availability: variant.availability,
    required_profile_fields: metadata["ai.itpay.required_profile_fields"],
    input_schema_json: metadata["ai.itpay.api.input_schema_json"],
    agent_explanation_zh: metadata["ai.itpay.agent_explanation_zh"]
  });
}

function compactCart(cart = {}) {
  if (!cart || typeof cart !== "object") return cart;
  return compactObject({
    cart_id: cart.cart_id || cart.id,
    status: cart.status,
    amount: cart.amount,
    currency: cart.currency,
    line_items: Array.isArray(cart.line_items) ? cart.line_items.map(compactCartLine) : undefined
  });
}

function compactCartLine(line = {}) {
  return compactObject({
    id: line.id,
    quantity: line.quantity,
    amount: line.amount,
    currency: line.currency,
    input: line.input,
    item: line.item ? compactObject({
      id: line.item.id,
      title: line.item.title,
      catalog_item_id: line.item.catalog_item_id,
      catalog_variant_id: line.item.catalog_variant_id,
      offer_id: line.item.offer_id
    }) : undefined
  });
}

function compactCheckout(checkout = {}) {
  if (!checkout || typeof checkout !== "object") return checkout;
  return compactObject({
    checkout_id: checkout.checkout_id,
    cart_id: checkout.cart_id,
    order_id: checkout.order_id,
    status: checkout.status,
    delivery_status: checkout.delivery_status,
    identity_status: checkout.identity_status,
    next_required_action: checkout.next_required_action,
    payment_intent_id: checkout.payment_intent_id,
    amount: checkout.amount,
    currency: checkout.currency,
    delivery: checkout.delivery,
    human_action: checkout.human_action,
    agent_next_actions: checkout.agent_next_actions
  });
}

function compactPaymentIntent(intent = {}) {
  if (!intent || typeof intent !== "object") return intent;
  return compactObject({
    payment_intent_id: intent.payment_intent_id,
    payment_attempt_id: intent.payment_attempt_id,
    checkout_id: intent.checkout_id,
    order_id: intent.order_id,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    human_action: compactHumanAction(intent.human_action),
    qr_png_url: intent.qr_png_url,
    qr_image_url: intent.qr_image_url,
    mobile_wallet_url: intent.mobile_wallet_url,
    agent_wait: intent.agent_wait,
    agent_next_actions: intent.agent_next_actions
  });
}

function compactHumanAction(action = null) {
  if (!action || typeof action !== "object") return action;
  return compactObject({
    kind: action.kind,
    payment_intent_id: action.payment_intent_id,
    url: action.url,
    local_qr_path: action.local_qr_path,
    local_qr_mime: action.local_qr_mime,
    qr_png_url: action.qr_png_url,
    qr_image_url: action.qr_image_url,
    preferred_qr_url: action.preferred_qr_url,
    mobile_wallet_url: action.mobile_wallet_url,
    presentation: action.presentation,
    agent_display_hint: action.agent_display_hint,
    expires_at: action.expires_at
  });
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function normalizeBuyerMoneyFields(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeBuyerMoneyFields(item));
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = normalizeBuyerMoneyFields(item);
  }
  if (
    typeof next.amount === "number" &&
    Number.isFinite(next.amount) &&
    typeof next.currency === "string" &&
    next.currency.trim()
  ) {
    const currency = next.currency.trim().toUpperCase();
    next.amount_minor = Number.isInteger(next.amount) ? next.amount : Math.round(next.amount);
    next.amount_major = Number((next.amount_minor / 100).toFixed(2));
    next.display_amount = `${currency} ${(next.amount_minor / 100).toFixed(2)}`;
    next.amount_unit = "minor";
  }
  return next;
}

function buyerDocsFor(value = {}) {
  const topics = new Set();
  const status = String(value.status || "").toLowerCase();
  const actions = Array.isArray(value.agent_next_actions) ? value.agent_next_actions : [];
  if (status.includes("catalog")) topics.add("catalog-search");
  if (status.includes("cart") || actions.includes("create_checkout_from_cart")) topics.add("cart-checkout");
  if (status.includes("checkout") || actions.includes("create_payment_intent")) topics.add("cart-checkout");
  if (status.includes("human_auth") || actions.includes("wait_human_auth") || value.human_action?.kind === "auth_qr" || value.checkout?.human_action?.kind === "auth_qr") {
    topics.add("cart-checkout");
    topics.add("payment-qr");
  }
  if (status.includes("payment_handoff") || status.includes("waiting_user_payment") || actions.includes("send_agent_instruction_to_human") || actions.includes("wait_payment") || value.payment_intent?.human_action || value.payment_intent?.qr_image_url) {
    topics.add("payment-qr");
    topics.add("payment-wait");
  }
  if (status.includes("payment_verified") || value.payment_event?.event_type === "payment_intent.verified") topics.add("secure-delivery");
  if (status.includes("delivery") || value.delivery || actions.includes("stop_check_email")) {
    topics.add("secure-delivery");
    topics.add("human-claim-ui");
    topics.add("vault-agent-read");
  }
  if (status.includes("agent_read_grant") || value.agent_readable_grants || value.grant || actions.includes("read_agent_grant_view") || actions.includes("list_agent_read_grants")) {
    topics.add("vault-agent-read");
  }
  if (topics.size === 0) topics.add("quickstart");
  return Array.from(topics).map((topic) => buyerDocRef(topic));
}

function buyerDocRef(topic) {
  return {
    topic,
    command: cliCommand("docs", "show", topic, "--role", "buyer", "--json")
  };
}

function buyerDeliveryListOutput(checkout) {
  const delivery = checkout.delivery || null;
  const checkoutID = checkout.checkout_id;
  return buyerRunOutput({
    status: delivery?.status || checkout.delivery_status,
    checkout_id: checkoutID,
    deliveries: delivery ? [{
      checkout_id: checkoutID,
      status: delivery.status,
      next_required_action: delivery.next_required_action,
      channels: delivery.channels || [],
      artifact_status: delivery.artifact_status,
      sensitive_content_redacted: delivery.sensitive_content_redacted !== false
    }] : [],
    agent_next_actions: deliveryAwareAgentNextActions(checkout),
    optional_agent_read_grant: optionalAgentReadGrantHint(checkoutID, checkout)
  });
}

function deliveryAwareAgentNextActions(checkout = {}) {
  const actions = Array.isArray(checkout.agent_next_actions) ? [...checkout.agent_next_actions] : [];
  if (isBuyerDeliveryComplete(checkout) && !actions.includes("optionally_request_agent_read_grant")) {
    actions.push("optionally_request_agent_read_grant");
  }
  return actions;
}

function optionalAgentReadGrantHint(checkoutID, checkout = {}) {
  if (!checkoutID || !isBuyerDeliveryComplete(checkout)) return undefined;
  return {
    type: "optional_human_passkey_agent_read_grant",
    safe_for_agent: true,
    requires_human: true,
    instruction: "If the human wants you to analyze or use the delivered result, ask them to open the ItPay claim/account page, reveal with Passkey, choose 'Give to Agent / 一键给 Agent', select fields, and confirm. After they approve, do not ask for a grant id; run the probe command.",
    docs_command: cliCommand("docs", "show", "vault-agent-read", "--role", "buyer", "--json"),
    probe_command: cliCommand("buyer", "vault", "grants", "list", "--checkout", checkoutID, "--json"),
    read_pattern: cliCommand("buyer", "vault", "read", "--order", "<order_id>", "--artifact", "<vault_artifact_id>", "--json")
  };
}

async function buyerAuthStatusOutput(flags = {}) {
  const config = readConfig();
  const credentials = readCredentials();
  const token = readSessionToken(credentials);
  if (token && config.account_id) {
    try {
      const status = await coreApi("/v1/me/auth/status", { method: "GET" }, flags);
      return buyerRunOutput({
        status: "authenticated_buyer_session",
        authenticated: true,
        buyer_account_id: status.buyer_account_id || config.account_id,
        agent_device_id: config.device_id || null,
        account_status: status.account_status,
        sensitive_redacted: true,
        agent_next_actions: ["search_catalog", "view_orders", "list_agent_read_grants"]
      });
    } catch (error) {
      return buyerRunOutput({
        status: "buyer_session_invalid",
        authenticated: false,
        buyer_account_id: config.account_id || null,
        agent_device_id: config.device_id || null,
        error: safeErrorMessage(error),
        agent_next_actions: ["create_checkout_for_human_auth"]
      });
    }
  }
  return buyerRunOutput({
    status: "public_purchase_mode",
    authenticated: false,
    auth_required_for_discovery: false,
    agent_next_actions: ["search_catalog", "create_checkout_for_human_auth"],
    note: "Catalog discovery is public. Checkout creates a human auth-to-payment QR and saves a buyer session after the human authorizes."
  });
}

async function listBuyerAgentReadGrants(flags = {}) {
  const params = new URLSearchParams();
  const mappings = [
    ["checkout", "checkout_id"],
    ["checkout_id", "checkout_id"],
    ["order", "order_id"],
    ["order_id", "order_id"],
    ["artifact", "vault_artifact_id"],
    ["vault_artifact", "vault_artifact_id"],
    ["vault_artifact_id", "vault_artifact_id"],
    ["line", "order_line_item_id"],
    ["line_id", "order_line_item_id"],
    ["order_line_item_id", "order_line_item_id"]
  ];
  for (const [flagName, paramName] of mappings) {
    if (flags[flagName] !== undefined && flags[flagName] !== null && flags[flagName] !== false) {
      params.set(paramName, String(flags[flagName]));
    }
  }
  const query = params.toString();
  return await coreApi(`/v1/me/agent-grants${query ? `?${query}` : ""}`, { method: "GET" }, flags);
}

async function readBuyerAgentReadGrant(grantID, flags = {}) {
  if (!grantID) throw new Error("agent_read_grant_id is required");
  return await coreApi(`/v1/me/agent-grants/${encodeURIComponent(grantID)}/view`, { method: "GET" }, flags);
}

async function readBuyerVaultArtifactGrant(flags = {}) {
  const grants = await listBuyerAgentReadGrants(flags);
  const list = Array.isArray(grants.agent_readable_grants) ? grants.agent_readable_grants : [];
  if (!list.length) {
    throw new Error("no active agent-readable grant found; ask the human to open the account portal and confirm one-key agent authorization with Passkey");
  }
  const grant = list[0];
  const grantID = grant.agent_read_grant_id || grant.agent_readGrantID;
  if (!grantID) throw new Error("active grant did not include agent_read_grant_id");
  const view = await readBuyerAgentReadGrant(grantID, flags);
  return {
    ...view,
    discovered_grant: grant
  };
}

function catalogSearchGuidance(catalog = {}, request = {}) {
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  return {
    terminology: {
      product: "服务",
      variant: "购买选项",
      variant_id: "购买选项 ID",
      catalog: "服务目录",
      shelf: "目录清单"
    },
    search_model: "这是 ItPay 服务目录的结构化搜索，不是通用网页搜索。先把用户需求转成 query、category、provider、use-case、input-facet 等条件。",
    before_search: "如果不清楚目录里有什么，先读 itp docs show catalog-search --role buyer --json，并用 buyer shelf manifest/snapshot 查看目录清单。",
    result_count: products.length,
    next_step: products.length === 0
      ? "不要硬猜或直接说没有服务；放宽过滤、换关键词，或回到目录清单重新选择 category/facet。"
      : products.length > 3
        ? "候选较多；继续用 category/provider/use-case/input-facet 收窄，再比较服务内容和购买选项。"
        : "比较候选服务的描述、价格、输入要求、敏感等级和交付方式，向用户解释后再确认购买选项。",
    do_not: [
      "不要把搜索结果排序当成人类购买确认。",
      "不要发明服务 ID 或购买选项 ID。",
      "不要在用户确认前创建购物车或 checkout。"
    ],
    request: {
      query: request.query || "",
      filters: request.filters || {}
    }
  };
}

function catalogSelectionGuidance(selection = {}) {
  return {
    selected_purchase_option_id: selection.catalog_variant_id || selection.ucp_variant_id || null,
    next_step: "先向用户解释这个服务/购买选项的内容、价格、必填输入、交付方式和限制。用户确认购买后，才创建购物车。",
    explain_before_cart: [
      "服务名称和购买选项",
      "价格；金额字段是 minor units，CNY 100 表示 CNY 1.00",
      "需要用户提供或授权的输入",
      "交付是否人类优先、是否需要 Passkey/WebAuthn reveal"
    ],
    do_not: [
      "不要把 catalog get 当成购买。",
      "不要跳过用户确认直接 cart create。",
      "不要选择更贵购买选项，除非用户明确要求。"
    ]
  };
}

function cartConfirmationGuidance(cart = {}, selections = []) {
  const lines = Array.isArray(cart.line_items) ? cart.line_items : [];
  return {
    next_step: "把购物车内容完整展示给用户确认；用户确认后才进入 checkout create。",
    input_source: "服务输入类型来自服务商在 product/selection metadata 或 input schema 中的声明；agent 不要自己猜精确/模糊/敏感类型。",
    confirm_fields: ["服务", "购买选项", "每条输入", "数量", "价格", "交付方式"],
    line_count: lines.length,
    double_check_required: lines.length > 1 || selections.length > 1,
    multi_line_guidance: lines.length > 1 || selections.length > 1
      ? "购物车有多条内容；逐条向用户确认每个服务、输入、数量和价格。"
      : "单条购物车也要展示给用户确认；不要只说已创建。",
    do_not: [
      "不要在聊天中收集服务商声明为敏感/人类授权的输入。",
      "不要用模糊简称填入服务商声明为精确输入的字段。",
      "不要在购物车未确认前创建 checkout。"
    ]
  };
}

function noRecoverableContext() {
  return {
    found: false,
    guidance: "未发现可恢复的旧任务；可以按当前用户意图开始新流程。"
  };
}

function recoverableBuyerContextForStatus(run = {}) {
  const status = String(run.status || run.phase || "").toLowerCase();
  const checkoutID = run.checkout?.checkout_id || run.checkout_id || null;
  const paymentIntentID = run.payment_intent?.payment_intent_id || run.payment_intent_id || null;
  const orderID = run.order?.order_id || run.order_id || run.checkout?.order_id || null;
  const waitingPayment = status.includes("payment") || run.checkout?.status === "waiting_user_payment" || run.payment_intent?.status === "requires_action";
  const waitingAuth = status.includes("auth") || run.auth?.status === "pending";
  const resumable = Boolean(run.run_id || checkoutID || paymentIntentID || orderID);
  if (!resumable && !waitingPayment && !waitingAuth) return noRecoverableContext();
  return recoverableContextPayload({
    kind: waitingAuth ? "human_auth" : waitingPayment ? "payment" : "buyer_run",
    run_id: run.run_id || null,
    checkout_id: checkoutID,
    payment_intent_id: paymentIntentID,
    order_id: orderID,
    status: run.status || run.phase || null,
    phase: run.phase || null,
    resume_command: run.run_id ? cliCommand("resume", "--run-id", run.run_id, "--json") : null,
    status_command: run.run_id ? cliCommand("status", "--refresh", "--run-id", run.run_id, "--json") : cliCommand("status", "--refresh", "--json")
  });
}

function recoverableContextPayload(context = {}) {
  return {
    found: true,
    ...context,
    intent_check: recoverableIntentCheckGuidance(context),
    safe_choices: [
      { choice: "continue_old_task", when: "旧任务与当前用户意图相关，例如用户说刚刚卡住、继续刚才那单、查看刚才付款状态。", action: context.resume_command || context.status_command },
      { choice: "ignore_old_task", when: "当前用户明确要做新的、不相关的任务，例如重新开一单或查询另一件事。", action: "继续当前用户的新意图，但不要把旧任务当成当前上下文。" },
      { choice: "ask_human", when: "旧任务和当前意图是否相关无法判断，尤其涉及付款、退款、订单、授权。", action: "先向用户确认是否继续旧任务。" }
    ],
    guidance: "发现可恢复状态后，不要自动恢复也不要自动忽略。先判断旧任务是否与当前用户意图相关：相关就继续；明确不相关就忽略；不确定就问人类。"
  };
}

function recoverableIntentCheckGuidance(context = {}) {
  return {
    question: "这个可恢复状态是否属于用户当前正在要求处理的同一件事？",
    related_signals: ["用户提到刚刚/上一单/卡住/继续/付款状态/退款", "checkout_id、order_id、payment_intent_id 与用户提供的信息一致"],
    unrelated_signals: ["用户明确要求开新单或处理另一件商品/订单", "旧状态只是本机遗留，当前请求不依赖它"],
    default_when_unsure: "ask_human",
    context_keys_to_compare: Object.fromEntries(Object.entries(context).filter(([, value]) => value !== null && value !== undefined && value !== ""))
  };
}

export { buyerBuy, buyer, buyerCatalogSearchFilters, resolveBuyerCatalogSelection, resolveBuyerCatalogSelections, getBuyerUCPProduct, selectionFromUCPProduct, createBuyerCart, createBuyerCartFromSelections, buyerCartSelectionIDs, buyerCartQuantities, buyerLineInputForSelection, parseBuyerInputs, splitInputParts, getBuyerCart, addBuyerCartLineItem, removeBuyerCartLineItem, createBuyerCheckoutFromCart, requiredDeliveryContactFields, createBuyerPaymentIntent, waitBuyerCheckoutAuth, maybeClaimBuyerSessionFromAuthAction, buyerSessionClaimStatus, maybeClaimBuyerSessionForCheckout, ensureBuyerSessionForVaultAccess, parseBuyerAuthActionURL, buyerAuthActionCandidateURLs, rememberCoreAuthAction, readCoreAuthAction, forgetCoreAuthAction, getBuyerCheckout, createBuyerRefund, getBuyerOrderDetail, listBuyerRefunds, getBuyerRefund, cancelBuyerRefund, getBuyerPaymentIntent, refreshBuyerPaymentQR, normalizeQRRefreshReasonForCLI, waitBuyerPayment, waitBuyerDelivery, isBuyerDeliveryComplete, buyerRunOutput, normalizeBuyerMoneyFields, buyerDocsFor, buyerDocRef, buyerDeliveryListOutput, deliveryAwareAgentNextActions, optionalAgentReadGrantHint, buyerAuthStatusOutput, listBuyerAgentReadGrants, readBuyerAgentReadGrant, readBuyerVaultArtifactGrant, noRecoverableContext, recoverableBuyerContextForStatus, recoverableContextPayload, recoverableIntentCheckGuidance };
