// Assemble checksummed runtime release assets from an already tested Compose build.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
const [sourceCommit, output] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || !output) throw new Error('usage: node scripts/prepare-sell-runtime.mjs <compose-sha> <asset-directory>');
const root = new URL('../',import.meta.url);
const lock = {source_repository:'itpay-ai/compose',source_commit:sourceCommit,tag:`seller-runtime-${sourceCommit.slice(0,12)}`,sha256:{}};
mkdirSync(output,{recursive:true});
for (const target of ['darwin-arm64','darwin-amd64','linux-arm64','linux-amd64','windows-amd64']) {
  const binary = readFileSync(new URL(`bin/${target}/itpay-sell${target.startsWith('windows')?'.exe':''}`,root));
  lock.sha256[target] = createHash('sha256').update(binary).digest('hex');
  writeFileSync(resolve(output,`itpay-sell-${target}.gz`),gzipSync(binary));
}
writeFileSync(new URL('seller-runtime.lock.json',root),JSON.stringify(lock,null,2)+'\n');
writeFileSync(resolve(output,'seller-runtime.lock.json'),JSON.stringify(lock,null,2)+'\n');
