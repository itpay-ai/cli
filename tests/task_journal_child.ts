import {TaskJournal} from '../src/state/task_journal.js';
const [path,id]=process.argv.slice(2);if(!path||!id)throw Error('fixture path/id required');
const journal=new TaskJournal(path);
journal.record({service_execution_id:id,stage:'login_required',resume_command:`itpay services next ${id} --json`});
for(let i=0;i<10;i++)journal.recordAutomaticWait('shared-original',100);
process.stdout.write('stored');
