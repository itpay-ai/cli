// Cross-process file lock (F-R01): owner-token lock via atomic `wx` create,
// PID-liveness stale recovery. Used by the per-task Hub task store. Blocking
// wait uses Atomics.wait — allowed on the Node main thread.
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ownerAlive(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return false;
    // Another process may observe wx creation before the owner-token write.
    // A fresh, unfinished file is held, never a crash orphan.
    if (Date.now() - st.mtimeMs < STALE_MS) return true;
    const token = readFileSync(path, "utf8");
    const pid = Number(/^(\d+):/.exec(token)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch {
    return false;
  }
}

/** Run `fn` while holding an exclusive lock file. Tolerates crash-orphans. */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
      chmodSync(lockPath, 0o600);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (!ownerAlive(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* raced */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`task store lock busy: ${lockPath}`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
    } catch { /* best-effort release */ }
  }
}

/** Keep the lock through awaited token rotation; never block the event loop. */
export async function withAsyncFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!ownerAlive(lockPath)) { try { unlinkSync(lockPath); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) throw new Error("credential refresh lock busy");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await fn(); }
  finally { try { if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath); } catch { /* released */ } }
}
