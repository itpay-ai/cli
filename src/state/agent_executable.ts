import { isAbsolute } from 'node:path';
const quote=(s:string)=>"'"+s.replaceAll("'","'\"'\"'")+"'";
// Only task-driven entry continuations opt in. Legacy command/profile semantics stay intact.
export function pinAgentExecutable(command:string,env:NodeJS.ProcessEnv=process.env):string {
 const exe=env.ITPAY_AGENT_EXECUTABLE;
 if(!exe)return command;
 if(!isAbsolute(exe)||/[\r\n]/.test(exe))throw new Error('invalid pinned Agent executable');
 if(!/(^| )itpay(?= )/.test(command))return command;
 return `ITPAY_AGENT_EXECUTABLE=${quote(exe)} `+command.replace(/(^| )itpay(?= )/,(_,space:string)=>space+quote(process.execPath)+' '+quote(exe));
}
