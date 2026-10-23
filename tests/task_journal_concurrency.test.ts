import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readdirSync,statSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {TaskJournal} from '../src/state/task_journal.js';
test('independent real CLI processes retain A/B/C and every shared wait debit',async()=>{
 const root=mkdtempSync(join(tmpdir(),'itpay-tasks-fixture-')),path=join(root,'tasks.json');
 try{
  const journal=new TaskJournal(path);journal.record({service_execution_id:'shared-original',stage:'running'});
  await Promise.all(['A','B','C','D','E','F'].map(id=>new Promise<void>((done,reject)=>{
   const child=spawn(resolve('node_modules/.bin/tsx'),[resolve('tests/task_journal_child.ts'),path,id],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',s=>{error+=s});child.on('error',reject);child.on('close',code=>code===0?done():reject(Error(error)));
  })));
  assert.deepEqual(new Set(journal.pausedTasks().map(t=>t.service_execution_id)),new Set(['A','B','C','D','E','F']));
  assert.equal(journal.remainingAutomaticWait('shared-original'),114000);
  assert.equal(statSync(path+'.d').mode&0o777,0o700);
  for(const file of readdirSync(path+'.d'))assert.equal(statSync(join(path+'.d',file)).mode&0o777,0o600);
  journal.observe('A','completed');journal.observe('A','login_required');assert(!journal.pausedTasks().some(t=>t.service_execution_id==='A'));
  journal.clear('shared-original');journal.record({service_execution_id:'shared-original',stage:'login_required'});assert.equal(journal.remainingAutomaticWait('shared-original'),114000);
 }finally{rmSync(root,{recursive:true});}
});
test('legacy records remain unchanged and corrupt immutable state fails closed',()=>{
 const root=mkdtempSync(join(tmpdir(),'itpay-tasks-legacy-')),path=join(root,'tasks.json');
 try{
  const legacy=JSON.stringify({schema_version:'itpay.task_journal.v1',tasks:{original:{service_execution_id:'original',stage:'login_required',updated_at:new Date().toISOString(),automatic_wait_ms:1000}}});writeFileSync(path,legacy,{mode:0o600});
  const journal=new TaskJournal(path);journal.record({service_execution_id:'new',stage:'login_required'});assert.equal(readFileSync(path,'utf8'),legacy);assert.equal(journal.remainingAutomaticWait('original'),119000);
  writeFileSync(join(path+'.d','.orphan.tmp'),'{');assert.equal(journal.pausedTasks().length,2);
  writeFileSync(join(path+'.d','corrupt.json'),'{');assert.equal(journal.remainingAutomaticWait('original'),0);assert.throws(()=>journal.record({service_execution_id:'other',stage:'running'}),/journal is invalid/);assert.equal(readFileSync(path,'utf8'),legacy);
 }finally{rmSync(root,{recursive:true});}
});
