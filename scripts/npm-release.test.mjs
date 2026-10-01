import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseTarget } from './npm-release.mjs';

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
