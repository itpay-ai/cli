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

test('only checked main publishes next; diagnostic hash does not gate an otherwise matching package',()=>{
 const mainSha='a'.repeat(40);assert.deepEqual(releaseSource({mainSha}),{sha:mainSha,channel:'next'});
 for(const input of [{source:'dev'},{source:'prod'},{source:'external/ref'},{tag:'latest'},{action:'stage'}])assert.throws(()=>releaseSource({mainSha,...input}));
 const pkg={name:'@itpay/cli',version:'0.2.70'};
 assert.equal(checkPackage(pkg,'export const CLI_VERSION = "0.2.70"; export const API_CONTRACT_REVISION = "diagnostic";'),'diagnostic');
 for(const version of ['2.1.70','1.0.0','0.3.0'])assert.throws(()=>checkPackage({...pkg,version},`CLI_VERSION = "${version}"`));
 assert.throws(()=>checkPackage(pkg,'CLI_VERSION = "0.2.71"'));
});

test('protected publisher rejects changed artifacts; promotion reads the approved registry bytes and source identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'itpay-publisher-check-'));
  try {
    const sha = 'a'.repeat(40), api = `sha256:${'c'.repeat(64)}`, version = '0.2.70';
    mkdirSync(join(root, 'package/dist/src/state'), { recursive: true });
    mkdirSync(join(root, 'release-artifact'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@itpay/cli', version }));
    const file = `itpay-cli-${version}.tgz`, tarball = join(root, 'release-artifact', file);
    const run = (gitHead, compiledApi, checksum, action = 'publish') => {
      writeFileSync(join(root, 'package/package.json'), JSON.stringify({ name: '@itpay/cli', version, gitHead }));
      writeFileSync(join(root, 'package/dist/src/state/config.js'), `export const CLI_VERSION = "${version}"; export const API_CONTRACT_REVISION = "${compiledApi}";`);
      execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
      const sha256 = checksum || createHash('sha256').update(readFileSync(tarball)).digest('hex');
      writeFileSync(join(root, 'release-artifact/manifest.json'), JSON.stringify({source: sha, workflow: sha, version, api, file, sha256, channel:'next'}));
      return spawnSync(process.execPath, [fileURLToPath(new URL('./npm-release.mjs', import.meta.url))], {
        cwd: root, encoding:'utf8', env: { PATH:process.env.PATH, GITHUB_SHA:sha, RELEASE_ACTION:action, GITHUB_EVENT_NAME:'workflow_dispatch', RELEASE_TAG:'next' }, timeout:3000,
      });
    };
    for (const [args, reason] of [
      [[sha, api, '0'.repeat(64)], 'Artifact checksum mismatch'],
      [['b'.repeat(40), api], 'Packed source identity mismatch'],
    ]) {
      for (const action of ['publish']) {
        const result = run(args[0], args[1], args[2], action);
        assert.equal(result.status, 1);
        assert.match(result.stderr, new RegExp(reason));
      }
    }
    writeFileSync(join(root, 'package/package.json'),JSON.stringify({name:'@itpay/cli',version,gitHead:sha}));
    writeFileSync(join(root, 'package/dist/src/state/config.js'), `export const CLI_VERSION = "${version}"; export const API_CONTRACT_REVISION = "${api}";`);
    execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
    const bytes = readFileSync(tarball);
    const approved = { sha, version, api, sha256:createHash('sha256').update(bytes).digest('hex') };
    const existing = { gitHead:sha, version, dist: {
      tarball:'https://registry.npmjs.org/@itpay/cli/-/cli-0.2.70.tgz',
      integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    } };
    const request = async () => new Response(bytes);
    await verifyPublishedArtifact(existing, approved, request);
    await assert.rejects(verifyPublishedArtifact(existing, {...approved, sha256:'0'.repeat(64)}, request), /approved hash/);
    await verifyPublishedArtifact(existing, {...approved, api:'changed-diagnostic'}, request);
    await assert.rejects(verifyPublishedArtifact({...existing, dist:{...existing.dist, integrity:'sha512-bad'}}, approved, request), /integrity/);
    await assert.rejects(verifyPublishedArtifact({...existing, dist:{...existing.dist, tarball:'https://external.example/pkg'}}, approved,
      async () => { assert.fail('External artifact must not be requested'); }), /origin/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
