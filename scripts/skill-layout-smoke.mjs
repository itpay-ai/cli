import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

// Exercise the actual compiled entry with one registered canonical root, without
// a duplicate discoverable markdown or a patch to the pinned runtime payload.
export function verifyCanonicalSkillLayout(packageRoot,scratch){
 const payload=join(scratch,'payload'),root=join(scratch,'skill'),state=join(scratch,'state');
 mkdirSync(join(payload,'dist/src/state'),{recursive:true});mkdirSync(root,{recursive:true});
 for(const path of ['package.json','dist/src/main.js','dist/src/state/config.js'])copyFileSync(join(packageRoot,path),join(payload,path));
 const canonical=readFileSync(join(packageRoot,'skills/itpay/SKILL.md'),'utf8');writeFileSync(join(root,'SKILL.md'),canonical);
 const env={...process.env,ITPAY_STATE_DIR:state,ITPAY_CLI_SKILLS_DIR:root};
 const run=()=>execFileSync(process.execPath,[join(payload,'dist/src/main.js'),'--agent-type','dot','skill','show','itpay','--json'],{env,encoding:'utf8',stdio:'pipe'});
 assert.equal(JSON.parse(run()).result.content,canonical);
 writeFileSync(join(root,'SKILL.md'),canonical+'\nUnapproved replacement instruction.\n');
 assert.throws(run,error=>{assert.equal(JSON.parse(String(error.stdout||error.stderr)).error.code,'skill_override_mismatch');return true;});
 writeFileSync(join(root,'SKILL.md'),canonical);
 assert.equal(JSON.parse(run()).result.content,canonical);
 return {canonicalRoot:true,duplicateMarkdownRequired:false,modifiedSkillRejected:true,identityAccessed:false};
}
