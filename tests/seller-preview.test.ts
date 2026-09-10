import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localAction } from '../src/sell/local.js';
import { preview } from '../src/sell/preview.js';

test('local preview requires its token, is read-only, and serves input as data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'itpay-preview-'));
  await localAction('init', directory, {serviceId:'test',name:'Preview'});
  writeFileSync(join(directory, 'workflow.yaml'), '<script>not executable</script>');
  const server = await preview(directory);
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await page.text(), /工作流预览/);
    const document = await fetch(new URL('document', server.url));
    assert.equal(document.headers.get('content-type'), 'application/json');
    const data = await document.json() as {document:string;version:string};
    assert.equal(data.document, '<script>not executable</script>');
    assert.equal(data.version, 'Unsaved');
    assert.equal((await fetch(new URL('/document', server.url))).status, 404);
    assert.equal((await fetch(server.url, {method:'POST'})).status, 404);
    assert.equal((await fetch(new URL('missing-file', server.url))).status, 404);
  } finally { server.close(); rmSync(directory, {recursive:true,force:true}); }
});
