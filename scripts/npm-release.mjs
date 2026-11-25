import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { releaseSource, checkPackage } from './npm-release-source.mjs';

export function releaseTarget({ event, action = 'publish', tag, version }) {
  if (event !== 'workflow_dispatch' || !['publish', 'promote', 'verify', 'readback'].includes(action)) throw new Error('Manual release action required');
  if (!['next', 'latest'].includes(tag) || (['publish', 'readback'].includes(action) && tag !== 'next')) throw new Error('Choose an approved release channel');
  if (!/^0\.2\.\d+$/.test(version)) throw new Error('An exact 0.2.x package version is required');
  return { action, channel: tag, version };
}

async function missingRegistryRead(response) {
  if (response.status !== 404) return false;
  if (/just a moment|verify you are human|challenge-platform/i.test((await response.text()).slice(0, 8192))) {
    throw new Error('Registry read returned a challenge');
  }
  return true;
}

async function metadata(spec, timeout = 30_000) {
  const response = await fetch(`https://registry.npmjs.org/@itpay%2fcli/${encodeURIComponent(spec)}`, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(timeout) });
  if (await missingRegistryRead(response)) return null;
  if (!response.ok) throw new Error(`Registry lookup failed: ${response.status}; publication was not attempted`);
  return response.json();
}

// Treat only a missing or not-yet-current published artifact as retryable.
class PublicationVisibilityTimeout extends Error {}
const pauseReadback = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitForPublishedRead(read, pause = pauseReadback, now = Date.now) {
  const deadline = now() + 600_000;
  do {
    const actual = await read(Math.min(15_000, Math.max(1, deadline - now())));
    if (actual) return actual;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await pause(Math.min(15_000, remaining));
  } while (now() < deadline);
  throw new PublicationVisibilityTimeout('Published package is not visible yet; inspect the original publication before retrying');
}

export async function readPublished(target, source, lookup = metadata, pause = pauseReadback, now = Date.now) {
  return waitForPublishedRead(async timeout => {
    const actual = await lookup(target.channel, timeout);
    if (actual?.version !== target.version) return null;
    if (actual.gitHead !== source) throw new Error('Registry source differs; inspect before retrying');
    return actual;
  }, pause, now);
}

export async function verifyPublishedArtifact(existing, approved, request = fetch) {
  if (existing.gitHead !== approved.sha || existing.version !== approved.version) throw new Error('Promotion does not match approved source');
  const url = new URL(existing.dist?.tarball || 'https://invalid.example');
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password) throw new Error('Unexpected registry artifact origin');
  const response = await waitForPublishedRead(async timeout => {
    const current = await request(url, { redirect:'error', headers:{'Cache-Control':'no-cache'}, signal:AbortSignal.timeout(timeout) });
    if (await missingRegistryRead(current)) return null;
    if (!current.ok) throw new Error(`Registry artifact could not be verified: HTTP ${current.status}`);
    return current;
  });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 50 * 1024 * 1024) throw new Error('Registry artifact could not be verified');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 50 * 1024 * 1024 || (approved.sha256 && createHash('sha256').update(bytes).digest('hex') !== approved.sha256)) throw new Error('Registry artifact does not match approved hash');
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== existing.dist.integrity) throw new Error('Registry artifact integrity mismatch');
  const directory = mkdtempSync(join(tmpdir(), 'itpay-registry-proof-'));
  try {
    const file = join(directory, 'package.tgz');
    writeFileSync(file, bytes, { mode:0o600 });
    const pkg = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding:'utf8' }));
    const config = execFileSync('tar', ['-xOf', file, 'package/dist/src/state/config.js'], { encoding:'utf8' });
    if (pkg.gitHead !== approved.sha) throw new Error('Published package source mismatch');
    checkPackage(pkg, config, approved);
  } finally { rmSync(directory, { recursive:true, force:true }); }
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
  const action = process.env.RELEASE_ACTION || 'publish';
  if (action === 'readback') {
    const manifest = process.env.RELEASE_MANIFEST ? JSON.parse(readFileSync(process.env.RELEASE_MANIFEST, 'utf8')) : undefined;
    if (manifest && (manifest.source !== process.env.GITHUB_SHA || manifest.channel !== 'next' || !/^[a-f0-9]{64}$/.test(manifest.sha256))) {
      throw new Error('Readback manifest does not match the original publish source');
    }
    const target = releaseTarget({ event:process.env.GITHUB_EVENT_NAME, action, tag:process.env.RELEASE_TAG, version:manifest?.version || process.env.RELEASE_VERSION });
    const selected = manifest ? {gitHead:manifest.source} : await waitForPublishedRead(timeout => metadata(target.version, timeout));
    if (!/^[a-f0-9]{40}$/.test(selected?.gitHead ?? '')) throw new Error('Exact published version has no trusted source');
    execFileSync('git', ['merge-base','--is-ancestor',selected.gitHead,process.env.GITHUB_SHA]);
    const actual = await readPublished(target, selected.gitHead);
    await verifyPublishedArtifact(actual, {version:target.version,sha:selected.gitHead,sha256:manifest?.sha256});
    const result = `Read-only registry verification: @itpay/cli@${actual.version} → ${target.channel} (${actual.gitHead}).`;
    console.log(result);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,result+'\n');
    return;
  }
  let artifact, publishFile;
  if (action === 'publish') {
    const source = releaseSource({ mainSha: process.env.GITHUB_SHA, tag: process.env.RELEASE_TAG, action });
    artifact = JSON.parse(readFileSync('release-artifact/manifest.json', 'utf8'));
    if (artifact.source !== source.sha || artifact.workflow !== process.env.GITHUB_SHA || artifact.channel !== source.channel
      || artifact.file !== `itpay-cli-${artifact.version}.tgz`) throw new Error('Artifact source does not match trusted workflow');
    publishFile = resolve('release-artifact', artifact.file);
    if (createHash('sha256').update(readFileSync(publishFile)).digest('hex') !== artifact.sha256) throw new Error('Artifact checksum mismatch');
    const packed = JSON.parse(execFileSync('tar', ['-xOf', publishFile, 'package/package.json'], { encoding: 'utf8' }));
    if (packed.gitHead !== source.sha || packed.version !== artifact.version) throw new Error('Packed source identity mismatch');
    checkPackage(packed, execFileSync('tar', ['-xOf', publishFile, 'package/dist/src/state/config.js'], { encoding: 'utf8' }), {version:artifact.version});
  }
  const target = releaseTarget({ event:process.env.GITHUB_EVENT_NAME, action, tag:process.env.RELEASE_TAG, version:artifact?.version || process.env.RELEASE_VERSION });
  const existing = await metadata(target.version);
  const npm = args => execFileSync('npm', args, { stdio: 'inherit' });
  if (action === 'publish') {
    if (existing) throw new Error('Version already exists; inspect the original publication or explicitly promote, never overwrite');
    npm(['publish', publishFile, '--ignore-scripts', '--access', 'public', '--tag', target.channel]);
    console.log(`npm accepted @itpay/cli@${target.version}; the read-only job will verify registry and dev visibility.`);
    return;
  } else {
    if (!existing) throw new Error('Selected version does not exist');
    if (action === 'verify') {
      if ((await metadata(target.channel))?.version !== target.version) throw new Error('Verify refuses to move a tag');
      await verifyOidcTag(target.channel, target.version);
    } else {
      if (!/^[a-f0-9]{40}$/.test(existing.gitHead)) throw new Error('Published source is missing');
      execFileSync('git', ['merge-base', '--is-ancestor', existing.gitHead, process.env.GITHUB_SHA]);
      const pkg = JSON.parse(execFileSync('git', ['show', `${existing.gitHead}:package.json`], {encoding:'utf8'}));
      if (pkg.version !== target.version) throw new Error('Published version differs from main source');
      await verifyPublishedArtifact(existing, {sha:existing.gitHead,version:target.version});
      npm(['dist-tag', 'add', `@itpay/cli@${target.version}`, target.channel]);
    }
  }
  const actual = await metadata(target.channel);
  if (actual?.version !== target.version) throw new Error('Registry readback differs; inspect before retrying');
  const message = `${action}: @itpay/cli@${actual.version} → ${target.channel}; registry verified.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message+'\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    if (process.env.RELEASE_ACTION === 'readback' && error instanceof PublicationVisibilityTimeout) {
      const warning = error.message + '. Run the read-only release workflow with action=readback and the exact version.';
      console.warn('::warning::' + warning);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, warning + '\n');
      return;
    }
    console.error(error.message);
    process.exitCode = 1;
  });
}
