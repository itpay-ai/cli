# `itpay services action`

只记录当前执行明确允许的结构化选择、批准、拒绝或取消，不直接调用付费供应商。使用返回的完整输入模板；真实委托由 Agent 如实转述，不冒充 human。

## 语法与参数

```bash
itpay services action <service_execution_id> --action <action_type>
  [--actor-type <actor_type>] [--actor-id <actor_id>]
  [--status <pending|approved|rejected|expired|cancelled>]
  [--candidate <rank> | --result-item <result_item_id>]
  [--required-before <step>] [--input <key=value> ...]
  [--input-json <file>] [--json]
```

| 选项 | 说明 |
|---|---|
| `--input <key=value>` | 逐项提交 action input；值可为 JSON 字面量（对象/数组/布尔/数字），可重复。 |
| `--input-json <file>` | UTF-8 JSON 文件；顶层必须是 object，整体作为 action input；文件不超过 256 KiB。适合嵌套结构（如订票确认的 `seat_preferences`）。**与 `--input` 互斥**：同时给出时在发起请求前返回 `service_action_invalid`。文件不存在、非合法 JSON 或顶层非 object 同样在本地报结构化错误，不发生网络写。 |

普通 Agent 优先使用 `--candidate <rank>`。CLI 只从当前 Execution 的 `current_result_items` 解析 Result Item ID；Backend 再读取权威 Invocation 和 Stable Hash。Agent 不提交 Hash，也不能使用其他 Execution 或外部来源的候选。`--result-item` 只用于已持有当前 Execution 内部句柄的受控恢复，不应要求用户提供。

## 规划动作（rail.progressive.v2）

`services next` 的 `rail_planning.available_actions` 会给出可直接执行的完整命令。规划动作只允许以下类型，由 planning owner 校验执行归属、plan 状态与幂等键，不影响 Arazzo `human_action` 状态机或公共执行状态：

| action_type | 供应商消耗 | 说明 |
| --- | --- | --- |
| `workflow:expand_search` | 有界新增查询 | 仅在扩展暂停（`expansion_status=paused`）时可用；必须带服务端下发的 `action_request_id`（`pa_…`）与 `expected_query_revision`，一轮一柄、用完作废。 |
| `workflow:refine_preferences` | 无（本地重排） | 用 `--input-json` 提交偏好补丁，对已保存证据重排序。 |
| `workflow:stop_search` | 无 | 停止未发送的扩展任务；不影响已开始或已完成的出票。 |
| `select_journey` | 无 | 用户亲自选定用 `--actor-type human`；用户已明确委托按规则代选用 `--actor-type agent --input selection_mode=delegated`。两者都带服务端返回的 `journey_id`，仅记录选择，后续购买使用当前完整 purchase 确认与官方页面。 |

同一 `action_request_id` 相同内容重放返回原受理结果；相同 ID 不同内容会被判冲突。过期 `expected_query_revision` 的新动作被拒绝。

## 当前输出与购买

候选选择成功时，若当前合同支持购买准备，直接返回原执行的完整 purchase review。已有明确同意覆盖当前主体、范围、人数、价格策略和条款就沿用；仅补缺失同意，不要求重复确认或先给邮箱。联系资料在受保护官方页填写。

`next` 必须是当前适用的完整命令；仍有待填字段则是 `executable:false` 的完整 `file_content` 模板。没有合法动作就停止。普通购买不由 Agent 串联 quote、approve、cart 或 services checkout。

同一选择、报价、付款未知和已有批准的幂等保护由服务端执行；不能新建 execution、猜候选ID或覆盖批准事实。订票技术修正使用原 selection 和当前 review；仅代码写法修正且购买内容未变时沿用已有真实同意。草稿实质变化或真实同意缺失才补确认，不自行递增 revision。旅客身份资料只在受保护页面提交。
