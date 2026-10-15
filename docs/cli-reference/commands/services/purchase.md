# `itpay services purchase`

## 当前执行的官方页面准备

选定服务后读取完整购买摘要；仅补缺失的真实同意。CLI沿原业务确认、供应商报价与服务端范围校验准备一个官方填写与付款页面。本步骤不请求支付、不扣款，不代表出票或交付。

```bash
itpay services purchase <service_execution_id> --json
itpay services purchase <service_execution_id> --input-json <purchase-confirmation.json> --json
itpay services purchase <service_execution_id> --resume --json
```

输入文件原样使用当前模板的完整 `file_content`，不包外层 `input`。保留 `review_ref`、`request_key`，填写真实 `user_answer`；真实同意覆盖对象、人数、价格策略和条款时才设 `user_approved:true`。已有明确同意未变就复用；未知价格不能默认选择官方页面确认。

价格策略为当前服务器模板的 exact（amount_minor）、capped（maximum_minor），或用户明确允许的 confirm_on_official_page；均带 currency。不得添加 quote_id 或自己拼业务字段。本地格式错误返回未发送，不当作未知写入。

`--timeout` 默认60秒，范围大于0且不超过120秒；服务器保存原确认的累计120秒自动等待预算，恢复不重置。running交回真实阶段和原执行的恢复动作；不重查、不换单。`--host`、`--target`按实际宿主填写；`--locale`控制展示语言。

成功返回已核验官方URL、当前期限和 effects：payment_requested=false、charged=false。图片不可用不阻塞同轮链接交付。人完成官方页面操作后再读取原 Checkout/Order；不能用二维码或人的付款陈述替代后端支付事实。

当前合同未声明购买能力时保留原执行并停止；不能绕过兼容检查、创建替代单或改身份。首次读取摘要失败可按返回动作重读；确认提交后响应丢失、恢复失败或官方入口展示读取失败，按返回的原执行 `--resume` 恢复，复用已保存的同意，不重新发送确认。权限、合同或明确过期等错误按实际原因停止。
