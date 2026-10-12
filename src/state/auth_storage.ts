import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { stateDir } from './config.js';

export type Login = { baseURL: string; sessionToken?: string; expiresAt?: string; sessionID?: string; pollToken?: string; startToken?: string; authURL?: string };
export function authStatePath(baseURL: string, env: NodeJS.ProcessEnv, purpose: string): string {
  return resolve(stateDir(env), `${purpose}-${createHash('sha256').update(baseURL).digest('hex').slice(0, 16)}.json`);
}
export function readAuthState(baseURL: string, env: NodeJS.ProcessEnv, purpose: string): Login | undefined {
  const path = authStatePath(baseURL, env, purpose);
  if (!existsSync(path)) return;
  const state = JSON.parse(readFileSync(path, 'utf8')) as Login;
  if (state.baseURL !== baseURL) throw new Error('Account authorization backend mismatch');
  return state;
}
export function saveAuthState(state: Login, env: NodeJS.ProcessEnv, purpose: string) {
  const path = authStatePath(state.baseURL, env, purpose);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}
