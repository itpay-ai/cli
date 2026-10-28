import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withAsyncFileLock} from '../src/state/file_lock.js';

test('refresh does not steal a newly created lock before its owner writes the token',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'itpay-refresh-lock-'));const lock=join(dir,'refresh.lock');
 // wx creation and owner-token write are separate filesystem operations.
 writeFileSync(lock,'',{flag:'wx',mode:0o600});let released=false;
 const release=setTimeout(()=>{assert.equal(readFileSync(lock,'utf8'),'');released=true;unlinkSync(lock)},100);
 try{await withAsyncFileLock(lock,async()=>assert.equal(released,true,'must not enter another owner’s unfinished lock'))}
 finally{clearTimeout(release);rmSync(dir,{recursive:true,force:true})}
});
