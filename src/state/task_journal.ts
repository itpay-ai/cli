// Local recovery references only. Business truth and admission stay with owner.
// Immutable changes use the same atomic publication as operation_journal;
// concurrent processes never replace another task's snapshot or wait charges.
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,linkSync,lstatSync,mkdirSync,readFileSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export const PAUSED_STAGES=new Set(['login_required','rate_limited','quota_paused','auth_pending','awaiting_input']);
const TERMINAL_STAGES=new Set(['completed','delivered','issued','failed','cancelled','refunded']);
export interface TaskRecord {service_execution_id:string;service_id?:string;stage:string;resume_command?:string;updated_at:string;automatic_wait_ms?:number}
type TaskInput=Omit<TaskRecord,'updated_at'>;
type Change={schema_version:'itpay.task_change.v1';event_id:string;updated_at:string;monotonic:string;id:string}&(
 {kind:'record';task:TaskInput}|{kind:'observe';stage:string;resume_command?:string}|{kind:'clear'}|{kind:'wait';milliseconds:number});
interface View {tasks:Record<string,TaskRecord>;spent:Map<string,number>}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
function validTask(v:unknown):v is TaskRecord {return object(v)&&typeof v.service_execution_id==='string'&&typeof v.stage==='string'&&typeof v.updated_at==='string'&&Number.isFinite(Date.parse(v.updated_at))&&(v.service_id===undefined||typeof v.service_id==='string')&&(v.resume_command===undefined||typeof v.resume_command==='string')&&(v.automatic_wait_ms===undefined||finite(v.automatic_wait_ms));}
function validChange(v:unknown):v is Change {
 if(!object(v)||v.schema_version!=='itpay.task_change.v1'||typeof v.event_id!=='string'||typeof v.id!=='string'||typeof v.updated_at!=='string'||!Number.isFinite(Date.parse(v.updated_at))||typeof v.monotonic!=='string'||!/^\d{1,30}$/.test(v.monotonic))return false;
 if(v.kind==='clear')return true;
 if(v.kind==='wait')return finite(v.milliseconds);
 if(v.kind==='observe')return typeof v.stage==='string'&&(v.resume_command===undefined||typeof v.resume_command==='string');
 return v.kind==='record'&&object(v.task)&&validTask({...v.task,updated_at:v.updated_at})&&v.task.service_execution_id===v.id;
}
const taskHash=(id:string)=>createHash('sha256').update(id).digest('hex');
function invalid():never {throw Object.assign(new Error('ItPay task journal is invalid; original records are unchanged'),{code:'task_journal_invalid'});}
export class TaskJournal {
 constructor(private readonly path:string){}
 record(task:TaskInput):void {this.readFile(task.service_execution_id);this.append({kind:'record',id:task.service_execution_id,task});}
 clear(id:string):void {if(this.readFile(id).tasks[id])this.append({kind:'clear',id});}
 observe(id:string,stage:string,resumeCommand?:string):void {
  const existing=this.readFile(id).tasks[id];
  if(existing&&(TERMINAL_STAGES.has(existing.stage)||existing.stage===stage&&(resumeCommand===undefined||existing.resume_command===resumeCommand)))return;
  this.append({kind:'observe',id,stage,...(resumeCommand===undefined?{}:{resume_command:resumeCommand})});
 }
 remainingAutomaticWait(id:string):number {try{return Math.max(0,120000-(this.readFile(id).spent.get(id)??0));}catch{return 0;}}
 recordAutomaticWait(id:string,milliseconds:number):number {
  if(!finite(milliseconds)||this.remainingAutomaticWait(id)===0)return 0;
  if(milliseconds>0)this.append({kind:'wait',id,milliseconds:Math.min(120000,milliseconds)});
  return this.remainingAutomaticWait(id);
 }
 pausedTasks():TaskRecord[]{return Object.values(this.readFile().tasks).filter(t=>PAUSED_STAGES.has(t.stage)&&!TERMINAL_STAGES.has(t.stage)).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));}
 private readFile(onlyID?:string):View {
  const tasks=new Map<string,TaskRecord>(),spent=new Map<string,number>(),cleared=new Set<string>();
  // Existing v1 state is a read-only base; never rewrite or delete identity-era evidence.
  if(existsSync(this.path)){
   let old:unknown;try{old=JSON.parse(readFileSync(this.path,'utf8'));}catch{return invalid();}
   if(!object(old)||old.schema_version!=='itpay.task_journal.v1'||!object(old.tasks))return invalid();
   for(const [id,task]of Object.entries(old.tasks)){if(!validTask(task)||task.service_execution_id!==id)return invalid();if(onlyID===undefined||onlyID===id){tasks.set(id,task);spent.set(id,task.automatic_wait_ms??0);}}
  }
  const directory=this.path+'.d';
  const changes:Change[]=[];
  if(existsSync(directory)&&(!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink()))return invalid();
  if(existsSync(directory))for(const name of readdirSync(directory).filter(n=>n.endsWith('.json')&&(onlyID===undefined||n.startsWith(taskHash(onlyID)+'-')||!/^\w{64}-[\da-f-]+\.json$/.test(n)))){
   const path=join(directory,name);const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())return invalid();
   let raw:unknown;try{raw=JSON.parse(readFileSync(path,'utf8'));}catch{return invalid();}
   if(!validChange(raw)||name!==taskHash(raw.id)+'-'+raw.event_id+'.json')return invalid();changes.push(raw);
  }
  changes.sort((a,b)=>a.updated_at.localeCompare(b.updated_at)||(BigInt(a.monotonic)<BigInt(b.monotonic)?-1:BigInt(a.monotonic)>BigInt(b.monotonic)?1:a.event_id.localeCompare(b.event_id)));
  for(const change of changes){
   const id=change.id,existing=tasks.get(id);
   if(change.kind==='wait'){
    spent.set(id,Math.min(120000,(spent.get(id)??0)+change.milliseconds));
    if(!cleared.has(id))tasks.set(id,{...(existing??{service_execution_id:id,stage:'running'}),updated_at:change.updated_at,automatic_wait_ms:spent.get(id)??0});
   }else if(change.kind==='clear'){tasks.delete(id);cleared.add(id);}
   else if(change.kind==='record'){
    cleared.delete(id);spent.set(id,Math.max(spent.get(id)??0,change.task.automatic_wait_ms??0));
    tasks.set(id,{...change.task,updated_at:change.updated_at,automatic_wait_ms:spent.get(id)??0});
   }else if(!cleared.has(id)&&(!existing||!TERMINAL_STAGES.has(existing.stage))){
    tasks.set(id,{...(existing??{service_execution_id:id}),stage:change.stage,...(change.resume_command===undefined?{}:{resume_command:change.resume_command}),updated_at:change.updated_at,automatic_wait_ms:spent.get(id)??0});
   }
  }
  return {tasks:Object.fromEntries([...tasks].sort((a,b)=>b[1].updated_at.localeCompare(a[1].updated_at)).slice(0,50)),spent};
 }
 private append(change:{kind:'record';id:string;task:TaskInput}|{kind:'observe';id:string;stage:string;resume_command?:string}|{kind:'clear';id:string}|{kind:'wait';id:string;milliseconds:number}):void {
  const event:Change={...change,schema_version:'itpay.task_change.v1',event_id:randomUUID(),updated_at:new Date().toISOString(),monotonic:process.hrtime.bigint().toString()};
  if(!validChange(event))return invalid();
  const directory=this.path+'.d';mkdirSync(directory,{recursive:true,mode:0o700});
  if(!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink())return invalid();
  const temp=join(directory,'.'+event.event_id+'.tmp'),target=join(directory,taskHash(event.id)+'-'+event.event_id+'.json');
  try{writeFileSync(temp,JSON.stringify(event),{flag:'wx',mode:0o600});linkSync(temp,target);}
  finally{try{unlinkSync(temp);}catch(e){if(!object(e)||e.code!=='ENOENT')throw e;}}
 }
}
