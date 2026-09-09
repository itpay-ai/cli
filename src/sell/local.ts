import { newBackendClient, loadConfig } from "../state/config.js";
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
export type LocalData = Record<string, any>;
const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
function read(path: string): LocalData { return JSON.parse(readFileSync(path, 'utf8')); }
function save(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const tmp = path + '.' + randomUUID() + '.tmp'; writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, path); }
export function project(directory: string) { const root = resolve(directory); return { root, state: join(root, '.itpay-sell'), config: read(join(root, 'service.json')), yaml: readFileSync(join(root, 'workflow.yaml'), 'utf8') }; }
export function localDependencies(state: string): LocalData {
 const platformPath = join(state, 'platform-dependencies.json');
 const dependencies: LocalData = existsSync(platformPath) ? read(platformPath) : {};
 const sources = join(state, 'sources');
 if (existsSync(sources)) for (const file of readdirSync(sources)) {
  const source = read(join(sources, file));
  for (const operation of source.operations) dependencies[operation.provider_operation_version_id] = {
   provider_operation_version_id: operation.provider_operation_version_id,
   provider_key: source.provider_key, operation_key: operation.operation_key,
   operation_hash: operation.operation_hash, operation: operation.operation,
   request_schema: operation.request_schema, response_schema: operation.response_schema,
   retry_policy: operation.retry_policy ?? {},
  };
 }
 return dependencies;
}
export async function companion(input: LocalData, onEvent?: (event: LocalData) => void): Promise<LocalData[]> {
    const binary = process.env.ITPAY_SELL_RUNNER ?? fileURLToPath(new URL(`../../../bin/${process.platform}-${process.arch}/itpay-sell${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
    if (!existsSync(binary))
        throw new Error(`Local runner missing for ${process.platform}-${process.arch}; install a CLI package including its native runner`);
    return new Promise((done, fail) => {
        const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        let buffer = '', stderr = '';
        const events: LocalData[] = [];
        child.on('error', fail);
        child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 2000); });
        child.stdout.on('data', chunk => { buffer += String(chunk); let index; while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            try {
                const event = JSON.parse(line);
                events.push(event);
                onEvent?.(event);
            }
            catch {
                child.kill();
                fail(new Error('Invalid local runner response'));
            }
        } });
        child.on('close', code => { if (code !== 0)
            fail(new Error(events.find(event => event.type === 'error')?.value?.message ?? stderr ?? 'Local runner failed'));
        else
            done(events); });
        child.stdin.on('error', () => { });
        child.stdin.end(JSON.stringify(input));
    });
}
function last(events: LocalData[], type: string) { return [...events].reverse().find(event => event.type === type)?.value; }
export async function localAction(action: string, directory: string, options: LocalData): Promise<unknown> {
    const root = resolve(directory), state = join(root, '.itpay-sell');
    if (action === 'init') {
        if (existsSync(join(root, 'service.json')) || existsSync(join(root, 'workflow.yaml')) || existsSync(state))
            throw new Error('Project already exists; existing files were not replaced');
        mkdirSync(root, { recursive: true });
        const config = { format_version: 1, service_id: options.serviceId ?? '', public_name: options.name ?? '', pricing: { billing_mode: 'per_call' }, policy: {}, fixtures: [] };
        save(join(root, 'service.json'), config);
        writeFileSync(join(root, 'workflow.yaml'), '# Generate the workflow from locked API contracts using itpay sell guide.\n', { flag: 'wx' });
        save(join(state, 'versions.json'), { versions: [] });
        return { root, next: 'itpay sell sources add --file <openapi> --provider-key <key>', missing: ['workflow', 'price', 'fixtures'] };
    }
    const p = project(root);
    if (action === 'workflow import') {
        if (!options.file)
            throw new Error('--file is required');
        const yaml = readFileSync(resolve(options.file), 'utf8');
        const validation = last(await companion({ action: 'validate', dependencies: localDependencies(state), document: yaml, pricing: p.config.pricing, policy: p.config.policy }), 'validation');
        const backup = join(state, 'imports', hash(p.yaml).slice(7) + '.yaml');
        mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
        writeFileSync(backup, p.yaml, { mode: 0o600 });
        writeFileSync(join(root, 'workflow.yaml'), yaml);
        return { imported: true, validation, next: 'Resolve all imported API references and save a new workflow version' };
    }
    if (action === 'config') {
        if (options.file) {
            const value = read(resolve(options.file));
            for (const key of Object.keys(value))
                if (!['service_id', 'public_name', 'pricing', 'policy', 'fixtures', 'merchant_id', 'draft_id', 'expected_revision'].includes(key))
                    throw new Error('Unsupported setting: ' + key);
            save(join(root, 'service.json'), { ...p.config, ...value });
        }
        return read(join(root, 'service.json'));
    }
    if (action === 'sources add') {
        if ((!options.file && !options.url) || !options.providerKey)
            throw new Error('--file or --url, and --provider-key are required');
        if (options.file && options.url)
            throw new Error('Choose file or URL, not both');
        const raw = options.file ? readFileSync(resolve(options.file), 'utf8') : last(await companion({ action: 'fetch', source_url: options.url }), 'source').document;
        const id = hash(raw).slice(7);
        const operations = last(await companion({ action: 'compile', document: raw, provider_key: options.providerKey }), 'compiled');
        const path = join(state, 'sources', id + '.json');
        save(path, { provider_key: options.providerKey, source_hash: hash(raw), original: raw, operations });
        return { source_hash: hash(raw), operations, instruction: 'Use these exact contracts when constructing workflow.yaml; bind local credentials by environment reference' };
    }
    if (action === 'credentials bind') {
        if (!options.profile || !options.file)
            throw new Error('--profile and --file are required; file must map credential fields to environment variable names, not secret values');
        const bindings = read(resolve(options.file));
        for (const value of Object.values(bindings))
            if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
                throw new Error('Credential bindings must be environment variable names');
        const path = join(state, 'credentials.json');
        save(path, { ...(existsSync(path) ? read(path) : {}), [options.profile]: bindings });
        return { profile: options.profile, bound_fields: Object.keys(bindings) };
    }
    if (action === 'credentials upload') {
        if (!options.confirm || !options.profile || !options.providerKey || !options.merchantId)
            throw new Error('Merchant, provider, local profile and explicit confirmation are required');
        const bindings = read(join(state, 'credentials.json'))[options.profile];
        if (!bindings)
            throw new Error('Local profile not bound');
        const secrets: Record<string, string> = {};
        for (const [field, env] of Object.entries(bindings)) {
            const value = process.env[String(env)];
            if (!value)
                throw new Error('Missing credential environment for ' + field);
            secrets[field] = value;
        }
        const result = await newBackendClient(loadConfig()).sellRequest({ method: 'POST', path: '/v1/seller/organizations/' + encodeURIComponent(options.merchantId) + '/provider-credential-profiles', body: { provider_key: options.providerKey, profile_key: options.profile, display_name: options.name ?? options.profile, environment: options.environment ?? 'sandbox', secrets, metadata: options.file ? read(resolve(options.file)) : {} } });
        return result;
    }
    const versionsPath = join(state, 'versions.json');
    const versions = read(versionsPath);
    if (action === 'workflow versions save') {
        const validation = last(await companion({ action: 'validate', dependencies: localDependencies(state), document: p.yaml, pricing: p.config.pricing, policy: p.config.policy }), 'validation');
        const version = { version_id: randomUUID(), name: options.name ?? 'Saved version', hash: hash(p.yaml), config_hash: hash(JSON.stringify(p.config)), created_at: new Date().toISOString() };
        save(join(state, 'versions', version.version_id + '.json'), { ...version, document: p.yaml, config: p.config });
        versions.versions.push(version);
        versions.selected = version.version_id;
        save(versionsPath, versions);
        return { ...version, validation };
    }
    if (action === 'workflow versions list')
        return versions;
    if (action === 'workflow versions use' || action === 'workflow versions delete') {
        const version = versions.versions.find((v: LocalData) => v.version_id === options.version);
        if (!version)
            throw new Error('Saved version not found');
        if (action.endsWith('use')) {
            const saved = read(join(state, 'versions', version.version_id + '.json'));
            writeFileSync(join(root, 'workflow.yaml'), saved.document);
            save(join(root, 'service.json'), saved.config);
            versions.selected = version.version_id;
        }
        else {
            if (!options.confirm)
                throw new Error('Confirm version deletion with --confirm');
            versions.versions = versions.versions.filter((v: LocalData) => v.version_id !== version.version_id);
            if (versions.selected === version.version_id)
                delete versions.selected;
            rmSync(join(state, 'versions', version.version_id + '.json'));
            const runs = join(state, 'runs');
            if (existsSync(runs))
                for (const run of readdirSync(runs)) {
                    const meta = join(runs, run, 'meta.json');
                    if (existsSync(meta) && read(meta).version_id === version.version_id)
                        rmSync(join(runs, run), { recursive: true });
                }
        }
        save(versionsPath, versions);
        return versions;
    }
    if (action === 'workflow validate')
        return last(await companion({ action: 'validate', dependencies: localDependencies(state), document: p.yaml, pricing: p.config.pricing, policy: p.config.policy }), 'validation');
    if (action === 'test get') {
        if (!options.run)
            throw new Error('--run is required');
        return read(join(state, 'runs', safeID(options.run), 'report.json'));
    }
    const selected = versions.versions.find((v: LocalData) => v.version_id === versions.selected);
    if (!selected || selected.hash !== hash(p.yaml) || selected.config_hash !== hash(JSON.stringify(p.config)))
        throw new Error('Save the current workflow and configuration before confirming or running');
    if (action === 'workflow confirm') {
        if (!options.confirm)
            return { version: selected, config: p.config, workflow: p.yaml, instruction: 'Review this exact workflow and service configuration with the user, then confirm' };
        save(join(state, 'confirmation.json'), { version_id: selected.version_id, hash: selected.hash, config_hash: selected.config_hash, confirmed_at: new Date().toISOString() });
        return { confirmed: selected };
    }
    if (action === 'test run' || action === 'test resume') {
        if (!options.confirm)
            throw new Error('Live Provider calls may cost money or change data. Review dependencies and confirm with --confirm');
        const dependencies = localDependencies(state);
        const credentials: LocalData = {};
        const credentialPath = join(state, 'credentials.json');
        if (existsSync(credentialPath))
            for (const [profile, fields] of Object.entries(read(credentialPath))) {
                const secrets: Record<string, string> = {};
                for (const [field, env] of Object.entries(fields as LocalData)) {
                    if (!process.env[String(env)])
                        throw new Error(`Missing local environment variable for credential field ${field}`);
                    secrets[field] = process.env[String(env)]!;
                }
                credentials[profile] = { ID: profile, Secrets: secrets, Metadata: {} };
            }
        if (action === 'test resume' && !options.run)
            throw new Error('--run is required for resume');
        const runID = options.run ? safeID(options.run) : randomUUID(), runDirectory = join(state, 'runs', runID);
        const metaPath = join(runDirectory, 'meta.json');
        if (action === 'test resume' && !existsSync(metaPath))
            throw new Error('Run does not exist');
        if (existsSync(metaPath) && read(metaPath).version_id !== selected.version_id)
            throw new Error('Run belongs to a different version');
        save(metaPath, { run_id: runID, version_id: selected.version_id, hash: selected.hash, config_hash: selected.config_hash });
        save(join(state, "last-run.json"), { run_id: runID });
        const events = await companion({ action: 'run', document: p.yaml, pricing: p.config.pricing, policy: p.config.policy, fixtures: p.config.fixtures, dependencies, credentials, run_directory: runDirectory, confirmed: true }, event => { if (event.type === 'nodes')
            save(join(runDirectory, 'nodes.json'), event.value); });
        const result = last(events, 'result');
        save(join(runDirectory, 'report.json'), result);
        return { run_id: runID, ...result };
    }
    throw new Error('Unsupported local action: ' + action);
}
function safeID(value: string) { if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Invalid local run ID'); return value; }
export const LOCAL_ACTIONS = ['init', 'config', 'workflow import', 'sources add', 'credentials bind', 'credentials upload', 'workflow validate', 'workflow confirm', 'workflow versions save', 'workflow versions list', 'workflow versions use', 'workflow versions delete', 'test run', 'test resume', 'test get'];
export function registerLocal(sell: Command) {
    for (const name of LOCAL_ACTIONS) {
        let parent = sell;
        const parts = name.split(' ');
        const leaf = parts.pop()!;
        for (const part of parts) {
            parent = parent.commands.find(cmd => cmd.name() === part) ?? parent.command(part);
        }
        parent.command(leaf).description('Local Sell: ' + name).option('--project <directory>', 'Project directory', '.').option('--file <file>').option('--url <https-url>').option('--name <name>').option('--service-id <id>').option('--provider-key <key>').option('--profile <id>').option('--merchant-id <id>').option('--environment <environment>').option('--version-id <id>').option('--run <id>').option('--confirm').option('--json').action(async (options) => { try {
            const result = await localAction(name.replace('list-local', 'list'), options.project, { ...options, version: options.versionId });
            process.stdout.write(JSON.stringify({ status: 'ok', result }, null, 2) + '\n');
        }
        catch (error) {
            process.exitCode = 1;
            process.stdout.write(JSON.stringify({ status: 'error', message: error instanceof Error ? error.message : 'Local action failed' }) + '\n');
        } });
    }
}
