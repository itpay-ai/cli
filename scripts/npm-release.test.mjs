import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseTarget, verifyOidcTag } from './npm-release.mjs';

test('manual next publish and same-version promotion reject retired routes and version lines', () => {
  assert.equal(releaseTarget({event:'workflow_dispatch',tag:'next',version:'0.2.70'}).channel,'next');
  assert.equal(releaseTarget({event:'workflow_dispatch',action:'promote',tag:'latest',version:'0.2.70'}).action,'promote');
  for(const input of [
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
