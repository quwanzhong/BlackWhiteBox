# 黑百盒 · 黑白盒流程化测试平台（单机版）

> 用「流程图」描述业务流程，一键执行，画布上的节点依次**呼吸发光**，跑完自动给出「实际输出 vs 理想输出」的逐项匹对结论。

黑百盒把项目测试拆成两个视角：

| 视角 | 面向对象 | 数据来源 | 执行方式 |
|---|---|---|---|
| ⬛ **黑盒流程** | 后端 HTTP 接口 / 业务接口链路 | **Apifox MCP 直连自动拉取**（备用：OpenAPI JSON 导入） | axios 真实发请求，按 JSONPath 断言响应 |
| ⬜ **白盒流程** | Java 代码调用链（Controller → Service → Mapper） | 内置 Java 分析器扫描源码 | 逐方法人工确认代码逻辑，记录结论 |

两个视角在界面上是**两套独立的流程视图**，互不干扰，但共用同一套执行引擎、动画协议和报告体系。

在此之上提供**项目级闭环**：一个前端工程关联本机代码目录 + 同一份 Apifox 文档中它实际用到的接口，静态扫描源码调用顺序，按业务功能划分并一键生成可执行流程，失败步骤可直接提缺陷。

---

## 1. 功能一览

- **双视图流程画布**：黑盒 / 白盒分 Tab 管理，X6 画布支持拖拽、缩放、连线条件编辑。
- **执行发光动画**：当前节点蓝色呼吸光晕 + 连线流光；通过变绿、失败变红闪烁、等待人工确认变橙、跳过置灰。
- **实时执行通道**：Socket.IO 推送 `flow_start / step_start / step_end / flow_end` 等事件，暂停 / 继续 / 停止即时生效。
- **输入输出匹对校验**：每个节点配置「理想输出」（状态码 + JSONPath 断言 + 响应包含 + 耗时上限），执行后逐条展示期望值、实际值、差异说明。
- **变量提取与传递**：`extract: { token: "$.data.token" }`，后续节点用 `{{token}}` 引用，支持请求地址 / Header / Body。
- **条件流转**：连线可写 `$.code == 0 && $.data.ok`，不满足则跳过下游分支。
- **执行报告**：每次执行落盘，支持回放画布终态、查看请求 / 响应 / 校验明细。
- **Apifox MCP 直连**：填项目 ID + 访问令牌即可自动拉取接口列表，勾选后一键生成黑盒流程，无需每次导出 JSON（连接为**全局单例**，配置一次全站复用）。
- **项目级管理**：一个项目 = 本机前端工程目录 + 该项目勾选的 Apifox 接口快照；同一份文档可服务多个项目，互不干扰。
- **源码调用分析**：静态扫描 `axios / request / fetch` 等调用点，按路径匹配接口，记录文件 / 行号 / 函数名与真实调用顺序，未匹配可手动关联。
- **业务功能闭环**：按 Apifox 目录 → 接口路径 → 代码目录划分业务功能，按功能或全量生成可执行黑盒流程。
- **缺陷反馈**：报告失败步骤一键提缺陷，记录流程、请求、实际值 / 期望值与校验差异，支持状态流转与按项目筛选。
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

> **安全基线（M1-3 起）**：服务默认只监听 `127.0.0.1`，所有 `/api` 请求与 WebSocket 握手都需要访问令牌。
> 令牌首次启动生成到 `backend/data/.token`（也可用 `HEIBAIHE_TOKEN` 指定），页面会自动注入，正常打开即可；
> 命令行/脚本请用 `Authorization: Bearer <token>`。需要局域网访问时显式设置 `HEIBAIHE_HOST=0.0.0.0`，
> 并自行保管令牌（**不要把带令牌的地址发给别人**）。

Windows 双击启动：`start.bat`（自动装依赖、构建、打开浏览器）。

首次启动会写入两条演示流程（黑盒走公开测试接口，需要联网；白盒是纯人工确认，不联网）。

### 质量门禁

```bash
npm run lint   # 后端 + 前端 eslint（--max-warnings=0）
npm test       # 后端 node --test（26 个用例）
npm run ci     # lint → test → build，与 GitHub Actions 同序
```

CI 配置见 `.github/workflows/ci.yml`：push / PR 自动跑 lint 与测试，并断言构建产物
`frontend/dist/index.html` 不含令牌占位符（生产令牌只能由后端在响应时注入）。

### 目录

```
黑百盒/
├── frontend/                  Vue3 + TS + Vite + Element Plus + AntV X6
│   └── src/
│       ├── views/             Dashboard / ProjectsPage / ProjectDetail / FlowList / FlowCanvas / ReportList / ReportDetail / BugsPage / ImportPage
│       ├── components/        canvas（画布与节点）、节点编辑抽屉、步骤详情、结果汇总、目录选择器、日志控制台
│       ├── stores/            执行状态仓库（Socket.IO 事件 → 动画状态）
│       ├── api/               后端接口封装
│       └── styles/            发光动画与全局样式
├── backend/                   Node.js + Express + Socket.IO + axios
│   └── src/
│       ├── engine/            调度器、HTTP 执行器、校验器、JSONPath、会话注册表
│       ├── security/          访问令牌、Origin 白名单、目录沙箱、受限表达式求值器
│       ├── infra/store/       SQLite 连接与迁移、执行行读写、JSON 一次性导入
│       ├── apifox/            MCP 客户端（STDIO JSON-RPC）+ 文档还原 + 接口列表
│       ├── projects/          源码调用扫描、路径匹配、业务分组、流程生成
│       ├── importers/         OpenAPI（Apifox）→ 黑盒流程
│       ├── routes/            flows / executions / import / apifox / projects / bugs / fs / stats
│       ├── store.js           存储门面（内部 SQLite + WAL，门面签名与旧 JSON 版一致）
│       └── seed.js            演示数据
├── analyzers/java-analyzer/   Java 白盒调用链分析器（零依赖，自带示例工程）
├── docs/                      需求 / 架构 / PoC 与接入说明
└── backend/data/              运行时数据（git 忽略；含 heibaihe.db 与 .token）
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

### 3.2 项目级：代码目录 + 接口勾选 + 业务闭环（推荐）

面向「同一份 Apifox 文档服务多个前端工程」的场景：

1. **项目管理 → 新建项目**，填写项目名，点「选择目录」挑本机前端工程（只记录绝对路径，不上传代码）；
2. 若还没连接 Apifox，先在 **数据导入 → 全局 Apifox 连接** 配置一次（项目 ID + 令牌），所有项目共用；
3. 项目详情 →「① 绑定 Apifox 接口」，拉取后勾选本项目实际用到的接口并保存（保存完整元数据快照）；
4. 「② 扫描代码调用流程」，静态扫描 `axios / request / fetch` 调用点，按路径自动匹配接口；
5. 未匹配 / 置信度低的调用点可「手动关联」；
6. 「③ 业务功能闭环」按 Apifox 目录 / 接口路径 / 代码目录分组，勾选后生成流程（或生成全量流程）；
7. 生成的流程节点按源码调用顺序排列（同一接口在一条流程内合并为一个节点），可直接执行；
8. 报告失败步骤点「提缺陷」，在 **缺陷反馈** 页跟踪到关闭。

> 代码扫描规则、路径匹配算法、分组优先级、生成规则与接口清单见 [docs/PROJECTS.md](docs/PROJECTS.md)。

### 3.3 白盒：Java 调用链走查

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
| 存储 | SQLite（WAL，`better-sqlite3`） | 单机零配置；`store.js` 门面隔离，执行明细按行写入；桌面端再评估 `node:sqlite` |
| 白盒分析 | Java 17 + `com.sun.source` | 零依赖，`javac` 直接构建 |

---

## 6. 后续路线

- [x] Apifox MCP 直连拉取接口（勾选生成黑盒流程）
- [x] 项目级管理：代码目录关联、按项目勾选接口、接口快照
- [x] 前端源码调用扫描与接口路径匹配、手动关联
- [x] 业务功能划分与闭环流程生成
- [x] 执行失败步骤提缺陷与缺陷状态跟踪
- [ ] 流程 DSL 版本化与导入校验
- [ ] 环境变量 / 全局 Header / Cookie 管理
- [ ] 断言提取联动（把提取值直接回填到断言）
- [ ] 定时执行 + 失败通知（企业微信 / 飞书）
- [ ] 多用户与权限（推广期）
- [ ] Playwright UI 流程执行器（`action.type = "ui"` 扩展位已预留）
- [ ] Java 分析器升级 JavaParser + SymbolSolver，支持接口实现映射

---

## 7. 文档

- [现状盘点（AS-IS 与技术债）](docs/00-现状盘点.md)
- [需求分析](docs/01-需求分析.md)
- [架构与项目结构（SSOT）](docs/02-架构与项目结构.md)
- [白盒 JaCoCo PoC 方案](docs/03-白盒PoC方案.md)
- [流程 DSL 规范](docs/DSL.md)
- [执行事件协议与动画状态机](docs/EXECUTION.md)
- [Apifox MCP 直连说明](docs/APIFOX.md)
- [项目级测试：代码 × 接口 × 业务闭环](docs/PROJECTS.md)

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
