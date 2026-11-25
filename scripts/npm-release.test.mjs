import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseTarget, verifyOidcTag, readPublished } from './npm-release.mjs';

test('manual next publish and same-version promotion reject retired routes and version lines', () => {
  assert.equal(releaseTarget({event:'workflow_dispatch',tag:'next',version:'0.2.70'}).channel,'next');
  assert.equal(releaseTarget({event:'workflow_dispatch',action:'promote',tag:'latest',version:'0.2.70'}).action,'promote');
  assert.equal(releaseTarget({event:'workflow_dispatch',action:'readback',tag:'next',version:'0.2.85'}).action,'readback');
  for(const input of [
    {event:'workflow_dispatch',action:'readback',tag:'latest',version:'0.2.85'},
    {event:'push',tag:'next',version:'0.2.70'},
    {event:'workflow_dispatch',action:'stage',tag:'candidate-dev',version:'0.2.70'},
    {event:'workflow_dispatch',tag:'latest',version:'0.2.70'},
    ...['2.1.70','1.0.0','0.3.0','0.2.70-rc.1','next'].map(version=>({event:'workflow_dispatch',tag:'next',version})),
  ])assert.throws(()=>releaseTarget(input));
});

test('OIDC verification requires exchange and a real same-value write, failing closed', async () => {
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://issuer.example/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-test' };
  const run = async (responses) => {
    const calls = [];
    const promise = verifyOidcTag('next', '0.2.70', async (url, options) => {
      calls.push({url: String(url), ...options});
      const value = responses.shift();
      return {ok: value !== 403, status: value === 403 ? 403 : 200, json: async () => value};
    }, env);
    return {promise, calls};
  };
  const success = await run([{value:'identity-test'}, {token:'exchange-test'}, {next:'0.2.70'}, {}]);
  await success.promise;
  assert.equal(success.calls[3].method, 'PUT');
  assert.equal(success.calls[3].body, '"0.2.70"');
  assert.equal(success.calls[3].headers.Authorization, 'Bearer exchange-test');
  for (const responses of [[403], [{value:'id'},403], [{value:'id'},{token:'token'},{next:'0.2.71'}], [{value:'id'},{token:'token'},{next:'0.2.70'},403]]) {
    const failed = await run(responses);
    await assert.rejects(failed.promise);
  }
});

test('accepted publication waits only for visibility and never retries a refused lookup', async () => {
  const target = {channel:'next',version:'0.2.70'}, source = 'reviewed-main';
  const values = [null, {version:'2.1.69'}, {version:'0.2.70',gitHead:source}];
  let reads = 0, pauses = 0;
  const actual = await readPublished(target, source, async tag => {assert.equal(tag,'next'); reads++; return values.shift();}, async ms => {assert.equal(ms,5000); pauses++;});
  assert.equal(actual.gitHead,source); assert.equal(reads,3); assert.equal(pauses,2);
  await assert.rejects(readPublished(target, source, async () => ({version:'0.2.70',gitHead:'other'}), async () => assert.fail('must stop')), /source differs/);
  let refused = 0;
  await assert.rejects(readPublished(target, source, async () => {refused++; throw Error('HTTP 403');}, async () => assert.fail('must stop')), /HTTP 403/);
  assert.equal(refused,1);
  let bounded = 0, clock = 0;
  await assert.rejects(readPublished(target, source, async () => {bounded++; return null;}, async ms => {clock += ms;}, () => clock), /inspect the original publication/);
  assert.equal(bounded,96);
  assert.equal(clock,480000);
});
