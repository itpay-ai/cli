import { CommandContractError, writeCommandEnvelope, type CommandEnvelope, type CommandAction } from "./envelope.js";
import { type ServicesCommandOptions } from "./platform.js";
import { type OutputSink } from "../../render/sink.js";

// Bound the final qualified output by whole saved rows; the cursor follows the emitted rows.
export function writeSavedPage(envelope: CommandEnvelope, options: ServicesCommandOptions & { all?: boolean },
  key: string, offset: number, continuation: (offset: number) => CommandAction, updateMetadata: (result: Record<string, unknown>, count: number) => void): void {
  const result = envelope.result ?? {};
  const rows = result[key];
  if (!Array.isArray(rows)) throw new Error("saved page has no rows");
  const bound = (offset === 0 ? 12 : 32) * 1024;
  const render = (output: OutputSink) => writeCommandEnvelope(envelope, { ...options, output });
  if (!options.all) {
    for (;;) {
      let text = "";
      render(value => { text += value; });
      if (Buffer.byteLength(text, "utf8") <= bound) break;
      if (rows.length <= 1) {
        throw new CommandContractError("saved_row_too_large", "saved row exceeds the readable page limit",
          "这条已保存记录超过当前页面大小；事实仍保留，请读取该条详情。", rows[0]?.detail?.command ? [rows[0].detail] : []);
      }
      rows.pop();
      result.truncated_reason = "cli_output_byte_budget";
      result.count = rows.length;
      updateMetadata(result, rows.length);
      result.next_offset = offset + rows.length;
      envelope.next = continuation(offset + rows.length);
    }
  }
  writeCommandEnvelope(envelope, options);
}
