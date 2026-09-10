import { HttpError } from "../client/http.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { newBackendClient, loadConfig } from '../state/config.js';
import { companion, project, localDependencies, type LocalData } from './local.js';
import type { Command } from 'commander';
const encode = encodeURIComponent;
const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
function read(path: string): LocalData { return JSON.parse(readFileSync(path, 'utf8')); }
function save(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function platformWorkflow(draft: LocalData): string {
    const document = draft.arazzo?.arazzo_document;
    if (typeof document !== 'string' || !document.trim()) throw new Error('Platform response is missing the workflow document');
    return document;
}
export async function syncProject(action: 'push' | 'pull', directory: string, options: LocalData) {
    const p = project(directory), cloudPath = join(p.state, 'cloud.json');
    let cloud: LocalData = existsSync(cloudPath) ? read(cloudPath) : {};
    const merchant = options.merchantId ?? cloud.merchant_id ?? p.config.merchant_id;
    if (!merchant)
        throw new Error('--merchant-id is required');
    if (cloud.merchant_id && cloud.merchant_id !== merchant)
        throw new Error('Project is bound to a different merchant');
    const api = newBackendClient(loadConfig()), org = '/v1/seller/organizations/' + encode(merchant);
    const call = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => await api.sellRequest({ method, path, ...(body !== undefined ? { body } : {}) }) as LocalData;
    if (action === 'pull') {
        const draftID = options.draftId ?? cloud.draft_id;
        if (!draftID)
            throw new Error('--draft-id is required');
        if (!options.confirm)
            throw new Error('Pull replaces local workflow/settings; inspect changes and confirm first');
        const bundle = await call('GET', `${org}/service-drafts/${encode(draftID)}/bundle`);
        const backup = join(p.state, 'backups', String(Date.now()));
        mkdirSync(backup, { recursive: true, mode: 0o700 });
        writeFileSync(join(backup, 'workflow.yaml'), p.yaml);
        save(join(backup, 'service.json'), p.config);
        const draft = bundle.draft;
        writeFileSync(join(p.root, 'workflow.yaml'), platformWorkflow(draft));
        save(join(p.root, 'service.json'), { ...p.config, service_id: draft.service_id, public_name: draft.public_name, pricing: draft.pricing, policy: draft.policy, fixtures: bundle.fixtures.fixtures });
        save(join(p.state, 'platform-dependencies.json'), bundle.dependencies);
        cloud = { merchant_id: merchant, draft_id: draftID, revision: draft.semantic_revision, hash: draft.semantic_hash };
        save(cloudPath, cloud);
        return { cloud, backup, next: 'Save a new local version. Platform credentials were not downloaded.' };
    }
    const versions = read(join(p.state, 'versions.json'));
    const version = versions.versions.find((v: LocalData) => v.version_id === versions.selected);
    const confirmation = existsSync(join(p.state, 'confirmation.json')) ? read(join(p.state, 'confirmation.json')) : {};
    if (!version || version.hash !== hash(p.yaml) || version.config_hash !== hash(JSON.stringify(p.config)) || confirmation.version_id !== version.version_id || confirmation.hash !== version.hash || confirmation.config_hash !== version.config_hash)
        throw new Error('Save and confirm the exact current version before uploading');
    const validation = (await companion({ action: 'validate', dependencies: localDependencies(p.state), document: p.yaml, pricing: p.config.pricing, policy: p.config.policy })).find(event => event.type === 'validation')?.value;
    if (!validation?.result?.valid)
        throw new Error('Workflow does not pass validation');
    if (!options.confirm)
        return { local_version: version, cloud, pricing: p.config.pricing, instruction: 'Review the service package and platform API calls, then confirm upload. Platform verification is a separate explicit action.' };
    if (!cloud.draft_id) {
        const drafts = await call('GET', `${org}/service-drafts`);
        const existing = drafts.drafts?.find((d: LocalData) => d.service_id === p.config.service_id);
        if (existing)
            throw new Error('Service ID already exists. Pull that draft explicitly before updating it.');
        const draft = await call('POST', `${org}/service-drafts`, { service_id: p.config.service_id, public_name: p.config.public_name });
        cloud = { merchant_id: merchant, draft_id: draft.draft_id, revision: draft.semantic_revision, operation_bindings: {} };
        save(cloudPath, cloud);
    }
    const base = `${org}/service-drafts/${encode(cloud.draft_id)}`;
    let current = await call('GET', base + '/workflow');
    if (current.semantic_revision !== cloud.revision)
        throw new Error('Remote draft changed; pull and review before retrying');
    if(cloud.local_version_id===version.version_id && cloud.hash===current.semantic_hash && cloud.version_id){
      const saved=await call('GET',base+'/workflow/versions');
      if (saved.versions.some((item: LocalData) => item.version_id === cloud.version_id)) {
        const fixtureState = await call('GET', base + '/fixtures');
        if (fixtureState.revision !== cloud.fixture_revision) throw new Error('Remote test inputs changed; pull and review before retrying');
        return { cloud, already_uploaded: true, next: 'Read the platform Guide and verify the saved version' };
      }
    }
    const sources = join(p.state, 'sources');
    cloud.operation_bindings ??= {};
    if (existsSync(sources))
        for (const file of readdirSync(sources)) {
            const source = read(join(sources, file));
            const imported = await call('POST', `${org}/api-intakes`, { provider_key: source.provider_key, document: source.original, media_type: 'application/yaml' });
            for (const local of source.operations) {
                const remote = imported.operations.find((operation: LocalData) => operation.operation_key === local.operation_key && operation.method === local.method && operation.path === local.path);
                if (!remote)
                    throw new Error('Platform import differs from the local API contract');
                if (remote.operation_hash !== local.operation_hash)
                    throw new Error('Platform API contract changed; download and review the imported contract');
                cloud.operation_bindings[local.provider_operation_version_id] = remote.provider_operation_version_id;
            }
            save(cloudPath, cloud);
        }
    const credentials = options.bindings ? read(resolve(options.bindings)) : {};
    const document = validation.document;
    for (const workflow of document.workflows)
        for (const step of workflow.steps) {
            const meta = step['x-itpay-operation'];
            if (meta?.type === 'api_call') {
                meta.providerOperationVersionId = cloud.operation_bindings[meta.providerOperationVersionId] ?? meta.providerOperationVersionId;
                if (credentials[meta.credentialProfileId])
                    meta.credentialProfileId = credentials[meta.credentialProfileId];
            }
        }
    // Each durable boundary is recorded. On an ambiguous write, pull explicitly;
    // never retry a guessed revision or overwrite another editor's changes.
    current = await call('PUT', base + '/workflow', { expected_revision: cloud.revision, public_name: p.config.public_name, arazzo: document });
    cloud.revision = current.semantic_revision;
    save(cloudPath, cloud);
    current = await call('PUT', base + '/pricing', { expected_revision: cloud.revision, pricing: p.config.pricing, policy: p.config.policy });
    cloud.revision = current.semantic_revision;
    save(cloudPath, cloud);
    let fixtures: LocalData;
    try {
        fixtures = await call('GET', base + '/fixtures');
    }
    catch (error) {
        if (error instanceof HttpError && error.status === 404)
            fixtures = { revision: 0 };
        else
            throw error;
    }
    const savedFixtures = await call('PUT', base + '/fixtures', { expected_revision: fixtures.revision, fixtures: p.config.fixtures });
    const existingVersions=await call('GET',base+'/workflow/versions');
    const saved = existingVersions.versions.find((item:LocalData)=>item.name===version.name&&item.arazzo_document===platformWorkflow(current)) ?? await call('POST', base + '/workflow/versions', { name: version.name, source: 'current', expected_revision: cloud.revision, arazzo_document: platformWorkflow(current) });
    cloud.version_id = saved.version_id;
    cloud.fixture_revision = savedFixtures.revision;
    cloud.local_version_id = version.version_id;
    cloud.hash=current.semantic_hash;
    save(cloudPath, cloud);
    await call('POST', base + '/workflow/validate', {});
    return { cloud, platform_verified: false, next: { command: 'itpay sell verify', input: { workflow_version_id: cloud.version_id, expected_semantic_revision: cloud.revision, expected_fixture_revision: cloud.fixture_revision } }, instruction: 'Review and confirm platform verification before any real API calls. Local test success is not platform evidence.' };
}
export function registerSync(sell: Command) { for (const action of ['push', 'pull'] as const)
    sell.command(action).option('--project <directory>', 'Project directory', '.').option('--merchant-id <id>').option('--draft-id <id>').option('--bindings <file>', 'Local profile ID to platform credential profile ID map').option('--confirm').option('--json').action(async (options) => { try {
        process.stdout.write(JSON.stringify({ status: 'ok', result: await syncProject(action, options.project, options) }, null, 2) + '\n');
    }
    catch (error) {
        process.exitCode = 1;
        process.stdout.write(JSON.stringify({ status: 'error', message: error instanceof Error ? error.message : 'Sync failed' }) + '\n');
    } }); }
