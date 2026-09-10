import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('seller-runtime.lock.json', root), 'utf8'));
for (const path of ['assets/sell-preview/index.html','assets/sell-preview/preview.js']) {
  if (!existsSync(new URL(path,root))) throw new Error(`Incomplete Sell package: ${path}`);
}
for (const target of ['darwin-arm64','darwin-amd64','linux-arm64','linux-amd64','windows-amd64']) {
 const path = `bin/${target}/itpay-sell${target.startsWith('windows')?'.exe':''}`;
 const file = fileURLToPath(new URL(path,root));
 if (!existsSync(file)) throw new Error(`Incomplete Sell package: ${path}. Run node scripts/fetch-sell-runtime.mjs.`);
 const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
 if (lock.sha256[target] !== hash) throw new Error(`Seller runtime does not match the pinned source: ${target}`);
}
