import type {ServicePurchaseState} from "../../client/types.js";
import {fileInputTemplate,type CommandEnvelope} from "./envelope.js";
export function purchaseEnvelope(state:ServicePurchaseState):CommandEnvelope {
 const id=state.service_execution_id;
 const resume={command:`itpay services purchase ${id} --resume --json`,reason:"继续原购买，不重新查询或建单"};
 const review=state.review;
 return {status:state.status,result:{service_execution_id:id,completed_stage:state.completed_stage,...(state.auto_wait_remaining_ms!==undefined ? {auto_wait_remaining_ms:state.auto_wait_remaining_ms}:{}),effects:state.effects,...(review ? {summary:review.summary,price_kind:review.binding.price_kind,review_expires_at:review.binding.expires_at,input_template:fileInputTemplate(`itpay services purchase ${id} --input-json <purchase-confirmation.json> --json`,{...review.confirmation_template},["user_approved","user_answer",...(review.confirmation_template.price_policy.mode==="" ? ["price_policy"]:[])],{executionID:id})}:{})},
 instruction:review ? `${state.status==="confirmation_changed" ? "购买条件发生变化，只补充对变化的真实确认。" : "核对当前对象、数量、金额与条款。"}已有明确同意且覆盖这些条件时沿用；否则仅补缺失同意。将完整 file_content 写入文件，填写真实回答和明确价格策略后执行模板。本步骤只生成官方填写与付款页面，不发起支付。未知价格不得默认改成官方页确认。`
 :state.status==="running" && state.auto_wait_remaining_ms===0 ? "自动等待已达到120秒上限，已停止。原确认和原购买保留；报告 completed_stage，用户需要恢复时只使用原单 next.command，不自动重启等待。"
 :state.status==="running" ? "已保存原确认，当前完成阶段见 completed_stage。保留同一任务继续有界等待；不要求用户说继续。累计120秒仍未完成时停止自动等待并报告原进度，不创建替代购买。"
 :state.status==="expired" ? "原确认或报价已到期，不能沿用过期入口；保留原购买并核对当前状态，付款未知不重建。"
 :"当前购买未能继续；保留原执行，按当前原因处理，不重建购买或猜测结果。",
 next:state.status==="running" ? resume:null,recovery:state.status==="blocked" || state.status==="expired" ? [{command:`itpay services next ${id} --json`,reason:"读取原执行的当前事实与完整恢复动作；不新建购买"}]:[]};
}

