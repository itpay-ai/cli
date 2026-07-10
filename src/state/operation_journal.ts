import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

interface OperationJournalState {
  schemaVersion: "itpay.operations.v1";
  operations: Record<string, { id: string; createdAt: string }>;
}

export class OperationJournal {
  constructor(private readonly path: string) {}

  async getOrCreate(operationKey: string): Promise<string> {
    return withFileLock(`${this.path}.lock`, async () => {
      const state = this.read();
      const existing = state.operations[operationKey];
      if (existing) return existing.id;
      const id = `op_${randomUUID().replaceAll("-", "")}`;
      state.operations[operationKey] = { id, createdAt: new Date().toISOString() };
      atomicOwnerOnlyWrite(this.path, JSON.stringify(state, null, 2));
      return id;
    });
  }

  private read(): OperationJournalState {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as OperationJournalState;
        if (parsed.schemaVersion === "itpay.operations.v1" && parsed.operations) return parsed;
      } catch {
        // A malformed local cache is replaced; server facts remain authoritative.
      }
    }
    return { schemaVersion: "itpay.operations.v1", operations: {} };
  }
}

function atomicOwnerOnlyWrite(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      descriptor = openSync(path, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (descriptor === undefined) throw new Error("timed out waiting for ItPay operation journal lock");
  try {
    return await run();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
