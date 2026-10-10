import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseSource, checkPackage } from './npm-release-source.mjs';

export function releaseTarget({ event, action = 'publish', tag, version, declaredTag, previousVersion }) {
  if (!['publish', 'stage', 'promote', 'verify'].includes(action)) throw new Error('Unsupported release action');
  const channel = event === 'push' ? declaredTag : tag;
  if (!(action === 'stage' ? ['candidate-dev', 'candidate-prod'] : ['next', 'latest']).includes(channel)) throw new Error('Choose the release channel explicitly');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('An exact package version is required');
  if (channel === 'latest' && version.includes('-')) throw new Error('Prerelease versions cannot target latest');
  return { action, channel, version, skip: event === 'push' && previousVersion === version };
}

async function metadata(spec) {
  const response = await fetch(`https://registry.npmjs.org/@itpay%2fcli/${encodeURIComponent(spec)}`, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry lookup failed: ${response.status}; publication was not attempted`);
  return response.json();
}

// npm dist-tag add skips PUT for an unchanged tag, so it cannot verify write permission.
export async function verifyOidcTag(channel, version, request = fetch, env = process.env) {
  if (!['next', 'latest'].includes(channel)) throw new Error('Invalid verification channel');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('GitHub OIDC is required');
  const json = async (url, options = {}) => {
    const response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`OIDC verification failed: HTTP ${response.status}`);
    return response.json();
  };
  const issuer = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  issuer.searchParams.set('audience', 'npm:registry.npmjs.org');
  const identity = await json(issuer, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (!identity.value) throw new Error('GitHub did not return an OIDC identity');
  const exchanged = await json('https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@itpay%2fcli', {
    method: 'POST', headers: { Authorization: `Bearer ${identity.value}` },
  });
  if (!exchanged.token) throw new Error('npm did not return an OIDC exchange token');
  const url = 'https://registry.npmjs.org/-/package/@itpay%2fcli/dist-tags';
  const tags = await json(url);
  if (tags[channel] !== version) throw new Error('Verify refuses to move a tag');
  const response = await request(`${url}/${channel}`, {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${exchanged.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(version),
  });
  if (!response.ok) throw new Error(`OIDC tag write failed: HTTP ${response.status}`);
}

async function main() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (pkg.name !== '@itpay/cli') throw new Error('Unexpected package');
  let previousVersion;
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (!event.before || /^0+$/.test(event.before)) throw new Error('No previous main revision; use manual publish');
    previousVersion = JSON.parse(execFileSync('git', ['show', `${event.before}:package.json`], { encoding: 'utf8' })).version;
  }
  const action = process.env.RELEASE_ACTION || 'stage';
  let artifact;
  let publishFile;
  const approvals = JSON.parse(readFileSync(new URL('./npm-release-sources.json', import.meta.url), 'utf8'));
  if (action === 'stage') {
    const source = releaseSource({ source: process.env.RELEASE_SOURCE || 'main', mainSha: process.env.GITHUB_SHA, approvals });
    artifact = JSON.parse(readFileSync('release-artifact/manifest.json', 'utf8'));
    if (!/^2\.\d+\.\d+$/.test(artifact.version) || !/^sha256:[a-f0-9]{64}$/.test(artifact.api)
      || artifact.source !== source.sha || artifact.workflow !== process.env.GITHUB_SHA || artifact.channel !== source.channel
      || artifact.file !== `itpay-cli-${artifact.version}.tgz` || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Artifact source does not match approved workflow');
    publishFile = resolve('release-artifact', artifact.file);
    if (createHash('sha256').update(readFileSync(publishFile)).digest('hex') !== artifact.sha256) throw new Error('Artifact checksum mismatch');
    const packed = JSON.parse(execFileSync('tar', ['-xOf', publishFile, 'package/package.json'], { encoding: 'utf8' }));
    if (packed.gitHead !== source.sha || packed.version !== artifact.version) throw new Error('Packed source identity mismatch');
    const compiled = execFileSync('tar', ['-xOf', publishFile, 'package/dist/src/state/config.js'], { encoding: 'utf8' });
    if (checkPackage(packed, compiled, source) !== artifact.api) throw new Error('Packed API does not match recorded artifact');
  }
  const target = releaseTarget({ event: process.env.GITHUB_EVENT_NAME, action,
    tag: artifact?.channel || process.env.RELEASE_TAG, declaredTag: artifact?.channel || pkg.publishConfig?.tag,
    version: artifact?.version || (action === 'publish' ? pkg.version : process.env.RELEASE_VERSION), previousVersion });
  const record = message => {
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  };
  if (target.skip) return record(`No version change (${pkg.version}); nothing published or retagged.`);
  const existing = await metadata(target.version);
  const npm = args => execFileSync('npm', args, { stdio: 'inherit' });
  if (target.action === 'publish' || target.action === 'stage') {
    const sourceSha = artifact?.source || process.env.GITHUB_SHA;
    if (existing) {
      if (existing.gitHead !== sourceSha) throw new Error('Version exists from another revision; do not overwrite it. Use promote for an existing release.');
      const pointed = await metadata(target.channel);
      if (pointed?.version !== target.version) throw new Error('Version exists but tag differs; use explicit promote');
      return record(`Already published ${target.version} from this revision to ${target.channel}; no mutation.`);
    }
    // Publish only the checked artifact; candidate scripts never run with OIDC permissions.
    npm(['publish', ...(publishFile ? [publishFile] : []), '--ignore-scripts', '--access', 'public', '--tag', target.channel]);
  } else {
    if (!existing) throw new Error('Selected version does not exist');
    if (target.action === 'verify') {
      const current = await metadata(target.channel);
      if (current?.version !== target.version) throw new Error('Verify may only reassert the current tag, never move it');
    }
    if (target.action === 'verify') await verifyOidcTag(target.channel, target.version);
    else {
      const approved = releaseSource({ source: target.channel === 'latest' ? 'prod' : 'dev', mainSha: process.env.GITHUB_SHA, approvals });
      if (existing.gitHead !== approved.sha || existing.version !== approved.version) throw new Error('Promotion does not match approved source');
      npm(['dist-tag', 'add', `@itpay/cli@${target.version}`, target.channel]);
    }
  }
  const actual = await metadata(target.channel);
  if (actual?.version !== target.version) throw new Error('Registry tag does not match; inspect the completed operation before retrying');
  if (artifact && actual.gitHead !== artifact.source) throw new Error('Registry source does not match the staged artifact; inspect without republishing');
  record(`${target.action}: @itpay/cli@${actual.version} → ${target.channel}; registry verified.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
