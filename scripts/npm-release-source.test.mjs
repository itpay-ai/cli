import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSource, checkPackage } from './npm-release-source.mjs';
import { verifyPublishedArtifact } from './npm-release.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('maintenance source is fixed by reviewed main policy, never an arbitrary ref', () => {
  const mainSha = 'a'.repeat(40), sha = 'b'.repeat(40), api = `sha256:${'c'.repeat(64)}`;
  const approvals = { prod: { sha, version: '2.1.41', api, sha256: 'e'.repeat(64) } };
  assert.deepEqual(releaseSource({ source: 'prod', mainSha, approvals }), { ...approvals.prod, channel: 'candidate-prod' });
  assert.equal(releaseSource({ source: 'main', mainSha, approvals }).sha, mainSha);
  for (const source of ['external/ref', sha, 'dev']) assert.throws(() => releaseSource({ source, mainSha, approvals }));
  assert.throws(() => releaseSource({ source: 'prod', mainSha, approvals: { prod: { ...approvals.prod, sha: 'branch' } } }));
  const pkg = { name: '@itpay/cli', version: '2.1.41' };
  assert.equal(checkPackage(pkg, `export const API_CONTRACT_REVISION = "${api}";`, approvals.prod), api);
  assert.throws(() => checkPackage({ ...pkg, version: '2.1.40' }, `API_CONTRACT_REVISION = "${api}"`, approvals.prod));
  assert.throws(() => checkPackage(pkg, `API_CONTRACT_REVISION = "sha256:${'d'.repeat(64)}"`, approvals.prod));
});

test('protected publisher rejects changed artifacts; promotion reads the approved registry bytes and API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'itpay-publisher-check-'));
  try {
    const sha = 'a'.repeat(40), api = `sha256:${'c'.repeat(64)}`, version = '2.1.41';
    mkdirSync(join(root, 'package/dist/src/state'), { recursive: true });
    mkdirSync(join(root, 'release-artifact'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@itpay/cli', version }));
    const file = `itpay-cli-${version}.tgz`, tarball = join(root, 'release-artifact', file);
    const run = (gitHead, compiledApi, checksum) => {
      writeFileSync(join(root, 'package/package.json'), JSON.stringify({ name: '@itpay/cli', version, gitHead }));
      writeFileSync(join(root, 'package/dist/src/state/config.js'), `export const API_CONTRACT_REVISION = "${compiledApi}";`);
      execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
      const sha256 = checksum || createHash('sha256').update(readFileSync(tarball)).digest('hex');
      writeFileSync(join(root, 'release-artifact/manifest.json'), JSON.stringify({source: sha, workflow: sha, version, api, file, sha256, channel:'candidate-dev'}));
      return spawnSync(process.execPath, [fileURLToPath(new URL('./npm-release.mjs', import.meta.url))], {
        cwd: root, encoding:'utf8', env: { PATH:process.env.PATH, GITHUB_SHA:sha, RELEASE_ACTION:'stage', RELEASE_SOURCE:'main' }, timeout:3000,
      });
    };
    for (const [args, reason] of [
      [[sha, api, '0'.repeat(64)], 'Artifact checksum mismatch'],
      [['b'.repeat(40), api], 'Packed source identity mismatch'],
      [[sha, `sha256:${'d'.repeat(64)}`], 'Packed API does not match recorded artifact'],
    ]) {
      const result = run(...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(reason));
    }
    writeFileSync(join(root, 'package/dist/src/state/config.js'), `export const API_CONTRACT_REVISION = "${api}";`);
    execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
    const bytes = readFileSync(tarball);
    const approved = { sha, version, api, sha256:createHash('sha256').update(bytes).digest('hex') };
    const existing = { gitHead:sha, version, dist: {
      tarball:'https://registry.npmjs.org/@itpay/cli/-/cli-2.1.41.tgz',
      integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    } };
    const request = async () => new Response(bytes);
    await verifyPublishedArtifact(existing, approved, request);
    await assert.rejects(verifyPublishedArtifact(existing, {...approved, sha256:'0'.repeat(64)}, request), /approved hash/);
    await assert.rejects(verifyPublishedArtifact(existing, {...approved, api:`sha256:${'d'.repeat(64)}`}, request), /API/);
    await assert.rejects(verifyPublishedArtifact({...existing, dist:{...existing.dist, integrity:'sha512-bad'}}, approved, request), /integrity/);
    await assert.rejects(verifyPublishedArtifact({...existing, dist:{...existing.dist, tarball:'https://external.example/pkg'}}, approved,
      async () => { assert.fail('External artifact must not be requested'); }), /origin/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
