import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

import type { TransportDiagnosticEvent, TransportObserver } from "../client/transport.js";

const MAX_LOG_BYTES = 512 * 1024;

export class TransportDiagnostics {
  readonly observe: TransportObserver;

  constructor(readonly path: string) {
    this.observe = (event) => this.append(event);
  }

  private append(event: TransportDiagnosticEvent): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.rotateIfNeeded();
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path) || statSync(this.path).size < MAX_LOG_BYTES) return;
    const previous = `${this.path}.previous`;
    rmSync(previous, { force: true });
    renameSync(this.path, previous);
    chmodSync(previous, 0o600);
  }
}
