import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { DB_FILE, BUGS_FILE, EXEC_DIR, EXEC_INDEX_FILE, FLOWS_FILE, PROJECTS_FILE } from '../../config.js'
import { migrateLegacyJson } from './migrate-json.js'
import { backfillExecutionRows } from './backfill.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations')

/**
 * 按文件名前缀（001/002/...）顺序执行未应用的迁移。
 * 版本号存在 SQLite 的 `user_version` 里，每个 .sql 末尾自己 SET，
 * 所以新库与老库走的是同一条路径（老库只跑增量）。
 */
export function migrate(db) {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()

  let version = db.pragma('user_version', { simple: true })
  for (const file of files) {
    const target = Number(file.slice(0, 3))
    if (target <= version) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    try {
      db.exec('BEGIN')
      db.exec(sql)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`迁移失败 ${file}：${err.message}`)
    }
    version = db.pragma('user_version', { simple: true })
    if (version !== target) throw new Error(`迁移 ${file} 未正确设置 user_version（期望 ${target}，实际 ${version}）`)
  }
  return version
}

/**
 * 打开（或创建）数据库并迁移到最新结构。
 * 单机场景不需要连接池；WAL + NORMAL 足够，且写入不会阻塞读。
 */
export function openDatabase(file = DB_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  // M1-1 老库升级：把 detail_json 展开成 steps/events 行（幂等，无历史时零开销）
  backfillExecutionRows(db)
  return db
}

let defaultDb = null

/**
 * 进程内单例。首次打开时执行一次 JSON → SQLite 迁移（幂等，见 app_meta）。
 */
export function getDefaultDatabase() {
  if (defaultDb) return defaultDb
  defaultDb = openDatabase(DB_FILE)
  migrateLegacyJson(defaultDb, {
    flowsFile: FLOWS_FILE,
    projectsFile: PROJECTS_FILE,
    bugsFile: BUGS_FILE,
    execIndexFile: EXEC_INDEX_FILE,
    execDir: EXEC_DIR,
  })
  return defaultDb
}

/** 关闭进程内单例（优雅退出 / 测试清理用）；下次调用会重新打开 */
export function closeDefaultDatabase() {
  if (!defaultDb) return
  defaultDb.close()
  defaultDb = null
}
