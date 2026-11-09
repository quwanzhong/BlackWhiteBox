/**
 * 兼容层：门面签名不变，实现已迁到 infra/store/。
 *
 * 单例在这里构造（而不是在 infra/store/index.js 里），原因：
 *   - 测试只 import createStore 时不应打开真实库、更不该触发迁移；
 *   - 只有真正通过门面拿 store 的入口才会连库。
 *
 * 后续 M1-4（分层搬运）会把所有 `import { store } from './store.js'` 改为 infra 路径，
 * 那时删除本文件即可。
 */
import { getDefaultDatabase } from './infra/store/db.js'
import { createStore } from './infra/store/index.js'

export const store = createStore(getDefaultDatabase())
export { createStore }
