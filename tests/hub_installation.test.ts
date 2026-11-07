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
