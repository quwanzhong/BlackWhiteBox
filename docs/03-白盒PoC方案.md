# 03 · 白盒 PoC 方案与实测记录（M3-0）

| 项 | 值 |
|---|---|
| 目标 | 在写正式代码之前，用最小成本验证"每节点覆盖率取证"整条链路**走得通** |
| 时间盒 | 2 人日（实际 **1.5 小时**，含协议逆向） |
| 上游 | `01-需求分析.md` FR-3.2（Q1 已确认接受 JaCoCo agent）、`02-架构与项目结构.md` §6 |
| 位置 | `poc/jacoco/`（通过后，客户端原样演进为 `backend/src/infra/coverage/jacoco-client.js`） |
| 状态 | ✅ **已执行（2026-11-09）· H1 / H2 / H3 全部 PASS** |

> **为什么先做 PoC**：Q1 决策（agent 侵入被测 JVM）是全产品风险最高的一条（R-1）。如果 agent 方案不成立，M3 的 9 人日估算全部作废。实际用 1.5 小时换来了确定性，且纠正了原设计里的两处错误（协议格式、差值归因）。

---

## 1. 待验证的三个假设

| # | 假设 | 验证方式 | 不成立的后果 |
|---|---|---|---|
| **H1** | 被测 JVM 能挂上 agent，且 Node 能通过 TCP 对它 `reset` / `dump` | 启动 demo 服务 + agent，Node 连上后完成一次 dump 得到非空 `.exec` | 整个 M3 推翻，退回 lcov 方案 |
| **H2** | per-node 隔离成立：节点 N 的覆盖率**不包含**节点 1..N-1 的命中 | 节点 A 只打订单链路，节点 B 只打库存链路；B 的报告不得出现 A 的行 | "按节点归因"失去意义，只能做全局覆盖率 |
| **H3** | 探针数据能映射回**源码行号**，并产出我们要的 `Coverage` 结构 | 用 jacococli 对 class 出 XML，解析 `covered/missed`，与源码逐行对照 | 需要自己解析 exec 格式（成本 +3 d，需重新评估） |

**判定出口**：三个假设全部通过 = M3 按 `02` §6 开工。

---

## 2. 环境与前提（2026-11-09 实测）

| 项 | 状态 | 说明 |
|---|---|---|
| JDK 17 | ✅ 17.0.14（`java.home=D:\jdk`） | `javac` / `jar` / `javap` 均可用，PoC 不需要 Maven |
| Maven | ❌ 未安装 | 不需要；两个 jar 从 Maven Central 直接下载并校验 SHA-1 |
| Maven Central 可达 | ✅ | agent `-runtime` jar 302 KB；cli `-nodeps` jar 574 KB |
| Node | ✅ 22.22 | TCP 客户端与断言脚本运行时 |
| 被测工程 | ✅ 自建 fixture（7 个类） | **原 `samples/demo` 不可用**：含 `@Service` 但无 import，无法编译 |
| 外部依赖 | 无 | HTTP 壳用 JDK 内置 `com.sun.net.httpserver`，全程 `127.0.0.1` |

**关键决策：不搭 Spring，也不用原 demo 工程。**

- 原 `analyzers/java-analyzer/samples/demo` 是**静态分析器的样本**（故意缺依赖、用于展示调用链），且属于禁改资产。直接拿来跑会卡在编译，PoC 会变成"修样本"，失去意义。
- 因此新建 `poc/jacoco/fixture/`：订单（`OrderService → OrderRepository → PaymentGateway`）与库存（`StockService → StockRepository → AlertClient`）两条**完全不相交**的调用链，各留一个不执行的分支，用于同时验证"命中"与"未覆盖"。
- 被测对象**不出本机**，与将来内网那台真实服务无关；PoC 只回答"方案是否成立"。

---

## 3. PoC 目录与文件

```
黑百盒/poc/jacoco/
├─ README.md                  # 执行记录：结论 / 协议 / 数字 / 踩坑
├─ tools/                     # 下载的 jar（.gitignore，脚本可重下）
│  ├─ jacocoagent.jar         # 必须是 -runtime 分类器
│  └─ jacococli.jar
├─ fixture/src/com/poc/...    # 被测业务代码（7 个类）
│  ├─ order/                  # OrderService / OrderRepository / PaymentGateway
│  └─ stock/                  # StockService / StockRepository / AlertClient
├─ harness/src/.../DemoHttpServer.java   # JDK HttpServer 壳，暴露 4 个接口
├─ scripts/
│  ├─ 00-fetch-jars.ps1       # 下载 + SHA-1 校验（幂等）
│  ├─ 01-build.ps1            # javac 编译 fixture + harness
│  ├─ 02-run-server.ps1       # 带 -javaagent 启动
│  ├─ 03-probe.mjs            # ★ 核心：JaCoCo TCP 客户端（reset / dump）
│  ├─ 04-report.ps1           # jacococli：每节点 .exec → XML
│  └─ 05-assert.mjs           # H1/H2/H3 断言 + 产出 result.json
└─ out/                       # node-*.exec / node-*.xml / result.json（.gitignore）
```

`03-probe.mjs` 是唯一有技术含量的文件，其余是胶水。它未来就是 `jacoco-client.js` 的雏形，**PoC 代码不写完就扔**。

---

## 4. 执行步骤（可复现）

### Step 0 · 拉取工具（2 min）

```powershell
powershell -File poc\jacoco\scripts\00-fetch-jars.ps1
```

下载 `org.jacoco.agent-0.8.12-runtime.jar` 与 `org.jacoco.cli-0.8.12-nodeps.jar`，并用 `.sha1` 校验。

> ⚠️ 必须用 `-runtime` 分类器：主 jar 是 API，**没有 `Premain-Class`**，`-javaagent` 会直接报错。这是第一个坑，已在脚本里固化。

### Step 1 · 编译（15 s）

```powershell
powershell -File poc\jacoco\scripts\01-build.ps1
```

`javac -encoding UTF-8` 编译 7 个 fixture 类 + 1 个 harness 类到 `out/classes`。零第三方依赖。

### Step 2 · 带 agent 启动（10 s）

```powershell
java -javaagent:poc\jacoco\tools\jacocoagent.jar=port=6300,address=127.0.0.1,output=tcpserver,includes=com.poc.* `
     -cp poc\jacoco\out\classes com.poc.harness.DemoHttpServer --port 8089
```

参数要点：

- `output=tcpserver`：agent 监听 TCP，而不是退出时写文件——**这是 per-node 取证的前提**；
- `address=127.0.0.1`：不对内网开放；
- `includes=com.poc.*`：只插桩被测包，避免 JDK 类噪声。

**"侵入被测 JVM"的全部代价就是一个启动参数。**

### Step 3 · Node 取证（核心，约 30 min）

协议**不是**网传的"4 字节魔数 + 版本/命令字节"。反编译 0.8.12 的 `TcpConnection` / `RemoteControlWriter` / `RemoteControlReader` 后确认：

```
客户端 connect
  ← agent 先发 5 字节 exec 头：01 C0 C0 10 07
客户端回写同样的 5 字节            （agent 的 reader 要求首块必须是 header，否则断连）
  → 命令帧（3 字节）：40 <dump:0|1> <reset:0|1>
  ← 响应：exec 数据块流，以 20（CMDOK）结束
```

响应块格式：

| 块类型 | 含义 | 负载 |
|---|---|---|
| `0x10` | SESSIONINFO | UTF id（2 字节长度 + 内容）+ int64 start + int64 dump |
| `0x11` | EXECUTIONDATA | **int64 classId（8 字节）** + UTF 类名 + **varint 探针数** + 打包位图（LSB-first） |
| `0x20` | CMDOK | 无，表示本次响应结束 |

三种命令组合：

| 动作 | 字节 | 用途 |
|---|---|---|
| `reset` | `40 00 01` | 节点开始前清零 |
| `dump` | `40 01 00` | 节点结束后取数 |
| `dumpAndReset` | `40 01 01` | 取数并清零（原子，推荐正式实现使用） |

执行流程（3 个节点）：

```
握手 → reset → dump（校准，应为空）
     → reset → GET /order/create  → dump(node-A)
     → reset → GET /stock/deduct  → dump(node-B)
     → reset → GET /stock/deduct?count=999 → dump(node-C)   # 库存不足分支
```

> 实现细节：`.exec` 是标准 JaCoCo 格式（header + session + 探针块）。PoC 在 Node 里**按块拼接**成合法文件再交给 jacococli，不解析探针位图本身——位图 → 行号的映射交给 JaCoCo，这是刻意的分工。

### Step 4 · 出报告并断言（约 1 min）

```powershell
powershell -File poc\jacoco\scripts\04-report.ps1      # 每个 .exec → XML（~200 ms/个）
node poc\jacoco\scripts\05-assert.mjs --out poc\jacoco\out
```

`05-assert.mjs` 产出 `out/result.json`，包含三项结论、`coverageSample`、`uncoveredInNodeA`。

---

## 5. 实测结果（全部 PASS）

| # | 假设 | 结果 | 关键数字 |
|---|---|---|---|
| **H1** | agent 可连接、dump 有数据 | ✅ PASS | exec 头 `01 C0 C0 10 07`（格式 0x1007）；4 次 dump 全部成功 |
| **H2** | per-node 隔离 | ✅ PASS | A 命中订单 **10 行**；B 命中订单 **0 行**、库存 **9 行**；`A∩B=∅` |
| **H3** | 行号可映射回源码 | ✅ PASS | 抽查 6 行全部与源码一致（含 `OrderService:18/19/20`、`PaymentGateway:7`） |

补充证据：

- 节点 C（库存不足，HTTP 409）命中库存 **8 行**，包含 `AlertClient.lowStock` 与 `throw` 分支——**异常分支也能被记录**；
- 节点 A 的未覆盖行里包含整个 `com.poc.stock` 包与 `applyCoupon` 的优惠券分支——**没走的分支能明确列出**。

### 5.1 性能与体积

| 指标 | 实测 | 对设计的含义 |
|---|---|---|
| exec 体积（空载） | 36 B | 可忽略 |
| exec 体积（单节点） | 118 ~ 158 B | **可直接存 SQLite BLOB**，不落文件 |
| reset / dump 往返 | 0 ~ 1 ms | 每节点取证开销可忽略 |
| Node 侧块解析 | < 1 ms | 不是瓶颈 |
| jacococli 单节点分析 | 192 ~ 217 ms | 12 节点约 2.4 s，**印证"执行结束后批量分析"** |
| 3 节点全链路（请求 + 取证 + 分析 + 断言） | < 3 s | 满足"点执行到出结论" |

### 5.2 对原设计的两处修正

1. **协议描述全错**：`02` 原写的"4 字节头 + `0x01`/`0x02`/`0x03` 命令"不存在。已改为真实格式（见上表）。
2. **不需要差值归因**：原假设 exec 是累计的、需 `probe(K) AND NOT probe(K-1)`。实测 reset 后探针确实清零，**每节点快照天然独立**（H2 直接证明）。M3-2 因此从 3 d 降到 2 d。

---

## 6. 踩坑记录（正式实现直接复用）

| # | 坑 | 现象 | 解法 |
|---|---|---|---|
| 1 | 主 jar 不能挂 | `-javaagent` 报无 `Premain-Class` | 用 `org.jacoco.agent-0.8.12-runtime.jar` |
| 2 | 连接后先收数据 | 收到 `01 C0 C0 10 07` | 这是 agent 的 exec 头，不是错误 |
| 3 | 客户端必须回头 | agent 直接断连 / `Invalid execution data file` | 客户端先回写 `01 C0 C0 10 07` |
| 4 | 块类型与编码 | 长度读成 31279，卡死 | `0x10`=session、`0x11`=exec；classId 8 字节；探针数 varint；位图 LSB-first |
| 5 | 报告混入壳代码 | XML 里出现 `DemoHttpServer`（0 命中） | `--classfiles` **只给被测项目**；`includes` 只控制插桩范围 |
| 6 | 样本工程不可编译 | `samples/demo` 缺 import | 另建 fixture，不改禁改资产 |

> 第 3~4 条是本次最花时间的部分，也是**不做 PoC 就会在正式实现里卡 1~2 天**的地方。

---

## 7. 判定与出口

| 结果 | 动作 | 本次 |
|---|---|---|
| H1+H2+H3 全过 | M3 按 `02` §6 开工；脚本并入 `infra/coverage/`；实测数字回填 `02` | ✅ 走这条 |
| H2 挂（探针不隔离） | 改用 `dumpAndReset` 再验；仍不行则降级为"快照式"，FR-3.2.2 打折 | — |
| H1 挂（连不上/协议不通） | 查 agent 版本；仍不行 → 放弃 agent，M3 改为 V8 优先 + lcov 兜底 | — |
| 时间盒超 2 天 | 停止，输出已知问题清单，M3 排期重估 | 实际 1.5 h |

**PoC 额外回答的两个正式实现问题**：

1. 批量分析成立（~200 ms/节点，不是原估的 1~2 s）；
2. exec 单节点 < 200 B → 直接进 SQLite，不引入 `data/coverage/` 目录。

---

## 8. 与正式实现的衔接

| PoC 产物 | 去向 |
|---|---|
| `03-probe.mjs` 的 `ByteReader` + `dump()` | `backend/src/infra/coverage/jacoco-client.js`（改用 `dumpAndReset`） |
| `DemoHttpServer.java` 的启动参数模板 | Environment 增加 `coverage: { agent: { port, address, includes } }` |
| `04-report.ps1` 的 jacococli 调用 | `services/coverage/analyze.js`（批量、一次 JVM 处理多份 exec） |
| `05-assert.mjs` 的校验逻辑 | `backend/test/coverage.spec.js` 的用例 |
| `out/result.json` 的实测数字 | `02` §6.2 / §7.4 的指标基线 |

> 铁律：PoC 代码不是玩具代码的另一个名字——**能活下来的部分必须原样进入正式实现**，否则这 2 天白花。

---

## 9. 已知限制

- 仅验证 JVM；V8 / lcov 两条路径未验证（按计划 M3-5）。
- fixture 是"两条不相交的调用链"，真实业务会有共享工具类：同一行出现在多个节点是**正确行为**，UI 需区分"本节点独占命中"与"共享命中"。
- 覆盖率只覆盖**同步链路**；dump 之后才执行的异步任务不会计入本节点，UI 需说明。
- 仅在本机 `127.0.0.1` 验证；内网真实服务的 agent 挂载策略、重启审批、端口开放仍需在验证阶段单独确认（不阻塞 M3 开发）。
