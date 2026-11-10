import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 必须在 import 任何 src 模块之前设置：config.js 加载时就固定数据目录与库路径。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heibaihe-bugs-'))
process.env.HEIBAIHE_DATA_DIR = DIR
process.env.HEIBAIHE_DB = path.join(DIR, 'bugs.db')
process.env.HEIBAIHE_TOKEN = 'unit-test-token-0123456789abcdef'

const TOKEN = process.env.HEIBAIHE_TOKEN
const auth = { authorization: `Bearer ${TOKEN}` }

test('缺陷：标题必填，空白标题不清空已有标题', async (t) => {
  const { createApp } = await import('../src/app.js')
  const { server, io } = createApp({ token: TOKEN, originPort: 3310, log: { error() {}, warn() {} } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  t.after(async () => {
    await new Promise((resolve) => io.close(resolve))
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    const { closeDefaultDatabase } = await import('../src/infra/store/db.js')
    closeDefaultDatabase()
    fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const post = (body) =>
    fetch(`${base}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body ?? {}),
    })
  const put = (id, body) =>
    fetch(`${base}/api/bugs/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body ?? {}),
    })

  // 空 / 纯空白 / 缺失标题都必须 400，不能静默变成「未命名缺陷」
  for (const body of [{}, { title: '' }, { title: '   ' }]) {
    const res = await post(body)
    assert.equal(res.status, 400, `标题非法时应拒绝：${JSON.stringify(body)}`)
    assert.match((await res.json()).error, /请填写缺陷标题/)
  }

  const createdRes = await post({ title: '登录接口 500', severity: 'major' })
  assert.equal(createdRes.status, 200)
  const created = await createdRes.json()
  assert.equal(created.title, '登录接口 500')

  // 更新时传空标题不应把原标题清掉
  const updatedRes = await put(created.id, { title: '  ', status: 'fixed' })
  assert.equal(updatedRes.status, 200)
  const updated = await updatedRes.json()
  assert.equal(updated.title, '登录接口 500')
  assert.equal(updated.status, 'fixed')
})
