/**
 * 重启探针（由 verify-e2e-flow.mjs 以子进程方式启动）。
 *
 * 父进程验证完执行链路后会关掉服务和数据库；这个探针在「全新 Node 进程」里
 * 用同一个数据目录重新起真实 HTTP 服务，验证三件事：
 *   1. 执行详情能从 SQLite 完整读回（steps / events / vars）
 *   2. 执行历史列表仍在
 *   3. 旧会话不在内存里，控制接口明确返回 400 而不是静默成功
 *
 * 为什么要子进程：store 门面在模块加载时就绑定了 SQLite 连接，
 * 同进程 close → createApp 会拿着已关闭的连接，测不出真实重启行为。
 *
 * 用法：node scripts/probe-restart.mjs <executionId>
 * 输出：一行 JSON
 */
import { createApp } from '../src/app.js'

const token = process.env.HEIBAIHE_TOKEN
const executionId = process.argv[2]
if (!executionId) {
  console.error('缺少 executionId')
  process.exit(2)
}

const appCtx = createApp({ token, originPort: 3310, log: { error() {}, warn() {} } })
await new Promise((resolve) => appCtx.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${appCtx.server.address().port}`
const auth = { authorization: `Bearer ${token}` }

const detailRes = await fetch(`${base}/api/executions/${executionId}`, { headers: auth })
const detail = await detailRes.json()
const list = await (await fetch(`${base}/api/executions`, { headers: auth })).json()
const pause = await fetch(`${base}/api/executions/${executionId}/pause`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: '{}',
})
const pauseBody = await pause.json()

console.log(
  JSON.stringify({
    detailStatus: detailRes.status,
    detail,
    listCount: list.length,
    pauseStatus: pause.status,
    pauseError: pauseBody.error || '',
  })
)

await new Promise((resolve) => appCtx.io.close(resolve))
await new Promise((resolve) => appCtx.server.close(resolve))
const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
closeDefaultDatabase()
