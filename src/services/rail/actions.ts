import type {ServiceExecutionReadModel} from "../../client/types.js";
import {shellArgument} from "../shared/envelope.js";

// Never copy server shell text. Known action facts select a fixed local CLI form.
export function railAvailableActions(plan:NonNullable<ServiceExecutionReadModel["rail_planning"]>,executionID:string):Record<string,unknown>[] {
 return (plan.available_actions ?? []).map(action=>{
  const target=action.target;
  const se=shellArgument(executionID);
  const snapshot=target?.snapshot_id ?? plan.catalog_snapshot_id ?? plan.snapshot_id;
  const snap=snapshot?shellArgument(snapshot):undefined;
  let command:string|undefined;
  let input:Record<string,unknown>|undefined;
  if(!target || target.service_execution_id===executionID){
   switch(action.type){
    case "read_updates":command=`itpay services next ${se}${snap?` --since-snapshot ${snap}`:""} --json`;break;
    case "read_saved_page":if(snap)command=`itpay services page ${se} ${snap} --json`;break;
    case "read_catalog":if(snap)command=`itpay services read-result ${se} --snapshot ${snap} --json`;break;
    case "read_journey":if(snap && target?.journey_id)command=`itpay services read-result ${se} --snapshot ${snap} --journey ${shellArgument(target.journey_id)} --json`;break;
    case "select_journey":if(target?.journey_id)command=`itpay services action ${se} --action select_journey --actor-type human --status approved --input ${shellArgument(`journey_id=${target.journey_id}`)} --json`;break;
    case "expand_search":{
     const facts=action.input;
     if(typeof facts?.action_request_id==="string" && typeof facts.expected_query_revision==="number" && typeof facts.snapshot_id==="string"){
      input={action_request_id:facts.action_request_id,expected_query_revision:facts.expected_query_revision,snapshot_id:facts.snapshot_id};
      command=`itpay services action ${se} --action workflow:expand_search --actor-type human --status approved --input-json <file> --json`;
     }break;
    }
    case "refine_preferences":input=action.input_example;command=`itpay services action ${se} --action workflow:refine_preferences --actor-type human --status approved --input-json <file> --json`;break;
    case "stop_search":command=`itpay services action ${se} --action workflow:stop_search --actor-type human --status approved --json`;break;
   }
  }
  return {type:action.type,provider_effect:action.provider_effect,...(action.when?{when:action.when}:{}),...(command?{command,...(input?{input_template:{input,executable:false},...(action.input_schema?{input_schema:action.input_schema}:{}),...(action.type==="refine_preferences"?{instruction:"仅填用户改变的偏好，保留 expected_query_revision；rerank 复用已存事实，不新增查车。示例不是用户选择，端点/日期改变须新查询。"}:{})}:{})}:{instruction:"缺少当前动作的结构化合同事实；保留原执行，不执行服务器命令文本。"})};
 });
}
