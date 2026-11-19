import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseSource({ source = 'main', mainSha, action = 'publish', tag = 'next' }) {
  if (!/^[a-f0-9]{40}$/.test(mainSha)) throw new Error('An exact trusted workflow revision is required');
  if (source !== 'main' || action !== 'publish' || tag !== 'next') throw new Error('Direct publication requires main to next');
  return { sha: mainSha, channel: 'next' };
}
export function checkPackage(pkg, config, source = {}) {
  if (pkg.name !== '@itpay/cli' || !/^0\.2\.\d+$/.test(pkg.version)) throw new Error('Unexpected release package');
  const version = config.match(/CLI_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  if (version !== pkg.version || (source.version && source.version !== pkg.version)) throw new Error('Source version differs from package');
  return config.match(/API_CONTRACT_REVISION\s*=\s*["']([^"']+)["']/)?.[1]; // Diagnostic only.
}
function main() {
  const source = releaseSource({ mainSha: process.env.GITHUB_SHA, action: process.env.RELEASE_ACTION || 'publish', tag: process.env.RELEASE_TAG || 'next' });
  if (process.argv[2] !== 'pack') throw new Error('Unknown source operation');
  const cwd = resolve(process.env.RELEASE_CHECKOUT);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() !== source.sha) throw new Error('Checkout does not match trusted main');
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  const api = checkPackage(pkg, readFileSync(resolve(cwd, 'src/state/release_identity.ts'), 'utf8'));
  pkg.gitHead = source.sha;
  writeFileSync(resolve(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const output = resolve('release-artifact');
  mkdirSync(output, { recursive: true });
  execFileSync('npm', ['--prefix', cwd, 'pack', '--ignore-scripts', '--pack-destination', output], { cwd, stdio: 'inherit' });
  const file = `itpay-cli-${pkg.version}.tgz`;
  const sha256 = createHash('sha256').update(readFileSync(resolve(output, file))).digest('hex');
  const manifest = { source: source.sha, workflow: process.env.GITHUB_SHA, version: pkg.version, api, file, sha256, channel: source.channel };
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
