# Apifox MCP 直连说明

黑百盒通过官方 **Apifox MCP Server** 直接读取 Apifox 项目里的接口文档，自动生成黑盒流程。
不需要每次在 Apifox 里手动导出 OpenAPI JSON（手动导入仍保留为备用通道）。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | ≥ 18（后端已内置 `apifox-mcp-server` 依赖，无需全局安装） |
| Apifox | 能正常登录，且对目标项目有访问权限 |
| 网络 | 能访问 `https://api.apifox.com`（私有化部署填自己的 API 地址） |

---

## 2. 获取项目 ID 与访问令牌

### 项目 ID

1. 打开 Apifox 里对应的项目；
2. 左侧边栏 → **项目设置** → **基本设置**；
3. 复制 **项目 ID**（一串数字）。

### 访问令牌

1. 鼠标悬停右上角头像 → **账号设置** → **API 访问令牌**；
2. 点击 **新建**，填写名称与有效期；
3. **保存并生成令牌**，立即复制（离开页面后无法再次查看）。

> 令牌拥有与你账号相同的权限，请只在自己的机器上使用，不要提交到 Git。

---

## 3. 在黑百盒里使用

1. 打开 **数据导入** 页面；
2. 在「连接 Apifox（MCP 自动拉取）」卡片中填写：
   - **项目 ID**
   - **访问令牌**
3. 点击 **测试连接**：成功后显示项目名称、版本、接口数量；
4. 点击 **拉取接口列表**：后端会拉起 MCP Server 并强制刷新 Apifox 最新文档，列出全部接口；
5. 勾选需要的接口（支持搜索、按方法筛选、全选当前筛选结果）；
6. 填写 **流程名称**、按需覆盖 **被测服务地址（baseUrl）**；
7. 点击 **生成黑盒流程**，自动跳转画布。

生成的流程会：

- 每个接口一个节点，按文档顺序连成一条线（可在画布上重排、改连线条件）；
- 请求地址使用文档中的 `servers[0].url`，路径参数自动转成 `{{变量}}`（如 `/orders/{{id}}`）；
- 请求体按 schema 生成示例（解析 `$ref` 与 `example`）；
- 必填 query 参数自动拼进 URL 并生成同名变量；
- 理想输出默认：状态码 200（POST 为 201），可在节点编辑抽屉里补充 JSONPath 断言。

### 高级选项

| 字段 | 用途 |
|---|---|
| 在线文档 site-id | 读取**公开发布**的在线文档（免令牌；不支持密码 / 白名单保护的文档） |
| 迭代分支 ID | 读取指定迭代分支，默认主分支 |
| 私有化 API 地址 | 私有化部署的 Apifox，如 `https://apifox.mycompany.com` |

### 令牌保存策略

- 后端：令牌只保存在**进程内存**（`runtimeToken`）或环境变量 `APIFOX_ACCESS_TOKEN`，**不写入** `backend/data` 下的任何配置文件；
- 前端：勾选「记住令牌」后写入本机浏览器 `localStorage`，仅方便下次打开页面时自动填充；取消勾选并重新保存即可清除。

### 服务端环境变量

适合公司统一部署时使用（用户无需再填令牌）：

```bash
# Windows PowerShell
$env:APIFOX_ACCESS_TOKEN = "afxp_xxx"

# 可选：指定默认项目
$env:APIFOX_PROJECT_ID = "123456"
```

前端检测到后端已配置令牌时会显示「后端已配置令牌」，此时令牌输入框可留空。

---

## 4. 实现原理

```
Vue 导入页
   │  POST /api/apifox/interfaces
   ▼
Node 后端（src/apifox/service.js）
   │  spawn(node, apifox-mcp-server/lib/index.js --project=<id> --tool-suffix=)
   │  env: APIFOX_ACCESS_TOKEN, APIFOX_DATA_LOCATION=backend/data/apifox
   ▼
Apifox MCP Server（STDIO JSON-RPC 2.0）
   │  initialize → notifications/initialized → tools/list → tools/call
   │  refresh_project_oas（强制拉最新）
   │  read_project_oas（读取缓存索引）
   │  read_project_oas_ref_resources（按 $ref 取回拆分的 paths / components 文件）
   ▼
完整 OpenAPI 文档 → importers/openapi.js → 黑盒流程 DSL → store 保存
```

关键点：

- 官方 MCP Server 会把 OpenAPI 拆成 `paths/*.json`、`components/**/*.json`，索引里只保留 `$ref` 与 `summary` 摘要。后端会递归取回引用文件并**以完整定义为准**内联，避免摘要覆盖 operation；
- 文档里的 `#/components/...` 本地引用会递归展开（循环引用保留 `$ref` 防止死循环）；
- MCP 缓存目录固定为 `backend/data/apifox/.apifox-mcp-server/`（已被 `.gitignore` 忽略），卸载 / 清缓存直接删该目录即可；
- 官方包默认给工具名加随机后缀，后端启动时传 `--tool-suffix=` 固定工具名，同时代码里也做了前缀匹配兜底。

### 相关接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/apifox/config` | 读取已保存的连接信息（不含令牌） |
| POST | `/api/apifox/config` | 保存项目 ID / site-id / 分支 / 私有化地址 |
| DELETE | `/api/apifox/token` | 清除内存中的令牌 |
| POST | `/api/apifox/test` | 握手 + 读取文档概要（项目名、版本、接口数） |
| POST | `/api/apifox/interfaces` | 拉取并缓存接口列表（`refresh: false` 可读缓存） |
| GET | `/api/apifox/interfaces` | 读取本机缓存的接口列表 |
| POST | `/api/apifox/import` | 按选中的接口 ID 生成并保存黑盒流程 |

接口 ID 统一为 `METHOD /path`，例如 `POST /users`、`GET /orders/{id}`。

---

## 5. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `缺少 Apifox 访问令牌（APIFOX_ACCESS_TOKEN）` | 没填令牌，且后端环境变量也没配置 |
| `拉取接口文档失败：401` | 令牌无效 / 过期 / 无该项目权限，重新生成令牌 |
| `拉取接口文档失败：403` | 私有化地址不对，或账号无项目访问权限 |
| `缺少 Apifox 项目 ID` | 项目 ID 没填，或填成了项目名称 |
| 拉取很慢 / 超时 | 首次拉取要下载整份文档；大项目可适当等待（后端超时 240s），或检查网络代理 |
| 接口数量为 0 | 项目里没有接口，或读取了错误的分支 / 在线文档 |
| 在线文档模式失败 | 该文档开启了密码 / 邮箱白名单 / IP 白名单，改用项目 ID + 令牌方式 |

---

## 6. 备用通道：手动导入 OpenAPI JSON

当无法直连 MCP（离线、无令牌、网络受限）时：

1. Apifox → **项目设置** → **导出数据** → **OpenAPI / Swagger** → 导出 JSON；
2. 黑百盒 → **数据导入** → 展开底部「备用导入通道」；
3. 上传 / 粘贴 JSON → **解析预览** → 保存为黑盒流程。

备用通道与 MCP 通道共用同一个 OpenAPI 解析器（`backend/src/importers/openapi.js`），生成的流程结构一致。
