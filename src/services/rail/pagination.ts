import { writeSavedPage } from "../shared/pagination.js";
import { type CommandEnvelope, type CommandAction } from "../shared/envelope.js";
import { type ServicesCommandOptions } from "../shared/platform.js";

export function writeSavedRailPage(envelope: CommandEnvelope, options: ServicesCommandOptions & {all?:boolean}, key:"trains"|"journeys", offset:number, continuation:(offset:number)=>CommandAction):void {
writeSavedPage(envelope, options, key, offset, continuation, (result,count)=>{if(key === "trains") result.read_count=count;});
}
