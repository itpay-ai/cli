// Hub task store + credential profile tests (A03): durable request binding,
// deterministic idempotency keys, secure key import — no env-var hacks.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubTaskStore, digestTask, hubTasksScope } from "../src/state/hub_tasks.js";
import { importHubKey, storedHubKey } from "../src/state/hub_credentials.js";

function tmpState(): string {
  return mkdtempSync(join(tmpdir(), "itpay-cli-test-"));
}

test("task store persists before dispatch and replays the same request", () => {
  const dir = tmpState();
  const store = new HubTaskStore(join(dir, "tasks"));

  const { task, created } = store.getOrCreate({
    operation_id: "op_qa_paid_001", publication_id: "pub_x",
    input: { q: "a" },
  });
  assert.equal(created, true);
  assert.match(task.request_id, /^req_/);
  assert.equal(task.status, "pending");

  // Re-created process, same seed → same request, never a new id.
  const store2 = new HubTaskStore(join(dir, "tasks"));
  const again = store2.getOrCreate({
    request_id: task.request_id,
    operation_id: "op_qa_paid_001", publication_id: "pub_x",
    input: { q: "a" },
  });
  assert.equal(again.created, false);
  assert.equal(again.task.request_id, task.request_id);

  // Idempotency key derives deterministically from request_id.
  assert.equal(store.idempotencyKey(task.request_id), `cli-req-${task.request_id}`);
  assert.equal(store2.idempotencyKey(task.request_id), `cli-req-${task.request_id}`);

  // Lifecycle: blocked → funded resume → dispatched → succeeded.
  store2.update(task.request_id, { status: "blocked", intent_id: "int_1", blocking_reason: "insufficient_balance" });
  store2.update(task.request_id, { run_id: "run_1", status: "succeeded" });
  const final = new HubTaskStore(join(dir, "tasks")).get(task.request_id);
  assert.equal(final?.run_id, "run_1");
  assert.equal(final?.status, "succeeded");
});

test("request digest is canonical — key order cannot fork a request", () => {
  const a = digestTask("op", "pub", { a: 1, b: { c: 2, d: [3] } });
  const b = digestTask("op", "pub", { b: { d: [3], c: 2 }, a: 1 });
  assert.equal(a, b);
  const c = digestTask("op", "pub", { a: 1, b: { c: 2, d: [3] } }, "5000");
  assert.notEqual(a, c); // cap is part of the request
});

test("explicit and generated requests persist the same admission facts", () => {
  const dir = join(tmpState(), "tasks");
  const store = new HubTaskStore(dir);
  const seed = { operation_id: "op", publication_id: "pub", input: { q: "a" }, max_charge_atoms: "5000" };
  for (const request_id of [undefined, "req_explicit"]) {
    const { task, created } = store.getOrCreate({ ...seed, ...(request_id ? { request_id } : {}) });
    assert.equal(created, true);
    assert.equal(task.status, "pending");
    assert.equal(task.max_charge_atoms, seed.max_charge_atoms);
    assert.equal(task.input_digest, digestTask(seed.operation_id, seed.publication_id, seed.input, seed.max_charge_atoms));
    assert.equal(task.created_at, task.updated_at);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `${task.request_id}.json`), "utf8")), task);
    assert.equal(statSync(join(dir, `${task.request_id}.json`)).mode & 0o777, 0o600);

    const replay = store.getOrCreate({ ...seed, request_id: task.request_id, input: { q: "changed" }, max_charge_atoms: "9000" });
    assert.equal(replay.created, false);
    // Reading an unbound legacy-compatible scope may refresh updated_at.
    assert.deepEqual(replay.task, { ...task, updated_at: replay.task.updated_at }, "replaying an ID preserves the original admission facts");
  }
});

test("credential import stores the key 0600 and only reports the prefix", async () => {
  const dir = tmpState();
  const env = { ...process.env, ITPAY_STATE_DIR: dir, ITPAY_HUB_URL: "http://localhost:18090" };
  const key = "itk_live_abcdef1234567890";
  const { key_prefix } = importHubKey(key, "http://localhost:18090", env);
  assert.match(key_prefix, /^itk_/);
  assert.ok(!key_prefix.includes("7890"));
  assert.equal(storedHubKey(env), key);
  // file permissions must not leak
  const { readdirSync } = await import("node:fs");
  const file = readdirSync(dir).find((f) => f.startsWith("hub-credentials."));
  assert.ok(file);
  const mode = statSync(join(dir, file!)).mode & 0o777;
  assert.equal(mode, 0o600, "credential file must be 0600");
  assert.equal(readFileSync(join(dir, file!), "utf8").includes(key), true);
});

// F-R01 regression: two OS processes creating different tasks must BOTH
// persist (the legacy whole-file store lost updates under this interleave).
test("F-R01: concurrent processes each keep their own task", async () => {
  const dir = tmpState();
  const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
  const helper = `import { HubTaskStore } from ${JSON.stringify(new URL("../src/state/hub_tasks.ts", import.meta.url).pathname)};
    const s = new HubTaskStore(${JSON.stringify(join(dir, "tasks"))});
    s.getOrCreate({ request_id: process.argv[1], operation_id: "op", publication_id: "p", input: {} });
    // a small barrier so both processes genuinely overlap on the store
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    s.update(process.argv[1], { status: "dispatched" });
    s.update(process.argv[1], { status: "succeeded", run_id: "run_" + process.argv[1] });`;
  const children = Array.from({length: 10}, (_, i) => spawn(process.execPath, [tsx, "-e", helper, `req_race_${i}`], { stdio: ["ignore", "pipe", "pipe"] }));
  await Promise.all(children.map(child => new Promise<void>((resolve,reject) => {
    let stderr = "";
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
  })));
  const store = new HubTaskStore(join(dir, "tasks"));
  for (let i=0;i<10;i++) assert.equal(store.get(`req_race_${i}`)?.run_id, `run_req_race_${i}`);
  assert.equal(store.list().length, 10);
});

// F-R01 scope: different hub origins / credentials resolve to different
// task namespaces — a task created under env A is invisible to env B.
test("F-R01: hub origin and credential scope the task namespace", () => {
  const dir = tmpState();
  const envA = { ...process.env, ITPAY_STATE_DIR: dir, ITPAY_HUB_URL: "http://localhost:18090", ITPAY_HUB_KEY: "itk_scope_aaaaaa" };
  const envB = { ...envA, ITPAY_HUB_URL: "http://localhost:9999" };
  const envC = { ...envA, ITPAY_HUB_KEY: "itk_scope_bbbbbb" };
  assert.notEqual(hubTasksScope(envA), hubTasksScope(envB)); // different hub → different namespace
  assert.notEqual(hubTasksScope(envA), hubTasksScope(envC)); // different key → different namespace
  assert.equal(hubTasksScope(envA), hubTasksScope({ ...envA })); // deterministic
});

// Concurrent updates on the SAME task cannot roll a terminal state back.
test("F-R01: terminal status survives racing updates", () => {
  const dir = tmpState();
  const store = new HubTaskStore(join(dir, "tasks"));
  for (const status of ["succeeded", "failed"] as const) {
    const requestID = `req_term_${status}`;
    store.getOrCreate({ request_id: requestID, operation_id: "op", publication_id: "p", input: {} });
    store.update(requestID, { status, run_id: "run_1" });
    const afterRace = store.update(requestID, { status: "dispatched", run_id: "run_other" });
    assert.equal(afterRace?.status, status);
    assert.equal(afterRace?.run_id, "run_1");
    assert.equal(store.get(requestID)?.status, status);
  }
});

test("credential selections persist and extend only credential-bearing request digests", () => {
 const dir=join(tmpState(),"tasks");const store=new HubTaskStore(dir);
 const seed={operation_id:"op",publication_id:"pub",input:{q:"fixed"}};
 const selections={source_credentials:{api:{credential_id:"uck_stored",expected_version:"cred_version"}}};
 const {task}=store.getOrCreate({...seed,...selections});
 assert.deepEqual(new HubTaskStore(dir).get(task.request_id)?.source_credentials,selections.source_credentials);
 assert.equal(task.input_digest,digestTask("op","pub",seed.input,undefined,selections));
 assert.notEqual(task.input_digest,digestTask("op","pub",seed.input));
 assert.notEqual(task.input_digest,digestTask("op","pub",seed.input,undefined,{credential_id:"uck_stored"}));
 assert.notEqual(task.input_digest,digestTask("op","pub",seed.input,undefined,{source_credentials:{api:{credential_id:"uck_stored",expected_version:"cred_changed"}}}));
 assert.equal(digestTask("op","pub",seed.input),digestTask("op","pub",seed.input,undefined,{}));
});
