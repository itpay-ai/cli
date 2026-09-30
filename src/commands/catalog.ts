import type { BackendClient } from "../client/backend.js";
import type { CatalogItem } from "../client/types.js";
import type { OutputSink } from "../render/sink.js";
import { writeCommandEnvelope } from "./guidance.js";

export async function runCatalogList(
  backend: BackendClient,
  options: { jsonOutput?: boolean; output?: OutputSink } = {},
): Promise<void> {
  const manifest = await backend.getCatalogManifest();
  const services = manifest.manifest.items.map(summarizeService);
  const firstServiceID = manifest.manifest.items.find((item) => item.service_id)?.service_id;
  const empty = services.length === 0;
  const jsonFlag = options.jsonOutput ? " --json" : "";
  writeCommandEnvelope({
    status: empty ? "catalog_empty" : "listed",
    result: { catalog_version: manifest.version, services },
    instruction: empty
      ? "当前没有已发布服务；本次目录读取结束，不猜测服务或自动重试。"
      : "向用户解释主服务、辅助步骤和价格；得到用户意图后再启动对应 service_id。",
    next: services.length === 1 && firstServiceID
      ? { command: `itpay services start ${firstServiceID}${jsonFlag}`, reason: "仅当当前服务符合用户请求时读取输入合同；不表示购买同意" }
      : null,
    recovery: [],
  }, {
    ...options,
    plainResult: catalogPlainLines(manifest.version, services),
  });
}

function summarizeService(item: CatalogItem): Record<string, unknown> {
  const flow = item.service_flow;
  const offer = item.variants?.[0];
  return {
    service_id: item.service_id ?? null,
    ...(item.service_id ? { entry: `itpay services start ${item.service_id} --json` } : {}),
    title: item.title,
    description: item.description ?? "",
    ...(item.service_id?.startsWith("itpay-rail-") ? { guide: "itpay docs show rail-booking" } : {}),
    ...(flow ? {
      discovery: {
        title: flow.discovery.title,
        description: flow.discovery.description,
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
        description: flow.primary_service.description,
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
    if (service.description) lines.push(`  description: ${String(service.description)}`);
    const discovery = service.discovery as Record<string, unknown> | undefined;
    if (discovery) {
      const quota = discovery.free_quota !== undefined ? `; free_quota: ${String(discovery.free_quota)}` : "";
      const paid = discovery.paid_price ? `; paid_price: ${String(discovery.paid_price)}` : "";
      lines.push(`  discovery: ${String(discovery.title)}${quota}${paid}`);
      lines.push(`    ${String(discovery.description)}`);
    }
    const primary = service.primary_offer as Record<string, unknown> | undefined;
    if (primary) {
      lines.push(`  primary_offer: ${String(primary.title)}; price: ${String(primary.price)}`);
      lines.push(`    ${String(primary.description)}`);
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
