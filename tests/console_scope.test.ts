import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
test("API command group coexists with Services without importing Seller", () => {
 const p = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/main.ts", "--help"], {cwd: root, encoding:"utf8"});
 assert.equal(p.status, 0, p.stderr);
 assert.match(p.stdout, /hub/);
 for(const command of ["services", "checkout", "orders", "vault", "aftercare", "buy", "cart"]) assert.match(p.stdout,new RegExp("^  "+command+"(?: |$)","m"));
 assert.match(p.stdout,/api\|hub/);
 for (const command of ["sell"]) {
  assert.doesNotMatch(p.stdout, new RegExp("^  " + command + "(?: |$)", "m"));
 }
});
