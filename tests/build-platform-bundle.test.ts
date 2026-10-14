import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("platform bundle directory cannot escape or replace the Skill", () => {
  for (const directory of ["../outside", ".", "/tmp/outside", "C:\\outside"]) {
    const result = spawnSync(process.execPath, [
      resolve("scripts/build-platform-bundle.mjs"),
      "1.2.3",
      "/tmp/unused",
      "--bundle-directory",
      directory,
    ], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bundle directory must be a relative path inside the Skill/);
  }
});

test('bundle rebuild deletes old handoff tutorials and is idempotent',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const directory=mkdtempSync(join(tmpdir(),'itpay-bundle-content-'));try{
  const source=join(directory,'package');mkdirSync(join(source,'dist/src'),{recursive:true});mkdirSync(join(source,'skills/itpay'),{recursive:true});
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'@itpay/cli',version:'1.2.3',itpayBundleFormat:'buyer-esm-v1',engines:{node:'>=18'}}));writeFileSync(join(source,'dist/src/main.js'),'console.log("1.2.3");');writeFileSync(join(source,'skills/itpay/SKILL.md'),'# ItPay\n\nCurrent shared business flow.\n');
  const tar=join(directory,'candidate.tgz');assert.equal(spawnSync('tar',['-czf',tar,'-C',directory,'package']).status,0);
  const host=join(directory,'host');mkdirSync(host);writeFileSync(join(host,'SKILL.md'),'---\nname: itpay\n---\n# ItPay\n\n## WorkBuddy Runtime\nUse the locked launcher.\n\n### WorkBuddy Checkout handoff\nFor an older handoff use present_files.\n\n### WorkBuddy Checkout handoff\nFor an older handoff use present_files.\n\n## Local CLI business rules\nOld duplicated tutorial.\n');
  const build=()=>{const result=spawnSync(process.execPath,[resolve('scripts/build-platform-bundle.mjs'),'1.2.3',host,'--tarball',tar],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return readFileSync(join(host,'SKILL.md'),'utf8');};
  const first=build(),second=build();assert.equal(second,first);assert.match(first,/WorkBuddy Runtime/);assert.match(first,/Current shared business flow/);assert.doesNotMatch(first,/older handoff|Old duplicated tutorial|WorkBuddy Checkout handoff/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
