import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDir, cartSessionPath, taskJournalPath } from '../dist/src/state/config.js';
import { sellerAuthPath } from '../dist/src/state/account_auth.js';
import { DeviceAuthority } from '../dist/src/state/device_authority.js';
const root=mkdtempSync(join(tmpdir(),'itpay-local-state-'));
try {
 process.env.ITPAY_STATE_DIR=root;
 const env={ITPAY_STATE_DIR:root,ITPAY_CLI_DEV:'1',ITPAY_BACKEND_URL:'http://127.0.0.1:18081'};
 for(const p of [stateDir(env),cartSessionPath(env),taskJournalPath(env),sellerAuthPath(env.ITPAY_BACKEND_URL,env)])assert.ok(p.startsWith(root));
 const authority=new DeviceAuthority({baseURL:env.ITPAY_BACKEND_URL,compatibilityHeaders:{}});
 assert.ok(authority.statePath.startsWith(root));assert.ok(authority.privateKeyPath.startsWith(root));
 console.log('isolated state: device/key/cart/journal/auth');
} finally {delete process.env.ITPAY_STATE_DIR;rmSync(root,{recursive:true});}
