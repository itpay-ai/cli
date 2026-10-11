import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeviceSessionCache } from "../src/state/device_session_cache.js";
import { createDeviceKey, deviceKeyThumbprint } from "../src/state/device_key.js";
const context = { backend: "https://dev.itpay.ai", agentType: "workbuddy", keyThumbprint: "fixture-key" };
const registration = { deviceID: "dev_fixture", deviceKeyID: "key_fixture", quotaLineageID: "lineage_fixture", agentInstances: {workbuddy: "instance_fixture"}, sessions: {workbuddy: {token: "synthetic", expiresAt: "2099-01-01T00:00:00Z"}} };

test("invalidation cannot be overwritten by a late session response", () => {
 const cache = new DeviceSessionCache(mkdtempSync(join(tmpdir(), "itpay-cache-")), context);
 const first = cache.generation(true)!;
 cache.write(registration, first);
 assert.deepEqual(cache.read(), registration);
 cache.invalidate();
 cache.write(registration, first);
 assert.equal(cache.read(), undefined);
 const second = cache.generation(false)!;
 cache.write(registration, second);
 assert.deepEqual(cache.read(), registration);
 cache.invalidate();
 cache.invalidate();
 cache.write(registration, second);
 assert.equal(cache.read(), undefined);
});
test("cache contexts are separated and corrupt generation cannot revive a session", () => {
 const root = mkdtempSync(join(tmpdir(), "itpay-cache-context-"));
 const cache = new DeviceSessionCache(root, context);
 const generation = cache.generation(true)!;
 cache.write(registration, generation);
 for (const other of [{...context,backend:"https://app.itpay.ai"},{...context,agentType:"codex-cli"},{...context,keyThumbprint:"other-key"}]) assert.equal(new DeviceSessionCache(root,other).read(),undefined);
 writeFileSync(cache.generationPath,"invalid");
 assert.throws(()=>cache.read(),/DEVICE_CACHE_GENERATION_INVALID/);
});
test("canonical key never gets overwritten; existing identity without key fails", () => {
 const root = mkdtempSync(join(tmpdir(), "itpay-key-"));
 const path = join(root,"private.pem");
 const first = createDeviceKey(path,false);
 const bytes = readFileSync(path);
 assert.equal(deviceKeyThumbprint(createDeviceKey(path,true)),deviceKeyThumbprint(first));
 assert.deepEqual(readFileSync(path),bytes);
 assert.throws(()=>createDeviceKey(join(root,"missing.pem"),true),/DEVICE_KEY_MISSING/);
});

test("existing identity authorizes and recovers without process probes or legacy lock writes", async () => {
 const fs = await import("node:fs");
 const child = await import("node:child_process");
 const { mock } = await import("node:test");
 const { syncBuiltinESMExports } = await import("node:module");
 const { DeviceAuthority } = await import("../src/state/device_authority.js");
 const root = mkdtempSync(join(tmpdir(),"itpay-no-legacy-lock-"));
 const keyPath = join(root,"private.pem");
 createDeviceKey(keyPath,false);
 const keyBytes = readFileSync(keyPath);
 const statePath = join(root,"identity.json");
 writeFileSync(statePath,JSON.stringify({schemaVersion:"itpay.device.v2",registrations:{[context.backend]:registration}}));
 fs.mkdirSync(`${statePath}.lock.transition`);
 writeFileSync(`${statePath}.lock`,"unknown historical owner");
 const identityBytes = readFileSync(statePath);
 let challenges = 0;
 const fetchImpl: typeof fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if(path==="/v1/agent-device-session-challenges") {
   challenges++;
   return new Response(JSON.stringify({agent_device_session_challenge_id:"fixture-challenge",challenge:"synthetic"}));
  }
  if(path==="/v1/agent-device-session-challenges/fixture-challenge/verify") return new Response(JSON.stringify({session_token:`fixture-session-${challenges}`,expires_at:"2099-01-01T00:00:00Z"}));
  throw new Error("unexpected enrollment or business call");
 };
 const write = fs.default.writeFileSync;
 const patches = [
  mock.method(child.default,"execFileSync",()=>{throw new Error("process probe forbidden");}),
  mock.method(fs.default,"writeFileSync",(...args: Parameters<typeof fs.writeFileSync>)=>{
   if(String(args[0]).includes(".lock")) throw new Error("legacy lock write forbidden");
   return write(...args);
  }),
 ];
 syncBuiltinESMExports();
 try {
  const options = {baseURL:context.backend,requestedAgentType:"workbuddy",compatibilityHeaders:{},statePath,privateKeyPath:keyPath,fetchImpl};
  const first = new DeviceAuthority(options);
  const request = {method:"GET",path:"/v1/service-executions",body:""};
  assert.equal((await first.authorizationHeaders(request)).Authorization,"ItPayDevice fixture-session-1");
  assert.equal((await new DeviceAuthority(options).authorizationHeaders(request)).Authorization,"ItPayDevice fixture-session-1");
  await first.recoverAuthorization();
  assert.equal((await first.authorizationHeaders(request)).Authorization,"ItPayDevice fixture-session-2");
  await first.recoverBackendReset();
  assert.equal((await first.authorizationHeaders(request)).Authorization,"ItPayDevice fixture-session-3");
  assert.deepEqual(readFileSync(keyPath),keyBytes);
  assert.deepEqual(readFileSync(statePath),identityBytes);
  assert.equal(readFileSync(`${statePath}.lock`,"utf8"),"unknown historical owner");
  assert.ok(fs.existsSync(`${statePath}.lock.transition`));
 } finally {
  for(const patch of patches) patch.mock.restore();
  syncBuiltinESMExports();
 }
});

test("atomic replacement between lstat and open reads a complete snapshot and still rejects stale generations", async () => {
 const fs = await import("node:fs");
 const {mock} = await import("node:test");
 const {syncBuiltinESMExports} = await import("node:module");
 const cache = new DeviceSessionCache(mkdtempSync(join(tmpdir(),"itpay-open-snapshot-")),context);
 const first=cache.generation(true)!;cache.write(registration,first);
 const open=fs.default.openSync;
 for(const target of [cache.cachePath,cache.generationPath]) {
  let replaced=false;
  const patch=mock.method(fs.default,"openSync",(...args:Parameters<typeof fs.openSync>)=>{
   if(String(args[0])===target&&!replaced) {
    replaced=true;
    const replacement=target+'.fixture';
    const bytes=readFileSync(target);
    fs.writeFileSync(replacement,bytes,{flag:'wx',mode:0o600});
    fs.renameSync(replacement,target);
   }
   return open(...args);
  });
  syncBuiltinESMExports();
  try {assert.deepEqual(cache.read(),registration);assert.equal(replaced,true);}
  finally {patch.mock.restore();syncBuiltinESMExports();}
 }
 cache.invalidate();cache.write(registration,first);assert.equal(cache.read(),undefined);
 fs.unlinkSync(cache.cachePath);fs.symlinkSync(cache.generationPath,cache.cachePath);
 assert.throws(()=>cache.read(),/DEVICE_CACHE_INVALID_FILE/);
});
