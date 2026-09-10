import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SELL_GUIDE, SELL_OPERATIONS, sellRequest } from './contract.js';
import { LOCAL_ACTIONS, localAction } from './local.js';
import { newBackendClient, loadConfig } from '../state/config.js';
import { syncProject } from './sync.js';
import { preview } from './preview.js';
export async function serveSellMCP(directory: string) {
    const server = new McpServer({ name: 'itpay-sell-local', version: SELL_GUIDE.version }, { instructions: 'Use itpay_seller_guide first. Local tests call Provider APIs and may incur cost; disclose side effects and obtain user approval. Never pass secret values in tool arguments. This server uses its configured project directory.' });
    server.tool('itpay_seller_guide', 'Read the publishing guide and constraints', {}, async () => ({ content: [{ type: 'text', text: JSON.stringify({ ...SELL_GUIDE, operations: SELL_OPERATIONS }) }] }));
    for (const action of LOCAL_ACTIONS) {
        server.tool('itpay_seller_local_' + action.replaceAll(' ', '_').replaceAll('-', '_'), `Local ${action}. Paths are user-provided files; never scan for credentials. Confirm only after explicit user approval.`, { merchant_id: z.string().optional(), environment: z.string().optional(), service_id: z.string().optional(), url: z.string().url().optional(), file: z.string().optional(), name: z.string().optional(), provider_key: z.string().optional(), profile: z.string().optional(), version: z.string().optional(), run: z.string().optional(), confirmed: z.boolean().default(false) }, async (args) => {
            try {
                const result = await localAction(action, directory, { ...args, merchantId: args.merchant_id, providerKey: args.provider_key, serviceId: args.service_id, confirm: args.confirmed });
                return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            }
            catch (error) {
                return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Local action failed' }] };
            }
        });
    }
    server.tool('itpay_seller_sync', 'Upload or download the configured project after explicit user confirmation. Never pass credential values.', { action: z.enum(['push', 'pull']), merchant_id: z.string(), draft_id: z.string().optional(), bindings_file: z.string().optional(), confirmed: z.boolean().default(false) }, async (args) => {
        try {
            const result = await syncProject(args.action, directory, { merchantId: args.merchant_id, draftId: args.draft_id, bindings: args.bindings_file, confirm: args.confirmed });
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        catch (error) {
            return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Sync failed' }] };
        }
    });
    let display: Awaited<ReturnType<typeof preview>> | undefined;
    server.tool('itpay_seller_preview', 'Open the existing Builder for this local workflow; user can then confirm through the local workflow tool.', {}, async () => { display ??= await preview(directory); return { content: [{ type: 'text', text: JSON.stringify({ url: display.url }) }] }; });
    for (const operation of SELL_OPERATIONS) {
        server.tool('itpay_seller_platform_' + operation.command.replaceAll(' ', '_').replaceAll('-', '_'), `${operation.description}. Input contract: ${JSON.stringify(operation.fields)}. Optional fields: ${JSON.stringify(operation.optional ?? [])}.`, { merchant_id: z.string().optional(), draft_id: z.string().optional(), library_api_id: z.string().optional(), intake_id: z.string().optional(), version_id: z.string().optional(), run_id: z.string().optional(), submission_id: z.string().optional(), input: z.record(z.unknown()).default({}), confirmed: z.boolean().default(false) }, async (args) => {
            try {
                if (operation.confirmation && !args.confirmed)
                    throw new Error('Explicit user confirmation required');
                const result = await newBackendClient(loadConfig()).sellRequest(sellRequest(operation, args, args.input));
                return { content: [{ type: 'text', text: JSON.stringify(result ?? {}) }] };
            }
            catch (error) {
                return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Platform action failed' }] };
            }
        });
    }
    process.stdin.on('end', () => display?.close());
    await server.connect(new StdioServerTransport());
}
