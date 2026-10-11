import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DeviceCacheContext {
  backend: string;
  agentType: string;
  keyThumbprint: string;
}
export interface DeviceCachedRegistration {
  deviceID: string;
  deviceKeyID: string;
  quotaLineageID: string;
  agentInstances: Record<string, string>;
  sessions: Record<string, { token: string; expiresAt: string }>;
}
interface CacheRecord extends DeviceCacheContext {
  schemaVersion: "itpay.device-session.v1";
  generation: string;
  registration: DeviceCachedRegistration;
}
function invalid(code: string): Error { return Object.assign(new Error(code), { code }); }
function readRegular(path: string): string | undefined {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("DEVICE_CACHE_INVALID_FILE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    // Concurrent atomic replacement is normal for reconstructible caches.
    // Read the complete opened snapshot; generation validation decides freshness.
    // O_NOFOLLOW and fstat still reject symlinks and non-regular opened files.
    if (!opened.isFile()) throw invalid("DEVICE_CACHE_INVALID_FILE");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function writeComplete(path: string, text: string, createOnly: boolean): boolean {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  try {
    if (createOnly) {
      try { linkSync(temp, path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    } else {
      readRegular(path); // Refuse an existing symlink or unexpected file.
      renameSync(temp, path);
    }
    return true;
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// Separate generation and session files: a late session write can never replace
// the invalidation marker. Every reader checks the generation after reading.
export class DeviceSessionCache {
  readonly cachePath: string;
  readonly generationPath: string;
  constructor(private readonly directory: string, private readonly context: DeviceCacheContext) {
    const name = createHash("sha256").update(JSON.stringify([context.backend, context.agentType, context.keyThumbprint])).digest("hex");
    this.cachePath = join(directory, `${name}.json`);
    this.generationPath = join(directory, `${name}.generation`);
  }
  private checkDirectory(): void {
    let stat;
    try { stat = lstatSync(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("DEVICE_CACHE_INVALID_FILE");
  }
  private prepareDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("DEVICE_CACHE_INVALID_FILE");
  }
  generation(create: boolean): string | undefined {
    this.checkDirectory();
    let value = readRegular(this.generationPath);
    if (value === undefined && create) {
      if (readRegular(this.cachePath) !== undefined) throw invalid("DEVICE_CACHE_GENERATION_MISSING");
      this.prepareDirectory();
      writeComplete(this.generationPath, randomUUID(), true);
      value = readRegular(this.generationPath);
    }
    if (value !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw invalid("DEVICE_CACHE_GENERATION_INVALID");
    return value;
  }
  read(): DeviceCachedRegistration | undefined {
    const before = this.generation(false);
    const text = readRegular(this.cachePath);
    if (text === undefined) return undefined;
    if (before === undefined) throw invalid("DEVICE_CACHE_GENERATION_MISSING");
    let record: CacheRecord;
    try { record = JSON.parse(text); } catch { throw invalid("DEVICE_CACHE_CORRUPT"); }
    if (!record || record.schemaVersion !== "itpay.device-session.v1" || record.backend !== this.context.backend || record.agentType !== this.context.agentType || record.keyThumbprint !== this.context.keyThumbprint) throw invalid("DEVICE_CACHE_CONTEXT_INVALID");
    if (record.generation !== before || before !== this.generation(false)) return undefined;
    const r = record.registration;
    const session = r?.sessions?.[this.context.agentType];
    if (!r || typeof r.deviceID !== "string" || typeof r.deviceKeyID !== "string" || typeof r.quotaLineageID !== "string" || typeof r.agentInstances?.[this.context.agentType] !== "string" || typeof session?.token !== "string" || typeof session.expiresAt !== "string" || !Number.isFinite(Date.parse(session.expiresAt))) throw invalid("DEVICE_CACHE_CORRUPT");
    return r;
  }
  registrationHint(): DeviceCachedRegistration | undefined {
    this.checkDirectory();
    const text = readRegular(this.cachePath);
    if (text === undefined) return undefined;
    let record: CacheRecord;
    try { record = JSON.parse(text); } catch { throw invalid("DEVICE_CACHE_CORRUPT"); }
    if (!record || record.schemaVersion !== "itpay.device-session.v1" || record.backend !== this.context.backend || record.agentType !== this.context.agentType || record.keyThumbprint !== this.context.keyThumbprint) throw invalid("DEVICE_CACHE_CONTEXT_INVALID");
    const r = record.registration;
    if (!r || typeof r.deviceID !== "string" || typeof r.deviceKeyID !== "string" || typeof r.quotaLineageID !== "string" || typeof r.agentInstances?.[this.context.agentType] !== "string") throw invalid("DEVICE_CACHE_CORRUPT");
    return { deviceID: r.deviceID, deviceKeyID: r.deviceKeyID, quotaLineageID: r.quotaLineageID, agentInstances: { [this.context.agentType]: r.agentInstances[this.context.agentType]! }, sessions: {} };
  }
  write(registration: DeviceCachedRegistration, generation: string): void {
    this.prepareDirectory();
    writeComplete(this.cachePath, JSON.stringify({ schemaVersion: "itpay.device-session.v1", ...this.context, generation, registration }), false);
  }
  invalidate(): void {
    this.generation(true);
    writeComplete(this.generationPath, randomUUID(), false);
  }
}

export function deviceCacheAgentTypes(directory: string, backend: string, keyThumbprint: string): string[] {
  let files: string[];
  try { files = readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const types = new Set<string>();
  for (const file of files.filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
    const text = readRegular(join(directory, file));
    if (text === undefined) continue;
    const value: CacheRecord = JSON.parse(text);
    if (value?.schemaVersion !== "itpay.device-session.v1") throw invalid("DEVICE_CACHE_CORRUPT");
    if (value.backend !== backend || value.keyThumbprint !== keyThumbprint) continue;
    if (typeof value.agentType !== "string") throw invalid("DEVICE_CACHE_CORRUPT");
    const cache = new DeviceSessionCache(directory, value);
    if (cache.cachePath !== join(directory, file)) throw invalid("DEVICE_CACHE_CONTEXT_INVALID");
    types.add(value.agentType);
  }
  return [...types].sort();
}
