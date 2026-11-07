import {createHash} from "node:crypto";
import {mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {withFileLock} from "./file_lock.js";
import {hubCredentialsPath} from "./hub_credentials.js";
import {loadHubConfig,type OperationDescriptor} from "../client/hub.js";

export type ShelfDescriptor=OperationDescriptor&{example_input:Record<string,unknown>;shown_event_id?:string};
function cachePath(operation:string):string {
 const origin=loadHubConfig().baseURL;
 const key=createHash("sha256").update(origin+"\0"+operation).digest("hex");
 return join(dirname(hubCredentialsPath()),"shown",key+".json");
}
export function saveShown(value:ShelfDescriptor):void{
 const path=cachePath(value.operation_id);
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 withFileLock(path+".lock",()=>{
  const temporary=path+"."+process.pid+".tmp";
  const publication=createHash("sha256").update(value.current_publication_id).digest("hex");
  const versioned=path+"."+publication;
  try {
   writeFileSync(temporary,JSON.stringify(value),{mode:0o600});
   renameSync(temporary,versioned);
   writeFileSync(temporary,JSON.stringify({publication:versioned}),{mode:0o600});
   renameSync(temporary,path);
  } finally {try{unlinkSync(temporary)}catch{/* Already renamed or never written. */}}
 });
}
export function loadShown(operation:string):ShelfDescriptor{
 try{
  const path=cachePath(operation);
  const pointer=JSON.parse(readFileSync(path,"utf8")) as {publication:string};
  if(!pointer.publication.startsWith(path+".") || !/^[a-f0-9]{64}$/.test(pointer.publication.slice(path.length+1)))throw new Error("invalid display pointer");
  const value=JSON.parse(readFileSync(pointer.publication,"utf8")) as ShelfDescriptor;
  if(value.operation_id===operation && value.current_publication_id && value.input_schema &&
    value.price_card.mode!=="unconfigured") return value;
 }catch{/* A missing or corrupt display cannot authorize a priced request. */}
 throw new Error("show_required: 先用 show 查看用途和价格");
}
