# 流程 DSL 规范（v0.1）

一条流程（Flow）就是一个 JSON 对象。黑盒流程与白盒流程共用同一套结构，只有 `type` 和节点 `action` 不同。

```json
{
  "id": "uuid",
  "name": "下单流程（黑盒）",
  "type": "blackbox",
  "description": "创建订单 → 扣库存 → 支付 → 落库",
  "variables": { "baseUrl": "https://api.example.com" },
  "nodes": [],
  "edges": [],
  "createdAt": 1730000000000,
  "updatedAt": 1730000000000
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 否 | 服务端生成；新建时省略 |
| `name` | string | 是 | 流程名称 |
| `type` | `blackbox` \| `whitebox` | 是 | 决定归属哪个视图 |
| `description` | string | 否 | 描述 |
| `variables` | object | 否 | 全局变量，节点里用 `{{key}}` 引用 |
| `nodes` | Node[] | 是 | 节点列表 |
| `edges` | Edge[] | 是 | 连线列表 |
| `createdAt` / `updatedAt` | number | 否 | 服务端维护 |

---

## 1. 节点 Node

```json
{
  "id": "n1",
  "name": "用户登录",
  "kind": "service",
  "action": {
    "type": "http",
    "method": "POST",
    "url": "{{baseUrl}}/api/login",
    "headers": { "Content-Type": "application/json" },
    "body": { "username": "{{user}}", "password": "{{pwd}}" },
    "timeout": 15000
  },
  "input": { "desc": "正常账号密码" },
  "expected": {
    "status": 200,
    "checks": [
      { "type": "json_path", "label": "业务码为 0", "path": "$.code", "op": "eq", "value": 0 },
      { "type": "json_path", "label": "返回 token", "path": "$.data.token", "op": "exists" }
    ],
    "maxDurationMs": 3000
  },
  "extract": { "token": "$.data.token" },
  "position": { "x": 80, "y": 160 }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 流程内唯一 |
| `name` | string | 节点显示名 |
| `kind` | string | 可选，白盒节点用于配色：`controller` / `service` / `mapper` / `client` / `util` / `component` |
| `action` | Action | 执行方式，见下 |
| `input` | any | 期望输入（展示用，也用于报告对照） |
| `expected` | Expected | 理想输出（黑盒 = 断言；白盒 = 人工确认说明） |
| `extract` | `Record<string, string>` | 变量名 → JSONPath，执行后写入变量表 |
| `position` | `{x, y}` | 画布坐标，保存时以画布实际位置为准 |

### 1.1 Action

**HTTP（黑盒）**

```json
{
  "type": "http",
  "method": "GET",
  "url": "{{baseUrl}}/api/orders/1",
  "headers": { "Authorization": "Bearer {{token}}" },
  "body": null,
  "timeout": 15000
}
```

- `url` / `headers` / `body` 中的字符串支持 `{{var}}` 占位符；
- 整串恰好是一个变量时保留原类型（数字 / 对象 / 数组），否则按字符串替换；
- 4xx / 5xx 不会被当作异常，而是交给校验器判定（便于断言错误码）。

**人工确认（白盒）**

```json
{
  "type": "manual",
  "hint": "检查 OrderService#createOrder 是否正确扣减库存并写入支付单号"
}
```

执行到该节点时流程暂停，等待界面提交「通过 / 不通过 + 备注」。

### 1.2 Expected

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | number | 期望 HTTP 状态码，默认 200 |
| `checks` | Check[] | 断言列表 |
| `maxDurationMs` | number | 响应耗时上限（可选） |
| `manualNote` | string | 白盒人工确认说明 |

**Check**

```json
{ "type": "json_path", "label": "订单号存在", "path": "$.data.orderId", "op": "exists", "value": null }
{ "type": "body_contains", "label": "包含 success", "value": "success" }
```

| `op` | 含义 | `value` |
|---|---|---|
| `eq` | 等于（严格相等） | 任意 |
| `ne` | 不等于 | 任意 |
| `gt` / `ge` / `lt` / `le` | 数值比较 | number |
| `exists` | 存在且非 null | 不需要 |
| `regex` | 正则匹配（字符串化后） | 正则字符串 |
| `contains` | 数组包含元素 / 字符串包含子串 | 任意 |
| `type` | 类型为 | `string` / `number` / `boolean` / `object` / `array` / `null` |

JSONPath 支持 `$.a.b`、`$.list[0].name`、`$`（根）。不支持通配符、过滤器。

---

## 2. 连线 Edge

```json
{ "id": "e_n1_n2", "from": "n1", "to": "n2", "condition": "$.code == 0" }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 建议 `e_{from}_{to}` |
| `from` / `to` | string | 节点 id |
| `condition` | string | 流转条件，留空表示无条件 |

条件表达式在上一个节点执行成功后求值：

- `$` 代表上一个节点的响应数据；
- 支持 `$.a.b`、`&&`、`||`、`!`、比较运算、`{{var}}` 变量；
- 求值失败按 `false` 处理（跳过下游节点）。

```text
$.code == 0
$.data.status == "PAID" && $.data.amount > 0
{{needAudit}} == true
```

---

## 3. 执行语义

1. 入口节点 = 没有入边的节点（若都没有，取第一个节点）；
2. 节点执行成功 → 求值所有出边条件 → 满足的目标节点进入就绪队列；
3. 节点执行失败 → 不再向下流转，未执行到的节点统一标记 `skipped`；
4. 同一节点在一次执行中只执行一次；
5. 流程状态：`passed`（全部通过且输出符合）/ `failed`（存在未通过）/ `stopped`（手动停止）。

---

## 4. 变量与提取

```json
{
  "id": "n2",
  "extract": { "orderId": "$.data.orderId", "token": "$.data.token" },
  "action": { "type": "http", "url": "{{baseUrl}}/api/orders/{{orderId}}" }
}
```

- 变量优先级：内置 `variables` < 执行时传入变量 < 运行中提取的变量；
- 提取表达式取不到值时不会覆盖已有变量；
- 整个执行会话共享一份变量表，报告里会附带最终变量快照。

---

## 5. 白盒流程的额外约定

白盒流程由分析器生成，节点 `action.type` 固定为 `manual`，额外信息放在 `input` 和 `kind`：

```json
{
  "id": "m3",
  "name": "OrderService#createOrder",
  "kind": "service",
  "action": {
    "type": "manual",
    "hint": "请在代码中检查 OrderService#createOrder 的实现（src/main/java/.../OrderService.java:16）"
  },
  "input": { "file": "src/main/java/.../OrderService.java", "line": 16, "signature": "createOrder(CreateOrderRequest request)" },
  "expected": { "manualNote": "人工确认代码逻辑符合预期" }
}
```

---

## 6. 导入格式（白盒分析器输出）

```json
{
  "generator": "heibaihe-java-analyzer",
  "version": "0.1.0",
  "flows": [
    {
      "name": "POST /api/orders · OrderController#createOrder",
      "entry": "OrderController#createOrder",
      "nodes": [
        {
          "id": "m1",
          "name": "OrderController#createOrder",
          "class": "OrderController",
          "package": "com.demo.order",
          "method": "createOrder",
          "signature": "createOrder(CreateOrderRequest request)",
          "kind": "controller",
          "file": "src/main/java/com/demo/order/OrderController.java",
          "line": 19,
          "depth": 0,
          "entry": true
        }
      ],
      "edges": [{ "from": "m1", "to": "m2", "condition": "" }]
    }
  ]
}
```

后端导入时会自动：

- 把每个方法转成 `manual` 节点；
- 按 `depth` 做横向分层布局（`x = 80 + depth * 300`，同层纵向排布）；
- 丢弃自环、悬空边；
- 生成 `whitebox` 类型流程。
