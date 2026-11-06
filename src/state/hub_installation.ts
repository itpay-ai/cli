import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hubOAuthConfig } from "./hub_oauth.js";
import { withFileLock } from "./file_lock.js";
import { API_CONTRACT_REVISION, CLI_VERSION } from "./release_identity.js";

interface HubInstallation {
  profile_id: string;
  state_root: string;
  hub: string;
  issuer: string;
  client_id: string;
  scope: string;
  version: string;
  source: string;
}

let activeSelector: string | undefined;

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function absolute(path: string): string {
  if (!isAbsolute(path) || /[\r\n]/.test(path)) throw new Error("API profile requires an absolute path");
  return resolve(path);
}

function origin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) && url.origin === value;
  } catch {
    return false;
  }
}

function readProfile(path: string): HubInstallation {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("API profile must be a private regular file");
  const profile = JSON.parse(readFileSync(path, "utf8")) as HubInstallation;
  if (!profile || typeof profile.profile_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(profile.profile_id)
    || typeof profile.state_root !== "string" || profile.state_root !== join(dirname(path), "state")
    || !origin(profile.hub) || !origin(profile.issuer)
    || typeof profile.client_id !== "string" || !/^[A-Za-z0-9._-]+$/.test(profile.client_id)
    || typeof profile.scope !== "string" || !/^[a-z_. ]+$/.test(profile.scope)
    || typeof profile.version !== "string" || typeof profile.source !== "string") {
    throw new Error("invalid API installation profile");
  }
  return profile;
}

function atomicWrite(path: string, content: string, mode: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function newInstallation(root: string): HubInstallation {
  const cfg = hubOAuthConfig();
  const issuer = new URL(cfg.tokenURL).origin;
  if (issuer + "/oauth2/token" !== cfg.tokenURL || !origin(issuer) || !origin(cfg.resource)
    || !/^[A-Za-z0-9._-]+$/.test(cfg.clientID) || !/^[a-z_. ]+$/.test(cfg.scope)) {
    throw new Error("invalid API installation endpoint");
  }
  return {
    profile_id: randomUUID(),
    state_root: join(root, "state"),
    hub: cfg.resource,
    issuer,
    client_id: cfg.clientID,
    scope: cfg.scope,
    version: CLI_VERSION,
    source: API_CONTRACT_REVISION,
  };
}

export function prepareHubInstallation(prefix: string, executable = process.argv[1]): { selector: string; launcher: string; profile_id: string } {
  const root = absolute(prefix);
  if (!executable) throw new Error("API launcher requires an installed CLI entry point");
  const selector = join(root, "api-profile.json");
  const launcher = join(root, "bin", "itpay");
  return withFileLock(selector + ".lock", () => {
    const command = `#!/bin/sh\ncase "$1" in api|hub) shift ;; esac\nfor arg do\n  case "$arg" in --profile|--profile=*) exit 2 ;; esac\ndone\nexec ${shellQuote(process.execPath)} ${shellQuote(absolute(executable))} api --profile ${shellQuote(selector)} "$@"\n`;
    if (existsSync(launcher) && (!lstatSync(launcher).isFile() || readFileSync(launcher, "utf8") !== command)) {
      throw new Error("API installation already has a different launcher");
    }
    const profile = existsSync(selector) ? readProfile(selector) : newInstallation(root);
    mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
    if (!existsSync(selector)) atomicWrite(selector, JSON.stringify(profile, null, 2) + "\n", 0o600);
    if (!existsSync(launcher)) atomicWrite(launcher, command, 0o700);
    return { selector, launcher, profile_id: profile.profile_id };
  });
}

export function selectHubInstallation(selector: string): void {
  const path = absolute(selector);
  const profile = readProfile(path);
  // One API command per process. Services state remains independent.
  process.env.ITPAY_STATE_DIR = join(profile.state_root, "hub-profiles", profile.profile_id);
  process.env.ITPAY_HUB_URL = profile.hub;
  process.env.ITPAY_HUB_OAUTH_ISSUER = profile.issuer;
  process.env.ITPAY_HUB_OAUTH_CLIENT = profile.client_id;
  process.env.ITPAY_HUB_OAUTH_SCOPE = profile.scope;
  delete process.env.ITPAY_HUB_TOKEN;
  delete process.env.ITPAY_HUB_KEY;
  activeSelector = path;
}

export function qualifyHubInstallation(command: string): string | undefined {
  const apiPrefix = /^itpay(?: --agent-type(?:=| )[a-z0-9-]+)? (?:api|hub)(?= |$)/;
  if (!activeSelector || !apiPrefix.test(command)) return undefined;
  return command.replace(apiPrefix, prefix => `${prefix} --profile ${shellQuote(activeSelector!)}`);
}
