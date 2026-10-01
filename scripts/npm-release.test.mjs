import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseTarget, verifyOidcTag } from './npm-release.mjs';

test('explicit channel, stable promotion, unchanged pushes and invalid targets', () => {
  assert.equal(releaseTarget({event:'push',declaredTag:'next',version:'2.1.30',previousVersion:'2.1.29'}).channel,'next');
  assert.equal(releaseTarget({event:'push',declaredTag:'next',version:'2.1.29',previousVersion:'2.1.29'}).skip,true);
  assert.equal(releaseTarget({event:'workflow_dispatch',action:'promote',tag:'latest',version:'2.1.29'}).action,'promote');
  for (const input of [
    {event:'push',version:'2.1.30'},
    {event:'workflow_dispatch',tag:'general',version:'2.1.30'},
    {event:'workflow_dispatch',tag:'latest',version:'2.1.30-rc.1'},
    {event:'workflow_dispatch',tag:'next',version:'next'},
    {event:'workflow_dispatch',action:'delete',tag:'next',version:'2.1.30'},
  ]) assert.throws(() => releaseTarget(input));
});


test('OIDC verification requires exchange and a real same-value write, failing closed', async () => {
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://issuer.example/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-test' };
  const run = async (responses) => {
    const calls = [];
    const promise = verifyOidcTag('next', '2.1.29', async (url, options) => {
      calls.push({url: String(url), ...options});
      const value = responses.shift();
      return {ok: value !== 403, status: value === 403 ? 403 : 200, json: async () => value};
    }, env);
    return {promise, calls};
  };
  const success = await run([{value:'identity-test'}, {token:'exchange-test'}, {next:'2.1.29'}, {}]);
  await success.promise;
  assert.equal(success.calls[3].method, 'PUT');
  assert.equal(success.calls[3].body, '"2.1.29"');
  assert.equal(success.calls[3].headers.Authorization, 'Bearer exchange-test');
  for (const responses of [[403], [{value:'id'},403], [{value:'id'},{token:'token'},{next:'2.1.30'}], [{value:'id'},{token:'token'},{next:'2.1.29'},403]]) {
    const failed = await run(responses);
    await assert.rejects(failed.promise);
  }
});
