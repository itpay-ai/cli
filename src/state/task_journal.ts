// Minimal local task journal: which Service Executions are paused at a human
// gate (login, rate limit) and how to resume the SAME execution. It stores
// no chat history, PII, credentials or tokens — only ids, stage and the
// resume command the owner flow already emitted. Business truth stays
// server-side; this file only makes "continue" point at the right task.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PAUSED_STAGES = new Set([
  "login_required",
  "rate_limited",
  "quota_paused",
  "auth_pending",
  "awaiting_input",
]);

const TERMINAL_STAGES = new Set([
  "completed",
  "delivered",
  "issued",
  "failed",
  "cancelled",
  "refunded",
]);

export interface TaskRecord {
  service_execution_id: string;
  service_id?: string;
  stage: string;
  resume_command?: string;
  updated_at: string;
}

interface TaskJournalFile {
  schema_version: "itpay.task_journal.v1";
  tasks: Record<string, TaskRecord>;
}

export class TaskJournal {
  constructor(private readonly path: string) {}

  record(task: Omit<TaskRecord, "updated_at">): void {
    const file = this.readFile();
    file.tasks[task.service_execution_id] = {
      ...task,
      updated_at: new Date().toISOString(),
    };
    this.writeFile(file);
  }

  clear(serviceExecutionID: string): void {
    const file = this.readFile();
    if (!file.tasks[serviceExecutionID]) return;
    delete file.tasks[serviceExecutionID];
    this.writeFile(file);
  }

  // Observe the latest stage without deleting history; terminal stages stop
  // the task from counting as resumable.
  observe(serviceExecutionID: string, stage: string, resumeCommand?: string): void {
    const file = this.readFile();
    const existing = file.tasks[serviceExecutionID];
    if (existing && existing.stage === stage && (resumeCommand === undefined || existing.resume_command === resumeCommand)) return;
    file.tasks[serviceExecutionID] = {
      service_execution_id: serviceExecutionID,
      ...(existing?.service_id ? { service_id: existing.service_id } : {}),
      stage,
      ...(resumeCommand ?? existing?.resume_command ? { resume_command: resumeCommand ?? existing!.resume_command } : {}),
      updated_at: new Date().toISOString(),
    };
    this.writeFile(file);
  }

  // Tasks paused behind login/quota gates, newest first. Terminal or
  // completed tasks never count as "still waiting for login".
  pausedTasks(): TaskRecord[] {
    const file = this.readFile();
    return Object.values(file.tasks)
      .filter((task) => PAUSED_STAGES.has(task.stage) && !TERMINAL_STAGES.has(task.stage))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  private readFile(): TaskJournalFile {
    if (!existsSync(this.path)) return { schema_version: "itpay.task_journal.v1", tasks: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as TaskJournalFile;
      if (parsed.schema_version !== "itpay.task_journal.v1" || !parsed.tasks || typeof parsed.tasks !== "object") {
        return { schema_version: "itpay.task_journal.v1", tasks: {} };
      }
      return parsed;
    } catch {
      return { schema_version: "itpay.task_journal.v1", tasks: {} };
    }
  }

  private writeFile(file: TaskJournalFile): void {
    // Bound the journal: keep only the 50 most recent task records.
    const entries = Object.entries(file.tasks).sort((left, right) => right[1].updated_at.localeCompare(left[1].updated_at));
    file.tasks = Object.fromEntries(entries.slice(0, 50));
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

