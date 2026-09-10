import { sellerAuth } from "../state/account_auth.js";
import { registerSync } from "./sync.js";
import { preview } from "./preview.js";
import { serveSellMCP } from "./mcp.js";
import { registerLocal } from "./local.js";
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { loadConfig, newBackendClient } from '../state/config.js';
import { SELL_GUIDE, SELL_OPERATIONS, sellRequest } from './contract.js';
export function registerSell(program: Command) {
    const sell = program.command('sell').description('Create, test and submit your service for review');
    const auth = sell.command('auth').description('Authorize this CLI using normal ItPay account login');
    for (const action of ['login', 'status', 'logout'] as const) auth.command(action).action(async () => {
        process.stdout.write(JSON.stringify(await sellerAuth(action, loadConfig().baseURL)) + '\n');
    });
    const groups = new Map<string, Command>([['', sell]]);
    for (const operation of SELL_OPERATIONS) {
        const parts = operation.command.split(' ');
        const leaf = parts.pop()!;
        let parent = sell, key = '';
        for (const part of parts) {
            key = key ? `${key} ${part}` : part;
            let group = groups.get(key);
            if (!group) {
                group = parent.command(part);
                groups.set(key, group);
            }
            parent = group;
        }
        const command = parent.command(leaf).description(operation.description).option('--json', 'Structured output').option('--input-json <file>', 'Request fields as JSON');
        const required = [...operation.path.matchAll(/\{(\w+)\}/g)].map(m => m[1]!);
        for (const field of required)
            command.option(`--${field.replaceAll('_', '-')} <value>`, field);
        if (operation.confirmation)
            command.option('--confirm', 'User explicitly confirmed the disclosed version/action');
        command.action(async (options: Record<string, unknown>) => {
            try {
                if (operation.command === 'guide' && !options.merchantId) {
                    process.stdout.write(JSON.stringify({ ...SELL_GUIDE, operations: SELL_OPERATIONS }, null, 2) + '\n');
                    return;
                }
                if (operation.confirmation && !options.confirm)
                    throw new Error('Explicit user confirmation required after reviewing this action; pass --confirm only after user approval');
                const input = options.inputJson ? JSON.parse(readFileSync(String(options.inputJson), 'utf8')) : {};
                if (!input || typeof input !== 'object' || Array.isArray(input))
                    throw new Error('Input JSON must be an object');
                const params: Record<string, unknown> = {};
                for (const field of required)
                    params[field] = options[field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
                const request = sellRequest(operation, params, input);
                const result = await newBackendClient(loadConfig()).sellRequest(request);
                process.stdout.write(JSON.stringify({ status: 'ok', operation: operation.command, result: result ?? null }, null, 2) + '\n');
            }
            catch (error) {
                process.exitCode = 1;
                process.stdout.write(JSON.stringify({ status: 'error', operation: operation.command, message: error instanceof Error ? error.message : 'Sell operation failed', next: 'itpay sell guide --json' }, null, 2) + '\n');
            }
        });
    }
    registerLocal(sell);
    registerSync(sell);
    sell.commands.find(command => command.name() === "workflow")!.command("preview").option("--project <directory>", "Project directory", ".").action(async (options) => { const result = await preview(options.project); process.stdout.write(JSON.stringify({ url: result.url, instruction: "Open this local URL to inspect the saved workflow" }) + "\n"); });
    sell.command("mcp").description("Serve local Seller MCP over stdio").requiredOption("--stdio").option("--project <directory>", "Project directory", ".").action(async (options) => { await serveSellMCP(options.project); });
    const submission = sell.commands.find(command => command.name() === "submission")!;
    submission.command("watch").requiredOption("--merchant-id <id>").requiredOption("--submission-id <id>").option("--timeout <seconds>", "Maximum wait", "120").option("--json").action(async (options) => {
        const timeout = Number(options.timeout);
        if (!Number.isFinite(timeout) || timeout < 0 || timeout > 600)
            throw new Error("timeout must be between 0 and 600");
        const backend = newBackendClient(loadConfig()), until = Date.now() + timeout * 1000;
        for (;;) {
            const result = await backend.sellRequest({ method: "GET", path: "/v1/seller/organizations/" + encodeURIComponent(options.merchantId) + "/service-submissions/" + encodeURIComponent(options.submissionId) }) as {
                status: string;
            };
            if (!["submitted", "pending", "under_review"].includes(result.status) || Date.now() >= until) {
                process.stdout.write(JSON.stringify({ status: result.status, result }) + "\n");
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    });
    return sell;
}
