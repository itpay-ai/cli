import type {ServiceExecutionReadModel} from "../../client/types.js";
export function railShouldWait(model:ServiceExecutionReadModel):boolean|undefined{
 if(model.rail_booking)return false;
 const plan=model.rail_planning;
 if(!plan)return undefined;
 return !plan.recommendation && !(plan.alternatives?.length) &&
 !["complete","paused","failed","cancelled","expired"].includes(plan.search?.expansion_status ?? "") &&
 !plan.available_actions?.some(action=>["select_journey","confirm_location","expand_search"].includes(action.type));
}
export function railPollAfter(model:ServiceExecutionReadModel):number{return model.rail_planning?.search?.poll_after_ms ?? 0;}
