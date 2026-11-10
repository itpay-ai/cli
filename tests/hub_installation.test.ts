import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareHubInstallation, qualifyHubInstallation, selectHubInstallation, shellQuote } from "../src/state/hub_installation.js";

test("host installs have stable independent private selectors and a fixed launcher", () => {
  const directory = mkdtempSync(join(tmpdir(), "itpay-api-installation-"));
  try {
    const fixture = join(directory, "capture.cjs");
    writeFileSync(fixture, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const first = prepareHubInstallation(join(directory, "Agent's A"), fixture);
    assert.deepEqual(prepareHubInstallation(join(directory, "Agent's A"), fixture), first);
    const other = prepareHubInstallation(join(directory, "Agent B"), fixture);
    assert.notEqual(first.profile_id, other.profile_id);
    assert.equal(statSync(first.selector).mode & 0o777, 0o600);
    assert.equal(statSync(first.launcher).mode & 0o777, 0o700);
    assert.equal(JSON.parse(readFileSync(first.selector, "utf8")).profile_id, first.profile_id);
    const launch = spawnSync(first.launcher, ["api", "doctor", "--json"], { encoding: "utf8" });
    assert.equal(launch.status, 0);
    assert.deepEqual(JSON.parse(launch.stdout), ["api", "--profile", first.selector, "doctor", "--json"]);
    assert.equal(spawnSync(first.launcher, ["doctor", "--profile", other.selector]).status, 2);
    const duplicate = spawnSync(first.launcher, ["api", "--profile", first.selector, "doctor", "--json"], {encoding:"utf8"});
    assert.equal(duplicate.status,0,duplicate.stderr);
    assert.deepEqual(JSON.parse(duplicate.stdout),["api","--profile",first.selector,"doctor","--json"]);
    for(const argv of [["--agent-type","muse","api","doctor"],["api","doctor","--agent-type","muse"],["--agent-type=muse","api","doctor"]]){
      const invoked=spawnSync(first.launcher,argv,{encoding:"utf8"});
      assert.equal(invoked.status,0,invoked.stderr);
      const expanded=JSON.parse(invoked.stdout);
      assert.equal(expanded.filter((v:string)=>v==="api").length,1);
      assert.ok(expanded.includes("doctor"));
      assert.ok(expanded.includes("muse")||expanded.includes("--agent-type=muse"));
    }
    const forward = `const {spawnSync}=require('node:child_process');const [exe,selector,...input]=process.argv.slice(1);if(['api','hub'].includes(input[0]))input.shift();const args=[];for(let i=0;i<input.length;i++){let v;if(input[i]==='--profile')v=input[++i];else if(input[i].startsWith('--profile='))v=input[i].slice(10);else {args.push(input[i]);continue;}if(v!==selector){process.stderr.write('profile_mismatch: this launcher belongs to '+selector+'\\n');process.exit(2);}}const r=spawnSync(process.execPath,[exe,'api','--profile',selector,...args],{stdio:'inherit'});if(r.error){process.stderr.write(r.error.message+'\\n');process.exit(1);}process.exit(r.status??1);`;
    const previous = `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e ${shellQuote(forward)} ${shellQuote(fixture)} ${shellQuote(first.selector)} "$@"\n`;
    writeFileSync(first.launcher,previous,{mode:0o700});
    prepareHubInstallation(join(directory,"Agent's A"),fixture);
    assert.notEqual(readFileSync(first.launcher,"utf8"),previous);
    const foreign=spawnSync(first.launcher,["doctor","--profile",other.selector],{encoding:"utf8"});
    assert.match(foreign.stderr,/profile_mismatch/);
    selectHubInstallation(first.selector);
    assert.match(process.env.ITPAY_STATE_DIR ?? "", new RegExp(first.profile_id + "$"));
    assert.equal(qualifyHubInstallation("itpay --agent-type codex-desktop api doctor"),
      `itpay --agent-type codex-desktop api --profile ${shellQuote(first.selector)} doctor`);
    assert.equal(qualifyHubInstallation("itpay services list"), undefined);
    chmodSync(first.selector, 0o644);
    assert.throws(() => prepareHubInstallation(join(directory, "Agent's A"), fixture), /private regular file/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
