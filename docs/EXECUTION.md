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
  executionId: string
  type: string
  payload: Record<string, any>
  ts: number            // 服务端毫秒时间戳
}
```

服务端同时把每一条事件写入 `execution.events`，因此**报告可以完整回放**，不依赖前端是否在线。

---

## 3. 事件类型

| `type` | 触发时机 | `payload` 关键字段 |
|---|---|---|
| `flow_start` | 会话开始 | `flowId` `flowName` `nodes[]`（`{id,name}`） |
| `step_start` | 单个节点开始执行 | `nodeId` `nodeName` `stepId` |
| `manual_wait` | 人工步骤等待确认 | `nodeId` `nodeName` `hint` |
| `step_end` | 单个节点结束 | `nodeId` `nodeName` `status` `durationMs` `checks` `actual` `request` `error` `extracted` |
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

### 3.2 `flow_end.summary`

```json
{
  "status": "passed",
  "total": 4,
  "passed": 4,
  "failed": 0,
  "skipped": 0,
  "matchedAll": true,
  "durationMs": 1832,
  "message": "所有实际输出均符合流程理想输出"
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

- Socket.IO 自动重连，重连后前端重新 `join` 房间；
- 服务端事件已持久化，断线期间的事件可通过执行详情接口补齐：

```
GET /api/executions/:id
→ { ..., steps: [...], events: [...], vars: {...} }
```

- 执行会话保存在内存（`registry.js`），**服务重启后进行中的会话会丢失**，但已落盘的历史报告仍可查看。

---

## 8. 新增执行器时要遵守的约定

如果要扩展新的 `action.type`（例如预留的 `ui` / Playwright），执行器只需：

1. 在 `backend/src/engine/executor.js` 增加分支；
2. 返回统一结构：`{ request, status, data, headers, durationMs }`；
3. 交给 `runChecks()` 做输出匹对；
4. 不直接操作 DOM 或 WebSocket —— 事件由 `RunSession` 统一发。

这样前端动画、报告、变量提取、条件流转都无需改动。
