import { randomUUID } from 'node:crypto';
import {chmodSync,existsSync,lstatSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {withFileLock} from './file_lock.js';
type SavedTask = { id: string; text: string; surface: "api" | "services"; request_id?: string; authorization_terminal?: "denied" | "cancelled" };

export function saveAgentTask(root: string, text: string | undefined, surface: string | undefined, request: string | undefined, newTask = false): SavedTask {
 const path = join(root, "task.json");
 mkdirSync(root,{recursive:true,mode:0o700});
 return withFileLock(path+".lock",()=>{
  let prior: SavedTask | undefined;
  if(existsSync(path)){
   if(!lstatSync(path).isFile() || (lstatSync(path).mode & 0o077)!==0)throw new Error("task state must be a private regular file");
   prior=JSON.parse(readFileSync(path,"utf8")) as SavedTask;
  }
  if(!text){if(!prior)throw new Error("task_required: supply the original user task and --surface api|services once");return prior;}
  if(text.length>16000||!text.trim()||!['api','services'].includes(surface??''))throw new Error("invalid task or surface");
  if(!newTask && prior?.text===text && prior.surface===surface){if(request&&request!==prior.request_id)throw new Error("original task request cannot be replaced");return prior;}
  if(prior && !newTask)throw new Error("task_conflict: resume without --task; only an explicitly new user intent uses --new-task");
  if(prior){mkdirSync(join(root,'tasks'),{recursive:true,mode:0o700});writeFileSync(join(root,'tasks',prior.id+'.json'),JSON.stringify(prior)+'\n',{mode:0o600});}
  const task:SavedTask={id:randomUUID(),text,surface:surface as SavedTask['surface'],...(request?{request_id:request}:{})};
  if(request&&!/^[A-Za-z0-9_-]{1,128}$/.test(request))throw new Error("invalid original request");
  const tmp=path+"."+randomUUID();writeFileSync(tmp,JSON.stringify(task)+"\n",{mode:0o600,flag:"wx"});chmodSync(tmp,0o600);renameSync(tmp,path);return task;
 });
}


// Attach before network dispatch. Never replace an accepted original request.
export function attachAgentRequest(selector: string | undefined, requestID: string): void {
 if(!selector)return;
 const path=join(dirname(dirname(selector)), 'task.json');
 if(!existsSync(path))return;
 withFileLock(path+'.lock',()=>{
  if(!lstatSync(path).isFile() || (lstatSync(path).mode&0o077)!==0)throw new Error('task state is not private');
  const task=JSON.parse(readFileSync(path,'utf8')) as SavedTask;
  if(task.surface!=='api'||!task.id)return;
  if(task.request_id && task.request_id!==requestID)throw new Error('task_conflict: original request already saved; status it before a new intent');
  task.request_id=requestID;
  const tmp=path+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(task)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,path);
 });
}

export function recordAgentAuthorization(root:string,phase:'denied'|'cancelled'):void {
 const path=join(root,'task.json');withFileLock(path+'.lock',()=>{
  const task=JSON.parse(readFileSync(path,'utf8')) as SavedTask;
  task.authorization_terminal=phase;const tmp=path+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(task)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,path);
 });
}
