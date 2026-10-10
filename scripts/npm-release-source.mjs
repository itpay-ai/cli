import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseSource({ source, mainSha, approvals }) {
  if (!/^[a-f0-9]{40}$/.test(mainSha)) throw new Error('An exact trusted workflow revision is required');
  if (source === 'main') return { sha: mainSha, channel: 'candidate-dev' };
  if (!['dev', 'prod'].includes(source)) throw new Error('Choose an approved internal source');
  const approved = approvals[source];
  if (!approved || !/^[a-f0-9]{40}$/.test(approved.sha)
    || !/^2\.\d+\.\d+$/.test(approved.version)
    || !/^sha256:[a-f0-9]{64}$/.test(approved.api)) throw new Error('Source has not been approved on main');
  return { ...approved, channel: `candidate-${source}` };
}

export function checkPackage(pkg, config, source) {
  if (pkg.name !== '@itpay/cli' || !/^2\.\d+\.\d+$/.test(pkg.version)) throw new Error('Unexpected release package');
  const api = config.match(/API_CONTRACT_REVISION\s*=\s*["'](sha256:[a-f0-9]{64})["']/)?.[1];
  if (!api || (source.version && source.version !== pkg.version) || (source.api && source.api !== api)) {
    throw new Error('Package version or API does not match its approved source');
  }
  return api;
}

function main() {
  const mode = process.argv[2];
  const source = releaseSource({ source: process.env.RELEASE_SOURCE || 'main', mainSha: process.env.GITHUB_SHA,
    approvals: JSON.parse(readFileSync(new URL('./npm-release-sources.json', import.meta.url), 'utf8')) });
  if (mode === 'select') {
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${source.sha}\nchannel=${source.channel}\n`);
    return;
  }
  if (mode !== 'pack') throw new Error('Unknown source operation');
  const cwd = resolve(process.env.RELEASE_CHECKOUT);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() !== source.sha) throw new Error('Checkout does not match approved source');
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  const api = checkPackage(pkg, readFileSync(resolve(cwd, 'src/state/config.ts'), 'utf8'), source);
  // Record actual package source; the trusted workflow SHA can differ on maintenance releases.
  pkg.gitHead = source.sha;
  writeFileSync(resolve(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const output = resolve('release-artifact');
  mkdirSync(output, { recursive: true });
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output], { cwd, stdio: 'inherit' });
  const file = `itpay-cli-${pkg.version}.tgz`;
  const sha256 = createHash('sha256').update(readFileSync(resolve(output, file))).digest('hex');
  const manifest = { source: source.sha, workflow: process.env.GITHUB_SHA, version: pkg.version, api, file, sha256, channel: source.channel };
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
