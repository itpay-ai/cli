import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { project } from './local.js';
export async function preview(directory: string): Promise<{
    url: string;
    close: () => void;
}> {
    const assets = fileURLToPath(new URL('../../../assets/sell-preview/', import.meta.url));
    if (!existsSync(resolve(assets, 'index.html')))
        throw new Error('CLI preview assets are missing; install the complete CLI package');
    const token = randomBytes(24).toString('hex');
    const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method !== 'GET' || !req.url?.startsWith('/' + token + '/')) {
            res.writeHead(404).end();
            return;
        }
        try {
            const path = req.url.slice(token.length + 2).split('?')[0] ?? '';
            if (path === 'document') {
                const p = project(directory);
                const versions = JSON.parse(readFileSync(resolve(p.state, 'versions.json'), 'utf8'));
                const version = versions.versions.find((v: {
                    version_id: string;
                }) => v.version_id === versions.selected);
                res.setHeader('Content-Type', 'application/json');
                const actualHash = 'sha256:' + createHash('sha256').update(p.yaml).digest('hex');
                let run;
                const marker = resolve(p.state, 'last-run.json');
                if (existsSync(marker)) {
                    const id = JSON.parse(readFileSync(marker, 'utf8')).run_id;
                    if (typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) && existsSync(resolve(p.state, 'runs', id, 'meta.json'))) {
                        const dir = resolve(p.state, 'runs', id), meta = JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8'));
                        const traces = existsSync(resolve(dir, 'nodes.json')) ? JSON.parse(readFileSync(resolve(dir, 'nodes.json'), 'utf8')) : [];
                        const report = existsSync(resolve(dir, 'report.json')) ? JSON.parse(readFileSync(resolve(dir, 'report.json'), 'utf8')).report : undefined;
                        const configHash = 'sha256:' + createHash('sha256').update(JSON.stringify(p.config)).digest('hex');
                        const stale = meta.hash !== actualHash || meta.config_hash !== configHash;
                        const fixtures = p.config.fixtures ?? [];
                        run = { status: stale ? 'stale' : report?.status ?? 'running', issues: report?.issues ?? [], validation: { fixture_runs: fixtures.map((f: {
                                    fixture_id: string;
                                    name: string;
                                }) => ({ ...f, nodes: traces.filter((t: {
                                        record_type: string;
                                        fixture_id: string;
                                    }) => t.record_type === 'node' && t.fixture_id === f.fixture_id) })), api_recognitions: [], side_effect_operations: [] } };
                    }
                }
                res.end(JSON.stringify({ document: p.yaml, version: version?.hash === actualHash ? version.name : 'Unsaved', hash: actualHash, pricing: p.config.pricing, run }));
                return;
            }
            const file = resolve(assets, path || 'index.html');
            if (!file.startsWith(resolve(assets) + '/')) {
                res.writeHead(404).end();
                return;
            }
            const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
            res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
            res.end(readFileSync(file));
        }
        catch {
            res.writeHead(404).end();
        }
    });
    return new Promise((done, fail) => { server.on('error', fail); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') {
        fail(new Error('Preview address unavailable'));
        return;
    } done({ url: `http://127.0.0.1:${address.port}/${token}/`, close: () => server.close() }); }); });
}
