import { z } from "zod";
import type { BackendClient } from "../../client/backend.js";
import type { RailAftercareView,RailAftercareDirectory,RailAftercareInput,RailAftercareResponseInput } from "../../client/types.js";
import { operationID, type CLIConfig } from "../../state/config.js";
import { CommandContractError, type CommandEnvelope } from "../shared/envelope.js";

const target = z.object({leg_index:z.number().int().nonnegative(),passenger_index:z.number().int().nonnegative()}).strict();
const inputSchema = z.object({operation:z.enum(["refund","change"]),targets:z.array(target).min(1).max(15),reason:z.string().trim().min(1).max(1000),scope_revision:z.literal(1),user_confirmed_scope:z.literal(true),change:z.object({travel_date:z.string().optional(),departure_after:z.string().optional(),arrival_before:z.string().optional(),seat_type:z.string().optional(),train_code:z.string().optional(),constraints:z.string().min(1).max(1000)}).strict().optional()}).strict();
const responseSchema = z.object({expected_revision:z.number().int().positive(),proposal_revision:z.number().int().positive().optional(),user_approved:z.boolean().optional(),additional_information:z.string().max(1000).optional(),reason:z.string().max(1000).optional()}).strict();
export function railAftercareList(directory:RailAftercareDirectory,orderID:string):CommandEnvelope{
 return {status:"aftercare_directory",result:{...directory},instruction:directory.instruction+"段/乘客索引从0起，按返回事实选目标；明确‘第二段’用leg_index:1。整程模板列全部可用目标，指定范围则仅保留对应目标，不手填票价/供应商单号。范围已明确只说明后提交；不重新询问整程选择。",next:null,recovery:[],interaction:{schema_version:"itpay.interaction.v1",stage:"input_required",input_templates:Object.fromEntries(Object.entries(directory.input_templates).map(([operation,input])=>[operation,{command:`itpay aftercare create --order ${orderID} --input-json <file> --json`,input,executable:false,required_input:["file","targets","reason","user_confirmed_scope"]}]))}};
}
export function railAftercareEnvelope(view:RailAftercareView):CommandEnvelope{
 const c=view.case;
 const instruction=c.status==="awaiting_confirmation" ? "展示当前具体改签方案、旧新对应、差价和条件；旧购买委托不是新方案/费用批准。没有真实回答保持false并等待；本轮费用由人工协调，没有自动支付链接。"
 :c.status==="needs_input" ? "展示管理员要求补充的内容，只补缺失事实；保留原申请范围。"
 :c.status==="completed" ? "人工受理已完成；分别说明供应商核验结果与平台退款金额/状态。未退段仅报告权威已知事实，不保证仍可乘；不恢复平台内容访问锁。"
 :c.status==="processing" ? "原申请正在人工办理或财务处理中；没有最终事实不说退票、改签或到账成功，不重试未知资金、不取消已发生操作。"
 :["cancelled","rejected"].includes(c.status) ? "说明原申请已取消或被拒绝及原因；没有撤销已发生供应商操作，也不自动创建替代购买。"
 :"已提交人工受理，尚未确认供应商退票/改签或钱款到账。先交付申请状态入口，再按用户意愿查询原申请，不循环轮询。";
 const cancellation=view.can_cancel ? {cancel_template:{command:`itpay aftercare cancel ${c.case_id} --input-json <file> --json`,input:{expected_revision:c.revision,reason:""},executable:false,required_input:["file"]}} : {};
 const needsReply=["awaiting_confirmation","needs_input"].includes(c.status);
 return {status:c.status,result:{...view},instruction,next:needsReply||["completed","cancelled","rejected"].includes(c.status)?null:{command:`itpay aftercare get ${c.case_id} --json`,reason:"按用户要求读取同一人工申请"},recovery:[],...((needsReply||view.can_cancel)?{interaction:{schema_version:"itpay.interaction.v1",stage:c.status==="awaiting_confirmation"?"consent_required":"input_required",...cancellation,...(needsReply?{input_template:{command:`itpay aftercare respond ${c.case_id} --input-json <file> --json`,input:{expected_revision:c.revision,...(c.status==="awaiting_confirmation"?{proposal_revision:c.proposal_revision,user_approved:false}:{additional_information:""})},executable:false,required_input:["file"]}}:{})}}:{})};
}
export async function railAftercareCreate(backend:BackendClient,config:CLIConfig,orderID:string,raw:unknown):Promise<CommandEnvelope>{
 const parsed=inputSchema.safeParse(raw);if(!parsed.success)throw new CommandContractError("rail_aftercare_input_invalid","Aftercare input fields or genuine scope confirmation are missing","Agent读取当前完整模板修正技术字段；只问缺失的真实范围/改签意向，不让用户填技术JSON。",[{command:`itpay aftercare list --order ${orderID} --json`,reason:"读取当前行程、目标和完整模板"}]);
 const value=parsed.data;
 const change=value.change;
 const input:RailAftercareInput={operation:value.operation,targets:value.targets,reason:value.reason,scope_revision:value.scope_revision,user_confirmed_scope:value.user_confirmed_scope,...(change?{change:{constraints:change.constraints,...(change.travel_date!==undefined?{travel_date:change.travel_date}:{}),...(change.departure_after!==undefined?{departure_after:change.departure_after}:{}),...(change.arrival_before!==undefined?{arrival_before:change.arrival_before}:{}),...(change.seat_type!==undefined?{seat_type:change.seat_type}:{}),...(change.train_code!==undefined?{train_code:change.train_code}:{})}}:{})};
 return railAftercareEnvelope(await backend.createRailAftercare(orderID,input,await operationID(config,`aftercare.create:${orderID}:${JSON.stringify(input)}`)));
}
export async function railAftercareGet(backend:BackendClient,id:string):Promise<CommandEnvelope>{return railAftercareEnvelope(await backend.getRailAftercare(id));}
export async function railAftercareRespond(backend:BackendClient,id:string,raw:unknown,cancel=false):Promise<CommandEnvelope>{
 const parsed=responseSchema.safeParse(raw);if(!parsed.success)throw new CommandContractError("rail_aftercare_input_invalid","Current revision or response fields are missing","使用原申请当前返回模板；实质方案变化须重新取得明确同意。",[{command:`itpay aftercare get ${id} --json`,reason:"读取同一申请当前方案和版本"}]);
 const value=parsed.data;
 const input:RailAftercareResponseInput={expected_revision:value.expected_revision,...(value.proposal_revision!==undefined?{proposal_revision:value.proposal_revision}:{}),...(value.user_approved!==undefined?{user_approved:value.user_approved}:{}),...(value.additional_information!==undefined?{additional_information:value.additional_information}:{}),...(value.reason!==undefined?{reason:value.reason}:{})};
 return railAftercareEnvelope(await(cancel?backend.cancelRailAftercare(id,input):backend.respondRailAftercare(id,input)));
}

export async function railAftercareOrder(backend:BackendClient,order:import("../../client/types.js").Order,envelope:CommandEnvelope):Promise<CommandEnvelope>{
 if(!["paid","delivery_pending","delivered","partially_refunded","refunded"].includes(order.status))return envelope;
 const directory=await backend.listRailAftercare(order.order_id);
 return {...envelope,result:{...envelope.result,journey:directory.journey,aftercare_cases:directory.cases},instruction:(order.status==="partially_refunded"?"订单为部分退款；仅本次选中票的供应商/金额事实已变化，不能说全程已退。":"按原订单读取票段与人工售后事实。")+" 平台内容锁保持；脱敏剩余票段状态是合法只读事实，不保证历史已出票仍可乘坐。",next:{command:`itpay aftercare list --order ${order.order_id} --json`,reason:"读取原行程、剩余票段、申请目标及完整售后模板"}};
}
