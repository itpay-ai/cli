import type { BackendClient } from "../client/backend.js";
import { formatMoney } from "../render/output.js";
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

  out(`Catalog: ${manifest.version} (${manifest.status}, ${items.length} items)\n\n`);

  for (const item of items) {
    out(`  ${item.catalog_item_id}\n`);
    out(`    title:    ${item.title}\n`);
    out(`    provider: ${item.provider} | type: ${item.service_type} | category: ${item.category}\n`);
    if (item.service_id) out(`    service:  ${item.service_id} (use: itpay services start ${item.service_id})\n`);
    if (item.variants.length > 0) {
      out(`    variants:\n`);
      for (const variant of item.variants) {
        out(
          `      - ${variant.catalog_variant_id}  ${variant.title}  ${variant.offer_id}  ${formatMoney(variant.amount_minor, variant.currency)}\n`,
        );
      }
    }
    out("\n");
  }
}
