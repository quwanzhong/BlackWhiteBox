# 黑百盒 · 黑白盒流程化测试平台（单机版）

> 用「流程图」描述业务流程，一键执行，画布上的节点依次**呼吸发光**，跑完自动给出「实际输出 vs 理想输出」的逐项匹对结论。

黑百盒把项目测试拆成两个视角：

| 视角 | 面向对象 | 数据来源 | 执行方式 |
|---|---|---|---|
| ⬛ **黑盒流程** | 后端 HTTP 接口 / 业务接口链路 | **Apifox MCP 直连自动拉取**（备用：OpenAPI JSON 导入） | axios 真实发请求，按 JSONPath 断言响应 |
| ⬜ **白盒流程** | Java 代码调用链（Controller → Service → Mapper） | 内置 Java 分析器扫描源码 | 逐方法人工确认代码逻辑，记录结论 |

两个视角在界面上是**两套独立的流程视图**，互不干扰，但共用同一套执行引擎、动画协议和报告体系。

---

## 1. 功能一览

- **双视图流程画布**：黑盒 / 白盒分 Tab 管理，X6 画布支持拖拽、缩放、连线条件编辑。
- **执行发光动画**：当前节点蓝色呼吸光晕 + 连线流光；通过变绿、失败变红闪烁、等待人工确认变橙、跳过置灰。
- **实时执行通道**：Socket.IO 推送 `flow_start / step_start / step_end / flow_end` 等事件，暂停 / 继续 / 停止即时生效。
- **输入输出匹对校验**：每个节点配置「理想输出」（状态码 + JSONPath 断言 + 响应包含 + 耗时上限），执行后逐条展示期望值、实际值、差异说明。
- **变量提取与传递**：`extract: { token: "$.data.token" }`，后续节点用 `{{token}}` 引用，支持请求地址 / Header / Body。
- **条件流转**：连线可写 `$.code == 0 && $.data.ok`，不满足则跳过下游分支。
- **执行报告**：每次执行落盘，支持回放画布终态、查看请求 / 响应 / 校验明细。
- **Apifox MCP 直连**：填项目 ID + 访问令牌即可自动拉取接口列表，勾选后一键生成黑盒流程，无需每次导出 JSON。
- **Java 白盒分析器**：JDK 内置解析 API 实现，零第三方依赖，输出调用链 JSON 直接导入。

---

## 2. 快速开始

环境要求：**Node.js 18+**（开发用 22 验证）、**JDK 17+**（仅白盒分析器需要）。

```bash
# 1) 安装依赖（首次）
npm run install:all

# 2) 开发模式：后端 3310 + 前端 5173（热更新）
npm run dev

# 3) 浏览器打开
#    http://localhost:5173
```

生产模式（单端口，后端直接托管前端产物）：

```bash
npm run build      # 构建前端
npm start          # 启动后端，访问 http://localhost:3310
```

Windows 双击启动：`start.bat`（自动装依赖、构建、打开浏览器）。

首次启动会写入两条演示流程（黑盒走公开测试接口，需要联网；白盒是纯人工确认，不联网）。

### 目录

```
黑百盒/
├── frontend/                  Vue3 + TS + Vite + Element Plus + AntV X6
│   └── src/
│       ├── views/             Dashboard / FlowList / FlowCanvas / ReportList / ReportDetail / ImportPage
│       ├── components/        canvas（画布与节点）、节点编辑抽屉、步骤详情、结果汇总、日志控制台
│       ├── stores/            执行状态仓库（Socket.IO 事件 → 动画状态）
│       ├── api/               后端接口封装
│       └── styles/            发光动画与全局样式
├── backend/                   Node.js + Express + Socket.IO + axios
│   └── src/
│       ├── engine/            调度器、HTTP 执行器、校验器、JSONPath、会话注册表
│       ├── apifox/            MCP 客户端（STDIO JSON-RPC）+ 文档还原 + 接口列表
│       ├── importers/         OpenAPI（Apifox）→ 黑盒流程
│       ├── routes/            flows / executions / import / apifox / stats
│       ├── store.js           JSON 文件存储（换 SQLite/PostgreSQL 只改这一层）
│       └── seed.js            演示数据
├── analyzers/java-analyzer/   Java 白盒调用链分析器（零依赖，自带示例工程）
├── docs/                      DSL 规范、执行事件协议、Apifox MCP 接入说明
└── data/                      运行时数据（git 忽略）
```

---

## 3. 使用流程

### 3.1 黑盒：直连 Apifox MCP 自动拉取（推荐）

1. Apifox 里拿到 **项目 ID**（项目设置 → 基本设置）和 **API 访问令牌**（账号设置 → API 访问令牌）；
2. 黑百盒 → **数据导入** → 「连接 Apifox」卡片填入 → **测试连接**；
3. **拉取接口列表**（后端通过官方 apifox-mcp-server 实时读取，不用手动导出 JSON）；
4. 勾选接口（支持搜索 / 方法筛选 / 全选）→ 填流程名与 baseUrl → **生成黑盒流程**；
5. 画布上调整节点顺序、连线，点击节点配置：
   - 请求地址（支持 `{{baseUrl}}`、路径参数自动转 `{{id}}`）、Header、Body；
   - 理想输出：期望状态码 + JSONPath 断言（`$.data.orderId exists`、`$.code eq 0`…）；
   - 变量提取：如 `token ← $.data.token`；
6. 点击 **执行流程**，观察发光动画，结束后查看 **结果汇总**。

> 详细说明（令牌安全、私有化部署、在线文档模式、常见报错）见 [docs/APIFOX.md](docs/APIFOX.md)。
> 无法直连 MCP 时，展开「备用导入通道」手动粘贴 OpenAPI JSON，效果一致。

### 3.2 白盒：Java 调用链走查

```bash
cd analyzers/java-analyzer

# 免 Maven 构建（需要 JDK 17+）
powershell -ExecutionPolicy Bypass -File build.ps1     # 或双击 build.bat

# 分析你的工程
java -jar java-analyzer.jar --project D:\work\order-service --out flows.json

# 只看识别到哪些接口入口
java -jar java-analyzer.jar --project D:\work\order-service --list

# 只分析某个入口、加大调用深度
java -jar java-analyzer.jar --project . --entry OrderController#createOrder --depth 8
```

把生成的 `flows.json` 粘贴到 **数据导入 → 白盒调用链导入**，即可得到白盒流程图（节点带类名、方法签名、文件与行号）。

分析器说明：

- 用 JDK 自带的 `com.sun.source` 解析 API，**不需要 Maven / JavaParser**；
- 通过字段类型、局部变量类型、方法返回类型解析调用目标，支持 `this`、`super`、链式 getter、构造注入；
- 自动识别 `@RestController / @Controller` + `@GetMapping / @PostMapping / ...`，合并类级 `@RequestMapping` 前缀；
- `if / else / switch / 三元表达式` 会写进连线条件（else 分支自动取反）；
- 默认跳过 getter/setter/toString 等样板方法，`--include-accessors` 可保留。

> 局限：当前版本是**语法级 + 类型名匹配**，不做完整符号求解。接口多实现、同名类跨包、动态代理、反射调用可能识别不出或识别错，建议配合 `--entry` 精确分析。后续可切换为 JavaParser + SymbolSolver 版本（`pom.xml` 已预留）。

---

## 4. 输入输出匹对校验

每个黑盒节点执行后，引擎按顺序校验：

| 校验项 | 示例 | 说明 |
|---|---|---|
| HTTP 状态码 | 期望 200，实际 200 | 未配置时默认期望 200 |
| JSONPath 断言 | `$.data.orderId exists` | 支持 eq / ne / gt / ge / lt / le / exists / regex / contains / type |
| 响应体包含 | 响应包含 `"success"` | 字符串包含匹配 |
| 耗时上限 | ≤ 3000 ms | 可选 |

任何一项不通过，该步骤标记为「未通过」，报告里给出**期望值、实际值、差异描述**，流程汇总判定为「不符合理想输出」。

白盒节点则是人工确认：测试人员对照提示检查代码逻辑，点「通过 / 不通过」并可填写备注，同样纳入最终汇总。

---

## 5. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | Vue 3 + TypeScript + Vite + Pinia + Element Plus | 组件化、中文生态好 |
| 画布 | AntV X6 + x6-vue-shape | 支持自定义 Vue 节点、连线动画、缩放拖拽 |
| 实时通信 | Socket.IO | 执行事件推送、断线重连 |
| 后端 | Node.js + Express | 与前端同语言，单机部署简单 |
| 黑盒执行 | axios | 纯 HTTP 接口层，毫秒级 |
| Apifox 接入 | `apifox-mcp-server`（STDIO / JSON-RPC 2.0） | 官方 MCP Server，免导出直连项目文档 |
| 存储 | JSON 文件（`backend/data`） | 单机零配置；`store.js` 隔离，后续可换 SQLite/PostgreSQL |
| 白盒分析 | Java 17 + `com.sun.source` | 零依赖，`javac` 直接构建 |

---

## 6. 后续路线

- [x] Apifox MCP 直连拉取接口（勾选生成黑盒流程）
- [ ] 流程 DSL 版本化与导入校验
- [ ] 环境变量 / 全局 Header / Cookie 管理
- [ ] 断言提取联动（把提取值直接回填到断言）
- [ ] 定时执行 + 失败通知（企业微信 / 飞书）
- [ ] 多用户、权限、项目管理（推广期）
- [ ] Playwright UI 流程执行器（`action.type = "ui"` 扩展位已预留）
- [ ] Java 分析器升级 JavaParser + SymbolSolver，支持接口实现映射

---

## 7. 文档

- [流程 DSL 规范](docs/DSL.md)
- [执行事件协议与动画状态机](docs/EXECUTION.md)
- [Apifox MCP 直连说明](docs/APIFOX.md)

## 8. 推送到 GitHub

仓库已初始化为 `main` 分支，远程 `origin` 已指向 `https://github.com/quwanzhong/heibaihe.git`。先在 GitHub 新建**空仓库**（建议名 `heibaihe`，**不要**勾选 README / .gitignore），然后：

```bash
git push -u origin main
```

如果使用 SSH：

```bash
git remote set-url origin git@github.com:quwanzhong/heibaihe.git
git push -u origin main
```

> 已忽略：`node_modules/`、`frontend/dist/`、`backend/data/`、`analyzers/java-analyzer/out/`、`*.jar`。
> 克隆后执行 `npm run install:all && npm run build && npm start`，或直接双击 `start.bat`。

## License

内部工具，暂未开源授权。
