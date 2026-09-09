import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const required = ['assets/sell-preview/index.html', ...['darwin-arm64','darwin-amd64','linux-arm64','linux-amd64','windows-amd64'].map(target=>`bin/${target}/itpay-sell${target.startsWith('windows')?'.exe':''}`)];
for (const path of required) {
 if (!existsSync(fileURLToPath(new URL('../'+path, import.meta.url)))) throw new Error(`Incomplete Sell package: ${path}. Build the native runtimes and Builder assets before packaging.`);
}
