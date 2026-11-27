import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const old = resolve(process.argv[2]);
const candidate = resolve(process.argv[3]);
const oldIntegrity = 'OO8OaJl/6L42HIjWEl3tjslB9wHxmGIzG8SjkQFaQnyHb3QVa8dE3LQki0JPBZp94hciKl0L1VoHHiqMrldAlA==';
assert.equal(createHash('sha512').update(readFileSync(old)).digest('base64'), oldIntegrity);
const scratch = mkdtempSync(join(tmpdir(), 'itpay-original-upgrade-'));
const prefix = join(scratch, 'npm');
const install = join(scratch, 'original-profile');
const entry = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@itpay/cli/bin/itp.mjs');
const npm = process.env.npm_execpath;
assert.ok(npm, 'run as an npm script to use the original npm executable');
const digest = text => createHash('sha256').update(text).digest('hex');
const request = 'windows-original-fixture';
const serverRequest = 'cli-req-' + request;
const run = 'run-original-fixture';
const operation = 'op-original-fixture';
const publication = 'pub-original-fixture';
const buyer = 'buyer-original-fixture';
const consumer = 'oauth:fixture-cli:original';
const access = 'synthetic-access-original-fixture';
const calls = [];
const server = createServer((req, res) => {
  const allowed = req.method === 'GET' && req.headers.authorization === 'Bearer ' + access;
  calls.push({ method: req.method, path: req.url, allowed });
  res.setHeader('Content-Type', 'application/json');
  if (!allowed) {
    res.writeHead(403).end('{}'); return;
  }
  if (req.url === '/v1/me') {
    res.end(JSON.stringify({ buyer_id: buyer, consumer_id: consumer })); return;
  }
  if (req.url === '/v1/requests/' + serverRequest) {
    res.end(JSON.stringify({ request_id: serverRequest, terminal: true, run: {
      run_id: run, operation_id: operation, publication_id: publication, execution_state: 'succeeded',
      settlement_state: 'captured', delivery_state: 'inline', held_atoms: '0', captured_atoms: '1000', result: { fixture: true },
    } })); return;
  }
  res.writeHead(404).end('{}');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = 'http://127.0.0.1:' + server.address().port;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ITPAY_|MONID_)/.test(k))),
  ITPAY_HUB_URL: base, ITPAY_HUB_OAUTH_ISSUER: base, ITPAY_HUB_OAUTH_CLIENT: 'fixture-cli',
};
const unpack = tarball => execFileSync(process.execPath, [
  npm, 'install', '--global', '--prefix', prefix, '--force', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball,
], { stdio: 'pipe' });
const invoke = (args, extra = {}) => new Promise((done, reject) => {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b);
  child.stderr.on('data', b => stderr += b);
  child.on('error', reject);
  child.on('close', status => done({ status, stdout, stderr }));
});
const success = (result, label) => {
  assert.equal(result.status, 0, label + ': ' + (result.stderr || result.stdout).slice(0, 230) + JSON.stringify(calls));
  return JSON.parse(result.stdout);
};
const assertReceipt = value => {
  assert.equal(value.result.run_id, run);
  assert.equal(value.result.captured_atoms, '1000');
  assert.equal(value.result.held_atoms, '0');
};

try {
  unpack(old);
  const built = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@itpay/cli/dist/src/main.js');
  const oldHash = digest(readFileSync(built));
  assert.match((await invoke(['--version'])).stdout, /0\.2\.92/);
  if (process.platform === 'win32') {
    // A pre-existing private NTFS fixture, as required by the candidate.
    mkdirSync(install);
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-(?:\d+-)*\d+/)?.[0];
    assert.ok(sid);
    execFileSync('icacls.exe', [install, '/grant:r', '*' + sid + ':(OI)(CI)F'], { stdio: 'pipe' });
    execFileSync('icacls.exe', [install, '/inheritance:r'], { stdio: 'pipe' });
  }
  const selector = success(await invoke(['setup', '--api-prefix', install, '--json']), 'old installed setup').result.selector;
  const selectorBytes = readFileSync(selector);
  const profile = JSON.parse(selectorBytes);
  const state = join(profile.state_root, 'hub-profiles', profile.profile_id);
  const ownerScope = digest(JSON.stringify([base, JSON.stringify(['oauth', buyer, consumer])]));
  const journal = join(state, 'hub-tasks', 'scope-' + ownerScope);
  mkdirSync(journal, { recursive: true, mode: 0o700 });
  const credentials = join(state, 'hub-credentials.' + digest(base).slice(0,12) + '.json');
  const time = new Date().toISOString();
  writeFileSync(credentials, JSON.stringify({ schema_version: 'itpay.hub_credentials.v1', profiles: { default: {
    base_url: base, subject: buyer, consumer_id: consumer, client_id: 'fixture-cli', token_url: base + '/oauth2/token',
    access_token: access, refresh_token: 'synthetic-refresh-original-fixture', expires_at: '2099-01-01T00:00:00Z', created_at: time,
  } } }), { mode: 0o600 });
  const task = join(journal, request + '.json');
  writeFileSync(task, JSON.stringify({ request_id: request, operation_id: operation, publication_id: publication, run_id: run,
    input: {}, input_digest: digest([operation, publication, '{}', '1000'].join('\0')), max_charge_atoms: '1000',
    status: 'unknown', admission_attempted: true, hub_origin: base, created_at: time, updated_at: time,
  }), { mode: 0o600 });
  const args = ['api', '--profile', selector, 'status', request, '--json'];
  const oldSelected = await invoke(args);
  if (process.platform === 'win32') {
    assert.equal(oldSelected.status, 1);
    assert.match(oldSelected.stderr, /API profile must be a private regular file/);
    assertReceipt(success(await invoke(['api', 'status', request, '--json'], { ITPAY_STATE_DIR: state }), 'old receipt via old state'));
  } else {
    assertReceipt(success(oldSelected, 'old receipt via old selector'));
  }
  const originalOwner = readFileSync(credentials);
  const callCount = calls.length;
  unpack(candidate);
  assert.notEqual(digest(readFileSync(built)), oldHash, 'npm must install new bytes at the same installed path');
  assertReceipt(success(await invoke(args), 'candidate receipt via original selector'));
  assert.deepEqual(readFileSync(selector), selectorBytes);
  assert.deepEqual(readFileSync(credentials), originalOwner);
  const stored = JSON.parse(readFileSync(task));
  assert.equal(stored.request_id, request);
  assert.equal(stored.run_id, run);
  assert.equal(stored.publication_id, publication);
  assert.ok(calls.length > callCount && calls.every(c => c.method === 'GET' && c.allowed));
  assert.equal(calls.filter(c => c.path === '/v1/requests/' + serverRequest).length, 2);
  process.stdout.write(JSON.stringify({ old: '0.2.92', sameNpmPrefix: true, oldSelectorRejectedOnWindows: process.platform === 'win32',
    sameSelector: true, sameBuyerAndConsumer: true, sameRequestAndRun: true, receiptReads: 2, supplierSends: 0,
    businessPosts: 0, originalCapturedAtoms: '1000', heldAtoms: '0' }) + '\n');
} finally {
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
}
