// Hub command protocol. Credentials are never added to this output envelope.
export interface CommandAction { command: string; reason: string; poll_after_ms?: number }
export interface CommandEnvelope {
 status: string;
 result?: unknown;
 error?: {code: string; message: string};
 instruction: string;
 next: CommandAction | null;
 recovery: CommandAction[];
 [key: string]: unknown;
}
export function writeCommandEnvelope(value: CommandEnvelope, options: {jsonOutput?: boolean; output?: (text: string) => void; plainResult?: string[]} = {}): void {
 const out = options.output ?? ((text: string) => { process.stdout.write(text); });
 if (options.jsonOutput) { out(JSON.stringify(value, null, 2) + "\n"); return; }
 out(value.status + "\n");
 for (const line of options.plainResult ?? [JSON.stringify(value.error ?? value.result ?? {}, null, 2)]) out(line + "\n");
 out("instruction: " + value.instruction + "\n");
 if (value.next) out("next: " + value.next.command + "\n  when: " + value.next.reason + "\n");
 for (const action of value.recovery) out("recovery: " + action.command + "\n  when: " + action.reason + "\n");
}
