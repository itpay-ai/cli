import type { BackendClient } from "../client/backend.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";

export async function runCatalogList(
  backend: BackendClient,
  options: { jsonOutput?: boolean; output?: OutputSink } = {},
): Promise<void> {
  const manifest = await backend.getCatalogManifest();
  const items = manifest.manifest.items;
  const out = resolveOutput(options.output);

  if (options.jsonOutput) {
    out(JSON.stringify(manifest, null, 2) + "\n");
    return;
  }

  out(`ItPay 当前上线 ${items.length} 个服务（目录版本 ${manifest.version}）\n\n`);

  for (const item of items) {
    out(`  ${item.title}\n`);
    if (item.description) out(`    ${item.description}\n`);
    if (item.service_flow) {
      const discovery = item.service_flow.discovery;
      const primary = item.service_flow.primary_service;
      out(`\n    先做什么：${discovery.title}\n`);
      out(`    ${discovery.description}\n`);
      if (discovery.free_quota_limit !== undefined) {
        out(`    每台已登记设备可免费使用 ${discovery.free_quota_limit} 次。\n`);
      }
      if (discovery.paid_continuation) {
        const continuation = discovery.paid_continuation;
        out(`    免费次数用完后：${formatProductMoney(continuation.amount_minor, continuation.currency)}/次，继续使用该辅助步骤；结果直接返回给 agent${continuation.delivery_email_required ? "，需要用户提供收件邮箱" : "，不需要邮箱"}。\n`);
      }
      out(`\n    确认主体后：${primary.title}，${formatProductMoney(primary.amount_minor, primary.currency)}/次\n`);
      out(`    ${primary.description}\n`);
      if (primary.delivery_description) out(`    ${primary.delivery_description}\n`);
    }
    out(`\n    服务 ID：${item.service_id ?? "未发布"}`);
    if (item.service_id) out(`（启动：itpay services start ${item.service_id}）`);
    out("\n");
    if (item.variants.length > 0) {
      out(`    可购买项目：\n`);
      for (const variant of item.variants) {
        out(
          `      - ${variant.catalog_variant_id}  ${variant.title}  ${variant.offer_id}  ${formatProductMoney(variant.amount_minor, variant.currency)}\n`,
        );
      }
    }
    out("\n");
  }
}

function formatProductMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}
