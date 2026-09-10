import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
const root = new URL('../', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('seller-runtime.lock.json', root), 'utf8'));
if (!/^seller-runtime-[a-z0-9.-]+$/.test(lock.tag) || !/^[a-f0-9]{40}$/.test(lock.source_commit)) throw new Error('Invalid runtime source lock');
for (const target of ['darwin-arm64','darwin-amd64','linux-arm64','linux-amd64','windows-amd64']) {
  const expected = lock.sha256[target];
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Missing runtime checksum: ${target}`);
  const response = await fetch(`https://github.com/itpay-ai/cli/releases/download/${lock.tag}/itpay-sell-${target}.gz`, {signal:AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`Runtime download failed: ${target} (${response.status})`);
  const binary = gunzipSync(Buffer.from(await response.arrayBuffer()), {maxOutputLength:128*1024*1024});
  if (createHash('sha256').update(binary).digest('hex') !== expected) throw new Error(`Runtime checksum mismatch: ${target}`);
  const output = fileURLToPath(new URL(`bin/${target}/itpay-sell${target.startsWith('windows')?'.exe':''}`, root));
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output+'.tmp',binary,{mode:0o755});
  renameSync(output+'.tmp',output);
}
