import type { ServiceExecutionReadModel } from "../../client/types.js";
import type { CommandEnvelope } from "../shared/envelope.js";
import { exactTrainRow, exactSmartTemplate, locationConfirmationEnvelope } from "./query.js";

export function railSavedResultEnvelope(model: ServiceExecutionReadModel): CommandEnvelope | null {
 const execution = model.execution;
 const currentItems = model.current_result_items ?? [];
  const latestInvocation = model.provider_invocations.at(-1);
  const latestPreview = latestInvocation?.safe_result_preview as Record<string, unknown> | undefined;
  if ( currentItems.length === 0 && latestPreview?.search_status === "LOCATION_CONFIRMATION_REQUIRED" && latestPreview.location_confirmation) {
    const capability = model.capabilities.find((item) => item.capability_id === latestInvocation?.capability_id && item.phase === execution.phase && !item.requires_payment);
    if (capability) return locationConfirmationEnvelope(execution.service_execution_id, capability.capability_id,
      (latestInvocation?.request_summary ?? {}) as Record<string, unknown>, latestPreview.location_confirmation as Record<string, unknown>);
  }
	if ( execution.service_id === "itpay-rail-exact" && currentItems.length > 0) {
		const item = currentItems[0]!;
		const container = (item.safe_payload?.result ?? item.safe_payload) as Record<string, unknown> | undefined;
		const total = typeof container?.catalog_total === "number" ? container.catalog_total :
			Array.isArray(container?.candidates) ? container.candidates.length : 0;
		return {
			status: total > 0 ? "result_ready" : "no_result",
			result: { service_execution_id: execution.service_execution_id, scope: "station_pair",
				resolved_station_pair: container?.resolved_station_pair, total,
				result_item_id: item.service_capability_result_item_id,
                trains: Array.isArray(container?.candidates) ? container.candidates.slice(0, 3).map((value, index) => exactTrainRow(value as Record<string, unknown>, execution.service_execution_id, item.service_capability_result_item_id, index)) : [],
				...(exactSmartTemplate(container?.resolved_station_pair, execution.service_execution_id, item.service_capability_result_item_id, execution.public_binding)
					? { smart_template: exactSmartTemplate(container?.resolved_station_pair, execution.service_execution_id, item.service_capability_result_item_id, execution.public_binding) } : {}) },
			instruction: total > 0
				? "直达站对结果已保存。执行 next.command 一次读取紧凑车次行，按用户条件筛选；若只需比较，答复后结束；已有购票委托则读取所选行详情。"
				: "这一已解析站对返回 0 条；不代表全城无车。若原需求需要更广覆盖，可核验另一可信站对或 Smart。",
			next: { command: `itpay services read-result ${execution.service_execution_id} --json`, reason: "读取这一保存站对的紧凑分页；按返回的续页覆盖所需范围" },
			recovery: [],
		};
	}
 return null;
}

export function railSavedDeliveryGuidance(model: ServiceExecutionReadModel): { instruction: string; recovery: NonNullable<CommandEnvelope["recovery"]> } {
		const railCatalog = (model.current_result_items ?? []).some((item) => {
			const container = (item.safe_payload?.result ?? item.safe_payload) as Record<string, unknown> | undefined;
			return container?.catalog_page !== undefined || container?.cost_semantics !== undefined;
		});
		const pageRecovery = (model.current_result_items ?? []).flatMap((item) => {
      const container = (item.safe_payload?.result ?? item.safe_payload) as Record<string, unknown> | undefined;
      const catalogPage = container?.catalog_page as { next_offset?: number } | undefined;
      const nextOffset = catalogPage?.next_offset;
      return typeof nextOffset === "number"
        ? [{ command: `itpay services page ${model.execution.service_execution_id} ${item.service_capability_result_item_id} --offset ${nextOffset} --json`, reason: "读取已保存结果的同版本下一页，不重新查询、不消耗额度" }]
        : [];
    });
		const railCostGuidance = "铁路应付只含票价加服务费（quoted_total_minor）；地面接驳是单独估算（estimated_ground_minor），两者相加是已知估算（estimated_door_to_door_minor），不是收款额。";
 return {instruction: railCatalog ? railCostGuidance : "", recovery: pageRecovery};
}
