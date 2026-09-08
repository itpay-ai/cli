/** Local integration harness. Uses the same command handlers and device signing as itpay. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { BackendClient } from "../src/client/backend.js";
import { HttpClient } from "../src/client/http.js";
import { DeviceAuthority } from "../src/state/device_authority.js";
import { CLI_VERSION, API_CONTRACT_REVISION, loadConfig } from "../src/state/config.js";
import { runServicesStart, runServicesInvoke, runServicesAction, runServicesQuote, runServicesCheckout } from "../src/commands/services.js";

const [mode, json] = process.argv.slice(2);
if (!['exact', 'smart', 'select', 'quote', 'checkout', 'get'].includes(mode ?? '') || !json || !process.env.ITPAY_RAIL_LOCAL_STATE_DIR) {
  throw new Error('Usage: ITPAY_RAIL_LOCAL_STATE_DIR=/absolute/private/test-directory tsx scripts/rail-local.ts exact|smart|select|quote|checkout|get \'{"origin":"…","destination":"…","travel_date":"YYYY-MM-DD"}\'');
}
const input = JSON.parse(json) as Record<string, unknown>;
const root = resolve(process.env.ITPAY_RAIL_LOCAL_STATE_DIR);
mkdirSync(root, { recursive: true, mode: 0o700 });
const fingerprint = createHash('sha256').update(JSON.stringify([mode, input])).digest('hex');
const config = loadConfig({ ITPAY_AGENT_TYPE: 'codex-cli', ITPAY_IDEMPOTENCY_KEY: createHash('sha256').update(root + fingerprint).digest('hex') });
const headers = { 'X-ItPay-CLI-Version': CLI_VERSION, 'X-ItPay-Contract-Revision': API_CONTRACT_REVISION };
const transport: typeof fetch = (url, options) => {
  const source = new URL(String(url));
  if (source.origin !== config.baseURL) throw new Error('Unexpected backend origin');
  return fetch('http://127.0.0.1:18086' + source.pathname + source.search, options);
};
const device = new DeviceAuthority({ baseURL: config.baseURL, requestedAgentType: config.agentType,
  compatibilityHeaders: headers, statePath: resolve(root, 'device.json'), privateKeyPath: resolve(root, 'device.pem'), fetchImpl: transport });
const backend = new BackendClient(new HttpClient({ baseURL: config.baseURL, fetchImpl: transport, defaultHeaders: headers,
  requestAuthorizer: (request) => device.authorizationHeaders(request), recoverAuthorization: () => device.recoverAuthorization() }));
const output = { jsonOutput: true, output: (line: string) => process.stdout.write(line) };
if (mode === 'select') {
  await runServicesAction(backend, String(input.execution), 'select_candidate', {}, { ...output, candidateRank: Number(input.rank), actorType: 'human', status: 'approved' });
  process.exit(0);
}
if (mode === 'quote') {
  await runServicesQuote(backend, String(input.execution), 'book_ticket', input.seat_type ? { seat_type: input.seat_type } : {}, output);
  process.exit(0);
}
if (mode === 'checkout') {
  await runServicesCheckout(backend, config, String(input.execution), 'book_ticket', { ...output, lockedInput: input.seat_type ? { seat_type: input.seat_type } : {}, persistHandoff: (handoff) => writeFileSync(resolve(root, 'checkout.json'), JSON.stringify(handoff), { mode: 0o600 }) });
  process.exit(0);
}
if (mode === 'get') {
  process.stdout.write(JSON.stringify(await backend.getServiceExecution(String(input.execution))));
  process.exit(0);
}
const path = resolve(root, fingerprint + '.json');
let execution: string;
if (existsSync(path)) {
  execution = JSON.parse(readFileSync(path, 'utf8')).execution;
} else {
  let output = '';
  await runServicesStart(backend, 'svc_itpay_rail_' + mode, { jsonOutput: true, output: (line) => { output += line; } });
  execution = JSON.parse(output).result.service_execution_id;
  writeFileSync(path, JSON.stringify({ execution }), { mode: 0o600 });
}
await runServicesInvoke(backend, config, execution, mode === 'exact' ? 'search' : 'plan', input,
  { jsonOutput: true, output: (line) => process.stdout.write(line) });
