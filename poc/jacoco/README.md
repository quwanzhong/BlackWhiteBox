# JaCoCo per-node 覆盖率 PoC · 执行记录

| 项 | 值 |
|---|---|
| 日期 | 2026-11-09 |
| 结论 | **H1 / H2 / H3 全部 PASS**，M3 的技术路线成立 |
| 耗时 | 约 1.5 小时（含协议逆向），低于 2 人日的时间盒 |
| 环境 | Windows · JDK 17.0.14 · Node 22.22 · JaCoCo 0.8.12（零 Maven、零第三方 Java 依赖） |
| 被测对象 | `poc/jacoco/fixture` 自建 7 类 demo，监听 `127.0.0.1:8089`，不出本机 |

---

## 1. 三个假设的实测结果

| # | 假设 | 结果 | 关键数字 |
|---|---|---|---|
| **H1** | agent 挂得上、连得通、dump 有数据 | ✅ PASS | exec 头 `01 C0 C0 10 07`（格式 0x1007）；4 次 dump 全部成功 |
| **H2** | per-node 隔离：B 不含 A 的命中 | ✅ PASS | A 命中订单 **10 行**；B 命中订单 **0 行**、库存 **9 行**；`A ∩ B = ∅` |
| **H3** | 探针能映射回源码行号 | ✅ PASS | 抽查 6 行全部与源码一致（含 `OrderService:18/19/20`、`PaymentGateway:7`） |

补充证据：

- 节点 C（库存不足，返回 409）命中库存 **8 行**，包含 `AlertClient.lowStock` 与 `throw` 分支 —— 说明"异常分支也能被记录"。
- 节点 A 的未覆盖行里包含整个 `com.poc.stock` 包与 `applyCoupon` 的优惠券分支 —— 说明"没走的分支能明确列出来"。

---

## 2. 实测协议（反编译 0.8.12 agent 确认）

> 这一节是本次 PoC 最有价值的产出：网上没有成体系的文档，以下为 `TcpConnection` / `RemoteControlWriter` / `RemoteControlReader` / `ExecutionDataWriter` 字节码的实际行为。

```
客户端 connect
  ← agent 主动发 5 字节 exec 头：01 C0 C0 10 07
客户端回 5 字节同样的头                （agent 的 reader 要求 firstBlock 必须是 0x01）
  → 命令帧（仅 3 字节）：40 <dump:0|1> <reset:0|1>
  ← 响应：exec 数据块流，以 0x20（CMDOK）结束
```

响应块格式：

| 块类型 | 含义 | 负载 |
|---|---|---|
| `0x10` | SESSIONINFO | UTF id（2 字节长度 + 内容）+ int64 start + int64 dump |
| `0x11` | EXECUTIONDATA | **int64 classId（8 字节）** + UTF 类名 + **varint 探针数** + 打包位图（LSB-first） |
| `0x20` | CMDOK | 无 |

> 注意：网上常见的"4 字节魔数 `40 C0 10 00`"是错的；`0x40` 本身就是 dump 命令字节，后面只跟两个布尔。

---

## 3. 复现步骤

```powershell
cd 黑百盒\poc\jacoco

# 1) 下载 jar（校验 SHA-1）
powershell -ExecutionPolicy Bypass -File scripts\00-fetch-jars.ps1

# 2) 编译 fixture + HTTP 壳（javac，零依赖）
powershell -ExecutionPolicy Bypass -File scripts\01-build.ps1

# 3) 带 agent 启动（另开一个窗口，或后台启动）
powershell -ExecutionPolicy Bypass -File scripts\02-run-server.ps1
#    java -javaagent:tools\jacocoagent.jar=port=6300,address=127.0.0.1,output=tcpserver,includes=...

# 4) 三个节点：订单 / 库存 / 库存不足，各自 reset→请求→dump
node scripts\03-probe.mjs --agent-port 6300 --base http://127.0.0.1:8089 --out out

# 5) 每个节点的 .exec → XML（每节点 ~200 ms）
powershell -ExecutionPolicy Bypass -File scripts\04-report.ps1

# 6) 校验 H1/H2/H3，输出 out\result.json
node scripts\05-assert.mjs --out out
```

---

## 4. 实测数据

| 指标 | 数值 | 对设计的含义 |
|---|---|---|
| exec 体积（空载） | 36 B | 可以忽略 |
| exec 体积（单节点） | 118 ~ 158 B | **可直接存 SQLite BLOB**，不需要外部文件 |
| dump 耗时 | 0 ~ 1 ms | 每节点 dump 的开销可忽略 |
| 每节点 classId/探针解析 | < 1 ms | Node 侧解析不是瓶颈 |
| jacococli 单节点报告 | 192 ~ 217 ms | 12 节点约 2.4 s，**印证"执行结束后批量分析"的设计** |
| 单次流程端到端（3 节点 + 分析） | < 3 s | 满足"点执行到出结论"的体验目标 |

---

## 5. 踩坑记录（正式实现会直接复用）

| # | 坑 | 现象 | 解法 |
|---|---|---|---|
| 1 | 主 jar 不能挂 | `-javaagent` 报无 `Premain-Class` | 用 `org.jacoco.agent-0.8.12-runtime.jar`（SHA-1 校验） |
| 2 | 连接后先收数据 | 收到 `01 c0 c0 10 07` | 这是 agent 的 exec 头，不是错误 |
| 3 | 客户端必须回头 | agent 直接断连 | 客户端也要先写 `01 C0 C0 10 07`，否则 `Invalid execution data file` |
| 4 | 块类型/编码全错 | 长度读成 31279，卡死 | `0x10`=session、`0x11`=exec；classId 8 字节；探针数是 varint；位图 LSB-first |

> 第 4 条是本次最花时间的部分。**这些细节直接决定了 M3-1 的工期**：如果没做 PoC，正式实现大概率会在这里卡 1~2 天。

---

## 6. 对正式实现（M3）的结论

1. **方案成立**，按 `docs/02-架构与项目结构.md` §6 开工，不需要退回 lcov。
2. `scripts/03-probe.mjs` 的 `ByteReader + dump()` 可原样迁移为 `backend/src/infra/coverage/jacoco-client.js`。
3. 覆盖率数据**存 SQLite BLOB**（单节点 < 200 B），不落文件，避免又一个数据目录。
4. `jacococli` 分析必须批量：一次 JVM 处理多个 exec，否则节点数一多就是线性 200 ms × N。
5. 分析时 `--classfiles` 要**只给被测项目的类**。本次 XML 里出现了 `DemoHttpServer`（0 命中），生产环境会造成噪声。
6. 白盒断言可以基于 `class + method` 的命中行数直接实现，不需要额外采集器。

## 7. 已知限制

- 仅验证了 JVM；V8 / lcov 两条路径未验证（按计划 M3-5 再做）。
- 本 PoC 的 fixture 是"两条不相交的调用链"，真实业务会有共享工具类 —— 共享类的行会同时出现在多个节点，这是**正确行为**，展示时应区分"本节点独占命中"与"共享命中"。
- `includes=com.poc.order.*:com.poc.stock.*` 只控制插桩范围，不影响 `jacococli` 对未插桩类的展示。
