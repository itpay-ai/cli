import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

interface LegacyOperationJournalState {
  schemaVersion: "itpay.operations.v1";
  operations: Record<string, { id: string; createdAt: string }>;
}

interface OperationRecord {
  schemaVersion: "itpay.operation.v2";
  operationKeyHash: string;
  id: string;
  createdAt: string;
}

export class OperationJournal {
  constructor(private readonly legacyPath: string) {}

  async getOrCreate(operationKey: string): Promise<string> {
    const operationKeyHash = createHash("sha256").update(operationKey).digest("hex");
    const recordDirectory = `${this.legacyPath}.d`;
    const recordPath = resolve(recordDirectory, `${operationKeyHash}.json`);
    const existing = readRecord(recordPath, operationKeyHash);
    if (existing) return existing.id;

    mkdirSync(recordDirectory, { recursive: true, mode: 0o700 });
    chmodSync(recordDirectory, 0o700);
    const record: OperationRecord = {
      schemaVersion: "itpay.operation.v2",
      operationKeyHash,
      id: this.readLegacyID(operationKey) ?? `op_${randomUUID().replaceAll("-", "")}`,
      createdAt: new Date().toISOString(),
    };
    const temporaryPath = resolve(recordDirectory, `.${basename(recordPath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      try {
        linkSync(temporaryPath, recordPath);
        chmodSync(recordPath, 0o600);
        return record.id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const winner = readRecord(recordPath, operationKeyHash);
        if (!winner) throw new Error("ItPay operation journal record disappeared during publication");
        return winner.id;
      }
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private readLegacyID(operationKey: string): string | undefined {
    if (!existsSync(this.legacyPath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.legacyPath, "utf8")) as LegacyOperationJournalState;
      if (parsed.schemaVersion !== "itpay.operations.v1" || !parsed.operations) return undefined;
      const id = parsed.operations[operationKey]?.id;
      return typeof id === "string" && isOperationID(id) ? id : undefined;
    } catch {
      return undefined;
    }
  }
}

function readRecord(path: string, expectedHash: string): OperationRecord | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("ItPay operation journal record is invalid");
  }
  if (!isOperationRecord(parsed, expectedHash)) {
    throw new Error("ItPay operation journal record is invalid");
  }
  return parsed;
}

function isOperationRecord(value: unknown, expectedHash: string): value is OperationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OperationRecord>;
  return record.schemaVersion === "itpay.operation.v2" &&
    record.operationKeyHash === expectedHash &&
    typeof record.id === "string" && isOperationID(record.id) &&
    typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt));
}

function isOperationID(value: string): boolean {
  return /^op_[a-zA-Z0-9_-]+$/.test(value);
}
