import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function invalid(code: string): Error { return Object.assign(new Error(code), { code }); }
export function readDeviceKey(path: string): KeyObject | undefined {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("DEVICE_KEY_INVALID_FILE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw invalid("DEVICE_KEY_CHANGED");
    const key = createPrivateKey(readFileSync(fd, "utf8"));
    if (key.asymmetricKeyType !== "ed25519") throw invalid("DEVICE_KEY_INVALID");
    return key;
  } finally { closeSync(fd); }
}
export function deviceKeyThumbprint(key: KeyObject): string {
  return createHash("sha256").update(createPublicKey(key).export({ format: "der", type: "spki" })).digest("hex");
}
// Only a complete key is published. EEXIST means a competing creator won;
// every caller uses the canonical file, never its unpublished generated key.
export function createDeviceKey(path: string, existingIdentity: boolean): KeyObject {
  const existing = readDeviceKey(path);
  if (existing) return existing;
  if (existingIdentity) throw invalid("DEVICE_KEY_MISSING");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const key = generateKeyPairSync("ed25519").privateKey;
  writeFileSync(temp, key.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
  let canonicalPublished = false;
  try {
    try { linkSync(temp, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const canonical = readDeviceKey(path);
    if (!canonical) throw invalid("DEVICE_KEY_MISSING");
    canonicalPublished = true;
    return canonical;
  } finally {
    try { unlinkSync(temp); } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error("Key temporary cleanup failed"), { deviceStateOperation: "cleanup_private_key_temporary", canonicalKeyPublished: canonicalPublished });
    }
  }
}
