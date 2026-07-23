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
