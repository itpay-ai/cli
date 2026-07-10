import type { OutputSink } from "./sink.js";
import { readFileSync } from "node:fs";
import path from "node:path";

export function supportsInlineTerminalImages(): boolean {
  return Boolean(process.env.ITERM_SESSION_ID) || process.env.TERM_PROGRAM === "iTerm.app";
}

export function renderInlineTerminalImage(filePath: string, out: OutputSink): void {
  if (!supportsInlineTerminalImages()) return;
  try {
    const buf = readFileSync(filePath);
    const name = path.basename(filePath);
    const nameB64 = Buffer.from(name).toString("base64");
    const dataB64 = buf.toString("base64");
    out(`\u001b]1337;File=name=${nameB64};size=${buf.length};inline=1;preserveAspectRatio=1:${dataB64}\u0007\n`);
  } catch {
    return;
  }
}
