# 执行事件协议与动画状态机

本文档说明「黑百盒」一次流程执行在前后端之间的完整契约：如何发起、服务端推送什么事件、前端如何把事件映射成画布上的发光效果、以及暂停 / 继续 / 停止 / 人工确认的控制方式。

对应实现：

- 服务端：[`backend/src/engine/scheduler.js`](../backend/src/engine/scheduler.js)
- 前端仓库：[`frontend/src/stores/execution.ts`](../frontend/src/stores/execution.ts)
- 动画样式：[`frontend/src/styles/animations.css`](../frontend/src/styles/animations.css)

---

## 1. 发起一次执行

```
POST /api/flows/:id/run
Content-Type: application/json

{ "variables": { "baseUrl": "https://api.example.com" } }   // 可选，覆盖流程默认变量
```

响应：

```json
{ "executionId": "0f8a...-..." }
```

拿到 `executionId` 后，前端建立 Socket.IO 连接并加入房间：

```js
socket.emit('join', { room: 'exec:' + executionId })
```

> 房间名固定为 `exec:{executionId}`，事件只推给该房间，多个执行可并行互不干扰。

---

## 2. 事件信封

所有推送统一走 `exec_event` 事件，结构固定：

```ts
interface ExecEvent {
  v: 2                  // 信封版本（M2-5）
  executionId: string
  seq: number           // 单次执行内严格自增，从 1 开始；WS 与落库同号
  type: string
  payload: Record<string, any>
  ts: number            // 服务端毫秒时间戳
}
```

服务端同时把每一条事件写入 `execution_events` 表，因此**报告可以完整回放**，不依赖前端是否在线；
客户端重连后用 `seq` 去重、用 `/events?after=` 补洞（见 §7）。

---

## 3. 事件类型

| `type` | 触发时机 | `payload` 关键字段 |
|---|---|---|
| `flow_start` | 会话开始 | `flowId` `flowName` `nodes[]`（`{id,name}`） |
| `flow_resume` ★ | 进程重启后从断点续跑 | `flowId` `flowName` `nodes[]` `restoredNodes` `paused` |
| `step_start` | 单个节点开始执行 | `nodeId` `nodeName` `stepId` |
| `manual_wait` | 人工步骤等待确认 | `nodeId` `nodeName` `hint` |
| `step_end` | 单个节点结束 | `nodeId` `nodeName` `status` `durationMs` `checks` `actual` `request` `error` `extracted` `failureClass` `failureReason` |
| `log` | 任意时刻 | `level`（`info`/`success`/`warn`/`error`）`message` |
| `paused` | 手动暂停 | — |
| `resumed` | 手动继续 | — |
| `stopped` | 手动停止 | — |
| `flow_end` | 会话结束 | `status` `summary` |

### 3.1 `step_end.status`

取值与节点状态机一致：`passed` / `failed` / `skipped`。

- `passed`：节点执行完成，且所有校验项通过（`checks.matched === true`）；
- `failed`：HTTP 异常、断言不通过、或人工确认不通过；
- `skipped`：分支条件不满足、上游失败、或流程提前停止，未真正执行的节点在收尾时统一补发。

### 3.2 `step_end.failureClass` / `failureReason`（M2-3）

`status = passed` 时两者为 `null`；`failed` / `skipped` 时由服务端归类器（`backend/src/reporting/classify.js`）
当场算出并随事件、步骤、执行三处一起落库，前端只做展示，不再自行判定。

| `failureClass` | 中文 | 命中条件 |
|---|---|---|
| `network` | 网络不可达 | 连接层错误（拒绝 / DNS / 证书 / 重置） |
| `timeout` | 超时 | `ECONNABORTED`、节点 `timeout` 上限、耗时断言超限 |
| `status` | 状态码不符 | 状态码 check 未通过 |
| `schema` | 结构不符 | 结构 check（`type: 'schema'`）未通过 |
| `assertion` | 断言不符 | JSONPath / 包含 / 正则等断言未通过 |
| `dependency` | 前置依赖 | 本节点 `skipped`（上游失败或分支未命中） |
| `script` | 脚本/配置 | 变量未解析、URL 未配置、节点类型不支持 |
| `manual_reject` | 人工驳回 | 人工确认判「不通过」 |

`failureReason` 是**面向人的一句话**，取自主判证据的原始文案（如 `期望 等于 500，实际 200`、
`变量未解析：…`、人工备注），并且永远在 secret 掩码之后生成 —— URL 参数里的密钥只会以 `***` 出现。

判定优先级与边界规则见 [`02-架构与项目结构.md` §9.1](./02-架构与项目结构.md)。

### 3.3 `flow_end.summary`

```json
{
  "status": "passed",
  "total": 4,
  "passed": 4,
  "failed": 0,
  "skipped": 0,
  "matchedAll": true,
  "durationMs": 1832,
  "message": "所有实际输出均符合流程理想输出",
  "failureClass": null,
  "failureReason": null,
  "failureClasses": {
    "network": 0, "timeout": 0, "status": 0, "schema": 0,
    "assertion": 0, "dependency": 0, "script": 0, "manual_reject": 0
  }
}
```

| 字段 | 说明 |
|---|---|
| `status` | `passed` / `failed` / `stopped` |
| `total` | 本次执行涉及的节点总数（含跳过） |
| `passed` / `failed` / `skipped` | 分状态计数 |
| `matchedAll` | 所有**实际执行过**的步骤是否都符合理想输出 |
| `durationMs` | 整体耗时 |
| `message` | 面向人的结论文案 |
| `failureClass` | 主归类 = **第一个**失败步骤的类别；无失败则 `null` |
| `failureReason` | 主归类对应的文案（已掩码） |
| `failureClasses` | 8 类各自计数；`passed` / `stopped` 执行里的 `skipped` 不计入 `dependency` |

判定规则：

```
存在 failed        → failed
否则被手动停止      → stopped
否则 matchedAll    → passed（message = 所有实际输出均符合流程理想输出）
否则               → passed 但提示「存在输出不匹配项」
```

---

## 4. 节点状态机

前端 `NodeStatus` 共 6 态：

```
                 ┌──────────── step_end(passed) ──────────► passed
                 │
pending ──step_start──► running ──manual_wait──► waiting ──step_end──► passed / failed
                 │                              │
                 │                              └── 停止 ──► failed（备注：执行已手动停止）
                 ├──────────── step_end(failed) ─────────► failed
                 └──────────── step_end(skipped) ────────► skipped
```

| 状态 | 画布表现 | CSS 类 |
|---|---|---|
| `pending` | 半透明、灰色左边条 | `.st-pending` |
| `running` | 蓝色边框 + 1.2s 呼吸光晕 | `.st-running` |
| `waiting` | 橙色边框 + 1.4s 呼吸光晕 | `.st-waiting` |
| `passed` | 绿色边框 + 静态柔光 | `.st-passed` |
| `failed` | 红色边框 + 强光晕闪烁 2 次 | `.st-failed` |
| `skipped` | 灰度、42% 透明 | `.st-skipped` |

动画关键帧（`animations.css`）：

```css
@keyframes hbh-node-pulse {
  0%, 100% { box-shadow: 0 0 4px 2px rgba(64, 158, 255, 0.35); }
  50%      { box-shadow: 0 0 20px 9px rgba(64, 158, 255, 0.55); }
}
```

连线流光通过 `stroke-dashoffset` 动画实现，只有从 `running` 节点出发的边才启用。

---

## 5. 执行时序

以「登录 → 查订单 → 支付」三步为例：

```
前端                         服务端
 │  POST /api/flows/:id/run    │
 │ ───────────────────────────►│  创建 RunSession，立即返回 executionId
 │  socket join exec:{id}      │
 │ ───────────────────────────►│
 │                             │  emit flow_start
 │ ◄───────────────────────────│  全部节点置 pending
 │                             │  emit step_start(登录)
 │ ◄───────────────────────────│  登录节点变蓝发光
 │                             │  axios 请求 + 校验 + 提取变量
 │                             │  emit step_end(登录, passed)
 │ ◄───────────────────────────│  登录节点变绿
 │                             │  emit step_start(查订单)
 │                             │  ...
 │                             │  emit flow_end(summary)
 │ ◄───────────────────────────│  弹出结果汇总
```

> 关键点：先返回 `executionId` 再异步执行，避免长流程把 HTTP 请求挂住；前端即使晚加入房间，也能通过 `GET /api/executions/:id` 补齐 `steps` 与 `events`。

---

## 6. 控制接口

| 操作 | 请求 | 说明 |
|---|---|---|
| 暂停 | `POST /api/executions/:id/pause` | 仅 `running` 有效；当前节点执行完后停在下一个节点前 |
| 继续 | `POST /api/executions/:id/resume` | 仅 `paused` 有效 |
| 停止 | `POST /api/executions/:id/stop` | 终止调度，未执行节点标记 `skipped`；等待中的人工步骤按「不通过」放行 |
| 人工确认 | `POST /api/executions/:id/manual` | body：`{ nodeId, pass, note }` |

人工确认示例：

```json
{ "nodeId": "m3", "pass": true, "note": "库存扣减与支付单号写入均正确" }
```

响应：`{ "ok": true, "hint": "已提交人工确认" }`。若节点当前不在等待状态，`ok` 为 `false`。

---

## 7. 断线与恢复

- Socket.IO 自动重连，重连后前端重新 `join` 房间；**先补齐再订阅**，避免漏掉断线窗口内的事件。
- 服务端事件已持久化，断线期间的事件通过增量接口补齐：

```
GET /api/executions/:id/events?after=<lastSeq>&limit=<n>
→ { "id": "...", "lastSeq": 42, "events": [ { "v": 2, "executionId": "...", "seq": 43, "type": "step_end", "...": "..." } ] }
```

- `after` 是**排他游标**（只返回 `seq > after`）；`limit` 只截断本页，`lastSeq` 始终是全局游标；
  记录不存在返回 `404` + `code: "EXECUTION_NOT_FOUND"`；非法参数按默认值处理，不报错。
- 前端按 `seq <= lastSeq` 丢弃 WS 重包；重连流程为 `backfill(lastSeq)` → `join` → 继续消费 WS。

### 7.1 会话恢复（M2-5）

- 恢复点固定在**节点边界**，`executions.resume_json` 存
  `{eventSeq, stepSeq, executed, done, ready, vars, paused, savedAt}`。
- `executed` = 进入过执行的节点（含人工等待中）；`done` = 已出结论的节点（`passed` / `failed` / 条件跳过）。
  恢复时用 `done` 过滤 `ready`，因此人工等待中的节点会重新等待确认，**不会被误判为已完成**。
- HTTP 节点原子：节点结束后才更新恢复点。崩溃时正在进行的尝试补成 `skipped`（`error` 含「服务重启」），
  该节点重新执行；已完成节点不重跑。
- 重启后只补一条 `flow_resume`（不重放 `flow_start`），`seq` 从库里的游标继续，不会从 1 重号。
- 暂停状态随快照落库：重启后仍为 `paused`，等用户 `POST /resume`；不会擅自继续。
- `vars` 快照写入前已掩码；恢复时只把「环境 secret 且快照值为 `***`」的键重新解密补回，
  `extract` 取到的 secret 明文不还原（S7）。
- 未完成的 `suite_runs` 收敛为 `stopped` + `summary.message` 写明「服务重启」，**不自动续跑**；
  其子执行按普通会话恢复。
- 缺 `resume_json` 时按 `frontier()`（未完成且入口/前驱已完成）兜底；流程快照也缺失时收敛为 `stopped` 并留证。

### 7.2 报告列表与归类筛选

```
GET /api/executions                 → [ { id, flowId, flowName, status, failureClass, failureReason, … } ]
GET /api/executions?failureClass=timeout&flowId=…   → 只返回该归类的执行
```

- 列表行自带 `failureClass` / `failureReason` 投影列（执行结束时写入），前端不做二次判定；
- 非法归类值当作「未筛选」返回全量，不报错（避免前端枚举版本落后时列表空白）；
- `GET /api/executions/:id` 详情对 **M2-3 之前的老执行** 现算补齐归类（`enrichExecutionDetail`，
  幂等、不回写），因此筛选与导出口径和界面永远一致。

---

## 8. 新增执行器时要遵守的约定

如果要扩展新的 `action.type`（例如预留的 `ui` / Playwright），执行器只需：

1. 在 `backend/src/engine/executor.js` 增加分支；
2. 返回统一结构：`{ request, status, data, headers, durationMs }`；
3. 交给 `runChecks()` 做输出匹对；
4. 不直接操作 DOM 或 WebSocket —— 事件由 `RunSession` 统一发。

这样前端动画、报告、变量提取、条件流转都无需改动。
