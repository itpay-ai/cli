import { railAdapter, railAdapterFor } from "./rail/adapter.js";
import { schemaAdapter, unsupportedAdapter } from "./schema.js";
import type { ServiceAdapter } from "./adapter.js";
import type { ServiceExecution, ErrorResponse } from "../client/types.js";

// Published identities are frozen compatibility contracts. Fields named
// endpoints/review/search, titles and ID prefixes never choose a business adapter.
const legacyRailContracts = new Map<string, ReadonlySet<string>>([
 ["itpay-rail-exact", new Set(["scv_itpay_rail_exact_v1", "scv_itpay_rail_exact_v1_capacity_20261015"])],
 ["itpay-rail-smart", new Set(["scv_itpay_rail_smart_v1", "scv_itpay_rail_smart_v2", "scv_itpay_rail_smart_v3", "scv_itpay_rail_smart_v4", "scv_itpay_rail_smart_v5", "scv_itpay_rail_smart_v6", "scv_itpay_rail_smart_v6_capacity_20261015"])],
 ["itpay-rail-booking", new Set(["scv_itpay_rail_booking_v1", "scv_itpay_rail_booking_v2", "scv_itpay_rail_booking_v3", "scv_itpay_rail_booking_v4"])],
]);
export type ServiceAdapterKey = "rail.v1" | "schema.v1" | "unsupported";
export function serviceAdapterKey(execution: Pick<ServiceExecution, "service_id" | "service_contract_version_id" | "public_binding">): ServiceAdapterKey {
 const binding = execution.public_binding;
 if (binding) {
  if (binding.adapter_key === "schema.v1") return "schema.v1";
  if (binding.adapter_key === "rail.v1" && ["scv_itpay_rail_public_v1", "scv_itpay_rail_public_v1_capacity_20261015"].includes(binding.service_definition_version)) return "rail.v1";
  return "unsupported";
 }
 const versions = legacyRailContracts.get(execution.service_id);
 if (versions) return versions.has(execution.service_contract_version_id) ? "rail.v1" : "unsupported";
 return "schema.v1";
}
export function serviceClientFeatures(): string[] {
 // Negotiation advertises supported wire formats, not a service identity.
 return ["rail.progressive.v2"];
}

export function serviceAdapter(execution: Parameters<typeof serviceAdapterKey>[0]): ServiceAdapter {
 const key = serviceAdapterKey(execution);
 return key === "rail.v1" ? railAdapterFor(execution) : key === "schema.v1" ? schemaAdapter : unsupportedAdapter;
}

// Error identity is emitted by Backend after definition/owner validation. A
// conflicting public binding must not select another service's presentation.
export function errorServiceAdapter(payload: ErrorResponse | undefined, requestedServiceID: string): ServiceAdapter | undefined {
 if (!payload?.service_id || !payload.service_contract_version_id) return undefined;
 if (payload.public_binding && payload.public_binding.public_service_id !== requestedServiceID) return unsupportedAdapter;
 return serviceAdapter({service_id:payload.service_id,service_contract_version_id:payload.service_contract_version_id,
   ...(payload.public_binding ? {public_binding:payload.public_binding} : {})});
}

// Presentation is already owner/payability-verified. Business projection is pure:
// it cannot delay the authoritative handoff with a second network read.
export function projectCheckoutPresentation(presentation: import("../client/types.js").CheckoutPresentation, model?: import("../client/types.js").ServiceExecutionReadModel): ReturnType<ServiceAdapter["checkout"]> {
 const adapter = model ? serviceAdapter(model.execution) : presentation.rail_quote ? railAdapter : schemaAdapter;
 return adapter.checkout(model,presentation);
}
