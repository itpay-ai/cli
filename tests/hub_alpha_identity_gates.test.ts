// R6 Alpha review — intentionally RED until connected identities and token
// refresh are truly supported. These are defects in released-Alpha UX, NOT
// temporary placeholder tests to skip for a green dashboard.
//
// Tests run against local fake HTTP endpoints and isolated temp state only.
// Do not put tokens in stdout or import real user credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hubTasksScope } from "../src/state/hub_tasks.js";
import { storeHubSession, storedHubToken } from "../src/state/hub_credentials.js";
import { HubClient, loadHubConfig } from "../src/client/hub.js";

const getTempDir = () => mkdtempSync(join(tmpdir(), "itpay-alpha-r6-"));

test("R6-01: switching verified OAuth Buyers must change task namespace (tokens rotating within same Buyer should not)", async () => {
  const stateDir = getTempDir();
  try {
    const env = { ...process.env, ITPAY_STATE_DIR: stateDir, ITPAY_HUB_URL: "http://localhost:18090" };
    storeHubSession("access-a", "refresh-a", 3600, "buyer-A", env.ITPAY_HUB_URL, env);
    const scopeA = hubTasksScope(env);
    storeHubSession("access-b", "refresh-b", 3600, "buyer-B", env.ITPAY_HUB_URL, env);
    const scopeB = hubTasksScope(env);
    assert.notEqual(scopeA, scopeB,
      "OAuth Buyer A and B MUST NOT share local task IDs or resume each other's requests");
    storeHubSession("access-b-rotated", "refresh-b2", 3600, "buyer-B", env.ITPAY_HUB_URL, env);
    const rotatedScopeB = hubTasksScope(env);
    assert.equal(scopeB, rotatedScopeB,
      "same verified Buyer/Consumer must preserve task scope when access token rotates");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("R6-02: expired OAuth access token refreshes through the existing public client without interactive login", async () => {
  const stateDir = getTempDir();
  let refreshCalls = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/oauth2/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "rt-old");
      refreshCalls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", token_type: "Bearer", expires_in: 300 }));
      return;
    }
    if (req.url === "/v1/me") {
      res.setHeader("Content-Type", "application/json");
      if (req.headers.authorization !== "Bearer at-new") {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { code: "unauthenticated", message: "expired" } }));
        return;
      }
      res.end(JSON.stringify({ buyer_id: "buyer-A", account_id: "acc-A" }));
      return;
    }
    res.writeHead(404); res.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address == null || typeof address !== "object") throw new Error("no loopback listener");
    const hubURL = `http://127.0.0.1:${address.port}`;
    const env = {
      ...process.env,
      ITPAY_STATE_DIR: stateDir,
      ITPAY_HUB_URL: hubURL,
      ITPAY_HUB_OAUTH_ISSUER: hubURL,
      ITPAY_HUB_OAUTH_CLIENT: "itpay-cli-local",
    };
    storeHubSession("at-old", "rt-old", -30, "buyer-A", hubURL, env);
    assert.equal(storedHubToken(env), undefined, "precondition: old token is expired");
    const client = new HubClient(loadHubConfig(env));
    const who = await client.me(); // Must refresh first, not fall back to other Buyer Key or 401.
    assert.equal(who.buyer_id, "buyer-A");
    assert.equal(refreshCalls, 1);
    assert.equal(storedHubToken(env), "at-new", "rotated access token must be persisted");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("R6-03: same Buyer in two OAuth clients has separate local tasks", () => {
 const stateDir=getTempDir();
 try {
  const env={...process.env,ITPAY_STATE_DIR:stateDir,ITPAY_HUB_URL:"http://localhost:18090",ITPAY_HUB_OAUTH_CLIENT:"client-A"};
  storeHubSession("at-a","rt-a",300,"buyer-A",env.ITPAY_HUB_URL,env);
  const a=hubTasksScope(env);
  const clientB={...env,ITPAY_HUB_OAUTH_CLIENT:"client-B"};
  storeHubSession("at-b","rt-b",300,"buyer-A",env.ITPAY_HUB_URL,clientB);
  assert.notEqual(a,hubTasksScope(clientB));
 } finally {rmSync(stateDir,{recursive:true,force:true})}
});

test("R6-04: rejected refresh stops safely without a key fallback", async () => {
 const stateDir=getTempDir(); let privateCalls=0;
 const server=createServer((req,res)=>{
  if(req.url==="/oauth2/token"){res.writeHead(400);res.end(JSON.stringify({error:"invalid_grant"}));return}
  privateCalls++;res.writeHead(200);res.end(JSON.stringify({buyer_id:"another-buyer"}));
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 try {
  const addr=server.address();if(!addr||typeof addr!=="object")throw new Error("no listener");
  const base=`http://127.0.0.1:${addr.port}`;
  const env={...process.env,ITPAY_STATE_DIR:stateDir,ITPAY_HUB_URL:base,ITPAY_HUB_OAUTH_ISSUER:base};
  storeHubSession("expired","revoked",-1,"buyer-A",base,env);
  await assert.rejects(new HubClient(loadHubConfig(env)).me(),/authorization_required/);
  assert.equal(privateCalls,0);
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(stateDir,{recursive:true,force:true})}
});
