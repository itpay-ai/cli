import { OperationJournal } from "../src/state/operation_journal.js";

const path = process.argv[2];
const key = process.argv[3];
if (!path || !key) throw new Error("operation journal child requires path and key");
process.stdout.write(await new OperationJournal(path).getOrCreate(key));
