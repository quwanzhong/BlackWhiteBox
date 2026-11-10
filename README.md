# 黑百盒 · 黑白盒流程化测试平台（单机版）

[![CI](https://github.com/quwanzhong/BlackWhiteBox/actions/workflows/ci.yml/badge.svg)](https://github.com/quwanzhong/BlackWhiteBox/actions/workflows/ci.yml)

> 用「流程图」描述业务流程，一键执行，画布上的节点依次**呼吸发光**，跑完自动给出「实际输出 vs 理想输出」的逐项匹对结论。

黑百盒把项目测试拆成两个视角：

| 视角 | 面向对象 | 数据来源 | 执行方式 |
|---|---|---|---|
| ⬛ **黑盒流程** | 后端 HTTP 接口 / 业务接口链路 | **接口来源适配器**（Apifox 直连首选，OpenAPI JSON 备用） | axios 真实发请求，按 JSONPath 断言响应 |
| ⬜ **白盒证据** | **前端代码 + 接口契约**的业务实现 | 本机前端工程目录 AST 静态分析 + 接口快照（W1 调用链 / W2 参数对比 / W4 运行时覆盖） | 零侵入静态分析；运行时覆盖按需协同采集 |

两个视角在界面上是**两套独立的流程视图**，互不干扰，但共用同一套执行引擎、动画协议和报告体系。

> **口径说明（2026-11-10）**：白盒主线锚定**前端代码**。早期把白盒实现成 JVM 行覆盖率的
> JaCoCo 链路（M3-1~M3-4）保留代码与测试，但**冻结为「后端白盒 · 可选」**，不再是主线；
> 新主线见 [docs/05-前端白盒与接口源抽象.md](docs/05-前端白盒与接口源抽象.md)。

在此之上提供**项目级闭环**：一个前端工程关联本机代码目录 + 同一份接口文档中它实际用到的接口，静态扫描源码调用顺序，按业务功能划分并一键生成可执行流程，失败步骤可直接提缺陷。
M3' 起在这条链路上补齐「业务实现分析」：W1 把调用点升级成**调用链**（入口页面 → api 函数 → 接口），
W2 把代码传参与契约、实测请求做**三方对比**，W4 按需补**前端运行时覆盖**。

---

## 1. 功能一览

- **双视图流程画布**：黑盒 / 白盒分 Tab 管理，X6 画布支持拖拽、缩放、连线条件编辑。
- **执行发光动画**：当前节点蓝色呼吸光晕 + 连线流光；通过变绿、失败变红闪烁、等待人工确认变橙、跳过置灰。
- **实时执行通道**：Socket.IO 推送 `flow_start / step_start / step_end / flow_end` 等事件（`v:2` 信封带 `seq`），暂停 / 继续 / 停止即时生效；断线后按游标补齐，不丢事件。
- **输入输出匹对校验**：每个节点配置「理想输出」（状态码 + JSONPath 断言 + 响应包含 + 响应结构 + 耗时上限），执行后逐条展示期望值、实际值、差异说明。
- **变量提取与传递**：`extract: { token: "$.data.token" }`，后续节点用 `{{token}}` 引用，支持请求地址 / Header / Body。
- **条件流转**：连线可写 `$.code == 0 && $.data.ok`，不满足则跳过下游分支。
- **执行报告**：每次执行落盘，支持回放画布终态、查看请求 / 响应 / 校验明细，并按失败归类筛选。
- **Apifox MCP 直连**：填项目 ID + 访问令牌即可自动拉取接口列表，勾选后一键生成黑盒流程，无需每次导出 JSON（连接为**全局单例**，配置一次全站复用）。
- **接口来源适配层（M3'-1，已交付）**：`InterfaceSource` 注册表 + 工厂（`describe()` 声明能力与配置字段、`fetch()` 统一产出快照），
  Apifox 为第一个适配器，OpenAPI 已收编；后续 Postman / HAR 只需新增适配器，项目主流程零改动。
  **抽象是否成立的硬指标**：新增 Postman 时 `projects/service.js` + `routes/*` + 前端项目页改动合计 ≤ 20 行。
- **项目级管理**：一个项目 = 本机前端工程目录 + 该项目勾选的 Apifox 接口快照；同一份文档可服务多个项目，互不干扰。
- **源码调用分析**：静态扫描 `axios / request / fetch` 等调用点，按路径匹配接口，记录文件 / 行号 / 函数名与真实调用顺序，未匹配可手动关联。
- **业务功能闭环**：按 Apifox 目录 → 接口路径 → 代码目录划分业务功能，按功能或全量生成可执行黑盒流程。
- **套件与并发队列（M2-2）**：套件 = 有序流程列表 + 执行策略（并发 1~8、失败重试、failFast、停止），
  一键并发跑完一批流程；重试后通过标 `flaky`，每条流程仍是独立执行证据，套件只做关联与汇总。
- **环境与密钥（M2-1）**：环境 = baseUrl + 变量 + 全局请求头 + AES-256-GCM 加密密钥；
  变量优先级 `流程 < 环境 < 执行时传入 < extract`，密钥不明文落库、不进报告。
- **失败自动归类（M2-3）**：8 类可解释规则（网络不可达 / 超时 / 状态码不符 / 结构不符 / 断言不符 /
  前置依赖 / 脚本配置 / 人工驳回），执行时落库、老数据读取时补齐；报告列表与套件按归类筛选，
  失败原因取自主判证据且在密钥掩码之后生成，可直接复制到缺陷单。
- **报告导出（M2-4）**：单条执行与整次套件运行都能导出 JUnit XML（进 Jenkins / GitLab CI）、
  单文件 HTML（内联样式、零外链，直接发给别人看）与 JSON（回归 diff）；导出前统一脱敏——
  请求头 / 响应头敏感键、URL 敏感参数、请求体敏感键一律 `***`，环境密钥明文永不出现，
  响应体保留原样作为复盘证据。
- **断线重放与会话恢复（M2-5）**：事件在 `RunSession` 内同步编号，`GET /events?after=<seq>` 增量补齐；
  执行会话按节点边界持久化，进程被强杀后重启会从断点续跑——已完成节点不重跑、中断尝试留下 `skipped` 证据、
  暂停状态保持；未完成的套件运行收敛为 `stopped`，不擅自续跑。
- **执行过程可见（M2-5 补强）**：状态条常驻「已执行 / 总耗时」（以服务端 `startedAt` 为基准，刷新或重连不清零），
  阶段徽标区分执行中 / 已暂停 / 等待人工确认 / 已通过 / 未通过 / 已停止；等待人工确认时顶部橙色横幅 + 自动选中该节点，
  「通过 / 不通过」就在右侧；页面重新打开会自动接上仍在跑的执行。
- **覆盖率取证（M3-1 · 后端白盒 · 可选，已冻结）**：环境里配置 JaCoCo agent（`settings.coverage`）后，每个 HTTP 节点执行前 `reset`、
  结束后 `dumpAndReset`，原始 `.exec` 按节点落进 SQLite，`GET /api/executions/:id/coverage` 返回不含原始字节的聚合投影，
  实时推送 `coverage.dump`；agent 连不上时该节点记 `unavailable` + 稳定错误码，**节点结论不受影响、绝不伪装成 0% 或通过**。
- **覆盖率行级归因（M3-2 · 后端白盒 · 可选，已冻结）**：执行结束后异步跑 jacococli，把每个节点的 `.exec` 解析成行级 `covered/missed` 与类/方法
  LINE 计数，写回 `coverage.result_json` 并补发一条 `coverage.analyzed`（不阻塞 `flow_end`）。未配置 `classfiles` 保持
  `pending`；CLI/类目录缺失或分析失败保留原始证据并标 `analysisFailed`，API 用 `pending` / `analysisFailed` 区分
  「还没分析」和「分析失败」，不会把两者混成 0%。
- **覆盖率面板（M3-3 · 数据源可替换）**：画布节点右上角显示 `covered/total` 徽标（无证据 / 待分析 / 分析失败 / 无行数据各自可辨），
  点徽标或右侧「查看未覆盖行 / 源码」打开面板：文件按未覆盖行排序，源码命中绿、未覆盖红，自动定位第一处未覆盖行，
  支持前后跳转与复制 `path:line`。源码只允许读本节点分析结果里声明过的相对路径（`realpath` 防软链接逃逸，单文件上限 512 KB）。
  M3' 的 W4 前端运行时覆盖**复用同一面板**，数据源从 JaCoCo 换成 istanbul / V8。
- **白盒断言（M3-4 · 方言可扩展）**：节点在「理想输出」里声明 `coverage.mustHit` / `coverage.mustMiss`（`pkg.Class` 或
  `pkg.Class#method`），执行到该节点时同步分析本节点 `.exec` 立即判定：应命中未命中、或不应命中却命中 → 节点
  failed 且归类 `assertion`；没采集 / 没配 `classfiles` / 分析失败 / 人工节点声明断言 → failed 且归类 `script`
  （配置问题），并给出可读原因。**绝不把「没跑到分析」当通过**；未声明断言的节点仍走异步分析，不增加执行延迟。
  M3'-5 增加前端方言 `src/api/x.js#fn`，判定逻辑不变。
- **缺陷反馈**：报告失败步骤一键提缺陷，记录流程、请求、实际值 / 期望值与校验差异，支持状态流转与按项目筛选。
- **Java 白盒分析器（可选）**：JDK 内置解析 API 实现，零第三方依赖，输出调用链 JSON 直接导入。

### 白盒主线（M3' · 2026-11-10 起）

| 层 | 回答的问题 | 手段 | 状态 |
|---|---|---|---|
| **W1 调用链还原** | 这个接口被哪些页面/操作触发？业务规则写在哪个函数？ | `@babel/parser` 建 `imports/calls/components/triggers` 图，从接口反查入口，带置信度与断链标注 | ✅ 已交付（M3'-2） |
| **W2 参数三方对比** | 代码传参 / 契约定义 / 实测请求差在哪？ | CallSite 实参键集 + 接口快照 schema + 执行时真实请求 | 规划（M3'-3） |
| **W3 分支可达** | 成功 / 失败 / 权限分支，用例覆盖到哪几条？ | 静态分支枚举 + 用例打标 | 规划（M3'-3 附带） |
| **W4 运行时覆盖率** | 做完这个操作，前端哪些行真的跑到？ | A：istanbul 插桩 + `POST /api/coverage/ingest`；B：CDP 接管系统 Edge/Chrome（V8 + sourcemap） | 规划（M3'-5） |

硬约束：证据不可用一律显式 `unavailable` + 稳定错误码，**不显示 0%、不静默通过**；
W4 的采集窗口必须与节点显式绑定（`coverage.watch`），不把「黑盒发了个 HTTP」当成「前端代码被覆盖」。
依赖口径：可装 `@babel/parser` / `ws`，**不下载 Chromium**。

---

## 2. 快速开始

环境要求：**Node.js 18+**（开发用 22 验证）、**JDK 17+**（可选，仅 Java 分析器 / 后端 JaCoCo 白盒需要）。

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
npm run lint            # 后端 + 前端 eslint（--max-warnings=0）
npm test                # 后端 node --test（161 个用例，快速反馈）
npm run test:frontend   # 前端 node --test（事件同步 + 覆盖率视图模型，12 个用例）
npm run test:coverage   # 同上 + 覆盖率门槛（行/分支/函数均 ≥70%）
npm run verify          # 场景级验收：真实 HTTP/Socket.IO + 临时 SQLite（88 项检查 / 12 场景）
npm run verify:jacoco   # 后端白盒冻结回归（真实 JaCoCo agent，需本地 JDK 17 + poc/jacoco 产物，不在 CI 跑）
npm run ci              # lint → test:coverage → test:frontend → verify → build，与 GitHub Actions 同序
```

> **冻结说明**：`verify:jacoco` 只为防止冻结代码腐烂（R-frozen），不再作为白盒主线门禁；
> M3' 新增的 `sources/`、`codegraph/` 会纳入 `test:coverage` 的统计范围。

覆盖率只统计核心模块（`engine`、`environments`、`suites`、`reporting`、`projects/scanner`、`infra/store`、`security`、`coverage`），
本地 Windows 为行 **96.32%** / 分支 **81.64%** / 函数 **94.67%**；路由与导入器等胶水层由
`backend/scripts/verify-e2e-*.mjs` 对真实后端做端到端回归（执行深场景 31 项 + 功能域 88 项 / 12 个场景）。

CI 配置见 `.github/workflows/ci.yml`：push / PR 自动跑后端 lint、覆盖率门禁与场景验收，前端 lint → `npm run test`
（事件同步 5 例 + 覆盖率视图模型 7 例）→ build，并断言构建产物 `frontend/dist/index.html` 不含令牌占位符
（生产令牌只能由后端在响应时注入）。最近一次：run `42798838719`（sha `270ab04`）success，
后端 **161/161**、行 **96.28%** / 分支 **81.63%** / 函数 **94.67%**，前端 **12/12**、执行深场景 **31 项**、
功能域 **88 项 / 12 场景**。

### 目录

```
黑百盒/
├── frontend/                  Vue3 + TS + Vite + Element Plus + AntV X6
│   └── src/
│       ├── views/             Dashboard / ProjectsPage / ProjectDetail / FlowList / FlowCanvas / EnvironmentsPage / SuitesPage / ReportList / ReportDetail / BugsPage / ImportPage
│       ├── components/        canvas（画布与节点）、节点编辑抽屉、步骤详情、结果汇总、目录选择器、日志控制台
│       ├── stores/            执行状态仓库（Socket.IO 事件 → 动画状态）
│       ├── constants/         失败归类枚举与中文标签（与后端同一份口径）
│       ├── api/               后端接口封装（含导出下载）
│       ├── utils/             文件名解析（Content-Disposition）与 blob 落盘
│       └── styles/            发光动画与全局样式
├── backend/                   Node.js + Express + Socket.IO + axios
│   └── src/
│       ├── engine/            调度器、HTTP 执行器、校验器、JSONPath、并发队列、会话注册表、重启恢复
│       ├── environments/      环境变量 / 全局 Header / secrets 解析与掩码
│       ├── suites/            套件定义校验 + 进程内并发执行（重试 / failFast / stop）
│       ├── reporting/         失败归类器（8 类规则）+ 导出（JUnit/HTML/JSON）与 S8 脱敏
│       ├── security/          访问令牌、Origin 白名单、目录沙箱、受限表达式求值器、AES-256-GCM 密钥库
│       ├── infra/store/       SQLite 连接与迁移、执行行读写、JSON 一次性导入
│       ├── sources/           ★ InterfaceSource 注册表 + 工厂（apifox / openapi；postman / har 后续）
│       ├── codegraph/         ★ W1 AST 调用图：imports/calls/triggers + 入口回溯 + 置信度（M3'-2）
│       ├── apifox/            MCP 客户端（STDIO JSON-RPC）+ 文档还原（M3'-1 收编进 sources/apifox）
│       ├── projects/          源码调用扫描（W0 CallSite）、路径匹配、业务分组、流程生成
│       ├── importers/         OpenAPI（Apifox）→ 黑盒流程（M3'-1 收编进 sources/openapi）
│       ├── routes/            flows / executions / environments / suites / suite-runs / import / apifox / projects / bugs / fs / stats
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
| 响应结构 | `$.data.token`、`$.data.role` 都在 | `type: "schema"`，任一缺失（或为 null）即不通过 |
| 耗时上限 | ≤ 3000 ms | 可选 |

任何一项不通过，该步骤标记为「未通过」，报告里给出**期望值、实际值、差异描述**，流程汇总判定为「不符合理想输出」，
并自动归入 8 类失败之一（网络 / 超时 / 状态码 / 结构 / 断言 / 依赖 / 脚本 / 人工驳回），供筛选与提缺陷。

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
| 接口来源 | `InterfaceSource` 适配器（Apifox MCP 为首个实现） | 统一快照模型，Postman / HAR 平滑插入 |
| 前端白盒 | `@babel/parser` + 自写 walker；`.vue` 只取 `<script>` 块 | 零侵入，不引 `@vue/compiler-sfc` / `@babel/traverse` |
| 前端运行时覆盖 | istanbul 上报 / CDP 接管系统浏览器（`ws`） | 不下载 Chromium，复用既有 `coverage` 模型 |
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
- [x] 环境变量 / 全局 Header / secrets 加密（M2-1）
- [x] 套件 + 并发队列 + 重试 / failFast（M2-2）
- [x] 失败自动归类 8 类 + 报告筛选（M2-3）
- [x] 执行 / 套件导出 JUnit · HTML · JSON + 导出脱敏（M2-4）
- [x] 会话持久化 + 断线重放 `seq` / `after` + 强杀重启续跑（M2-5）
- [x] 覆盖率取证：每节点 JaCoCo `.exec` 快照 + 聚合投影 API + 无证据降级（M3-1 · **后端白盒 · 可选，已冻结**）
- [x] 覆盖率解析：jacococli 逐节点分析 + 行级 `covered/missed` + `coverage.analyzed`（M3-2 · 冻结）
- [x] 覆盖率面板：节点徽标 / 文件未覆盖行 / 源码跳转与复制位置（M3-3 · 数据源可替换，M3'-5 复用）
- [x] 白盒断言：`mustHit` / `mustMiss`，节点内同步判定，证据不可用也判失败不静默通过（M3-4 · 冻结，方言可扩展）
- [x] **M3'-1** `InterfaceSource` 抽象层 + Apifox 收编（SRC-1 场景 13 零变化回归 / SRC-2 结构可验证 / SRC-3 稳定错误码）
- [x] **M3'-2** W1 调用链还原：AST 调用图 + 组件使用边 + 入口回溯 + 置信度与断链标注（AC-W1 机制已过；W1-2 人工抽样 / W1-4 性能与 worker 化待验证）
- [ ] **M3'-3** W2 参数三方对比 + 差异 → 缺陷/用例草稿（W3 分支可达附带）
- [ ] **M3'-4** 业务功能分析：入口页面 + 触发操作 + 接口序列 + 校验点 + 涉及代码（取代路径首段分组）
- [ ] **M3'-5** W4 前端运行时覆盖率（istanbul 上报优先 / CDP 兜底）+ 前端断言方言
- [ ] 流程 DSL 版本化与导入校验
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
- [前端白盒与接口源抽象（M3' 权威设计）](docs/05-前端白盒与接口源抽象.md)
- [白盒 JaCoCo PoC 方案（后端白盒 · 可选，已冻结）](docs/03-白盒PoC方案.md)
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
