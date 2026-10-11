import type { BackendClient } from "../client/backend.js";
import type { CatalogItem } from "../client/types.js";
import type { OutputSink } from "../render/sink.js";
import { writeCommandEnvelope } from "./guidance.js";

export async function runCatalogList(
  backend: BackendClient,
  options: { jsonOutput?: boolean; output?: OutputSink; locale?: "zh-CN" | "en" } = {},
): Promise<void> {
  const manifest = await backend.getCatalogManifest();
  const services = manifest.manifest.items.map(item=>summarizeService(item,options.locale ?? "zh-CN"));
  const firstServiceID = manifest.manifest.items.find((item) => item.service_id)?.service_id;
  const empty = services.length === 0;
  const jsonFlag = options.jsonOutput ? " --json" : "";
  writeCommandEnvelope({
    status: empty ? "catalog_empty" : "listed",
    result: { catalog_version: manifest.version, services },
    instruction: empty
      ? "当前没有已发布服务；本次目录读取结束，不猜测服务或自动重试。"
      : options.locale === "en" ? "Explain the service, its operations and pricing; start only the declared operation matching the human request." : "向用户解释主服务、辅助步骤和价格；得到用户意图后再启动对应 service_id。",
    next: services.length === 1 && firstServiceID
      ? { command: `itpay services start ${firstServiceID}${jsonFlag}`, reason: "仅当当前服务符合用户请求时读取输入合同；不表示购买同意" }
      : null,
    recovery: [],
  }, {
    ...options,
    plainResult: catalogPlainLines(manifest.version, services),
  });
}

function summarizeService(item: CatalogItem,locale:"zh-CN"|"en"): Record<string, unknown> {
  const definition=item.service_definition;
  if(definition){
    if(definition.schema_version!=="itpay.service-definition.v1") return {service_id:item.service_id,title:item.title,description:"服务定义版本不受支持；升级CLI后读取，不猜操作。"};
    return {
      service_id:definition.service_id,title:definition.display_names[locale] ?? item.title,
      entry:`itpay services start ${definition.service_id} --json`,definition_version:definition.definition_version,
      ...(definition.guide?{guide:`itpay docs show ${definition.guide.topic}`} : {}),
      operations:definition.operations.map(op=>({operation_id:op.id,title:op.display_names[locale],role:op.role,price:op.billing_mode==="dynamic"?(locale === "en" ? (definition.adapter_key === "rail.v1" ? "Live quote; free queries do not mean free tickets" : "Live quote; confirm the locked amount") : (definition.adapter_key === "rail.v1" ? "实时报价；免费查询不等于免费车票" : "实时报价，以锁定报价为准")):op.billing_mode==="free"?(locale === "en" ? "Free query" : "免费查询"):typeof op.price_amount_minor === "number" && op.price_currency ? formatProductMoney(op.price_amount_minor,op.price_currency) : (locale === "en" ? "Fixed price missing; stop purchase preparation" : "固定价格事实缺失；停止准备购买"),requires_continuation:op.requires_continuation ?? false})),
    };
  }

  const flow = item.service_flow;
  const offer = item.variants?.[0];
  return {
    service_id: item.service_id ?? null,
    ...(item.service_id ? { entry: `itpay services start ${item.service_id} --json` } : {}),
    title: item.title,
    description: item.description ?? "",

    ...(flow ? {
      discovery: {
        title: flow.discovery.title,
        description: flow.discovery.description ?? "",
        ...(flow.discovery.free_quota_limit !== undefined ? { free_quota: flow.discovery.free_quota_limit } : {}),
        ...(flow.discovery.paid_continuation ? {
          paid_price: formatProductMoney(
            flow.discovery.paid_continuation.amount_minor,
            flow.discovery.paid_continuation.currency,
          ),
        } : {}),
      },
      primary_offer: {
        title: flow.primary_service.title,
        description: flow.primary_service.description ?? "",
        price: formatProductMoney(flow.primary_service.amount_minor, flow.primary_service.currency),
      },
    } : offer ? {
      primary_offer: {
        title: offer.title || item.title,
        description: item.description ?? "",
        price: formatProductMoney(offer.amount_minor, offer.currency),
      },
    } : {}),
  };
}

function catalogPlainLines(version: string, services: Record<string, unknown>[]): string[] {
  const lines = [`catalog_version: ${version}`];
  for (const service of services) {
    lines.push(`service: ${String(service.title)}`);
    lines.push(`  service_id: ${String(service.service_id ?? "unavailable")}`);
    if (service.entry) lines.push(`  entry: ${String(service.entry)}`);
    if (service.guide) lines.push(`  guide: ${String(service.guide)}`);
    if (service.description) lines.push(`  description: ${String(service.description)}`);
    if(Array.isArray(service.operations)) for(const op of service.operations) lines.push(`  operation: ${String(op.operation_id)} — ${String(op.title)}; ${String(op.price)}`);
    const discovery = service.discovery as Record<string, unknown> | undefined;
    if (discovery) {
      const quota = discovery.free_quota !== undefined ? `; free_quota: ${String(discovery.free_quota)}` : "";
      const paid = discovery.paid_price ? `; paid_price: ${String(discovery.paid_price)}` : "";
      lines.push(`  discovery: ${String(discovery.title)}${quota}${paid}`);
      if (discovery.description) lines.push(`    ${String(discovery.description)}`);
    }
    const primary = service.primary_offer as Record<string, unknown> | undefined;
    if (primary) {
      lines.push(`  primary_offer: ${String(primary.title)}; price: ${String(primary.price)}`);
      if (primary.description) lines.push(`    ${String(primary.description)}`);
    }
  }
  return lines;
}

function formatProductMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}
