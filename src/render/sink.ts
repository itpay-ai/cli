// Centralised output sink used by every command. Lets tests silence
// stdout while still letting the real CLI write to the terminal.

export type OutputSink = (line: string) => void;

export const defaultOutput: OutputSink = (line) => process.stdout.write(line);

export function resolveOutput(sink?: OutputSink): OutputSink {
  return sink ?? defaultOutput;
}
