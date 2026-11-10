-- 003_environments.sql · M2-1：环境（Environment）+ 环境密钥（secrets，AES-256-GCM）
--
-- 设计取舍（docs/02 §7 / §8 S7）：
--   1) environments 一次建足 variables/headers/settings/version，M3（覆盖率）复用 settings_json，
--      避免再次 ALTER；headers 为「全局默认请求头」，节点同名头可覆盖。
--   2) secrets 按 (environment_id, key) 建表，密文 BLOB 由 security/keystore.js 打包
--      version||IV||tag||ciphertext，AAD 绑定 `envId|key`；明文绝不落这张表。
--   3) executions 增加 env_id / env_version：一次执行绑定「哪个环境、哪个版本」，
--      保证可复现（重放时按版本对齐）。老数据两列为 NULL，语义为「未绑定环境」。
--   4) 环境重名约束放在唯一索引（project_id + name）：同项目内不重名，跨项目允许。

PRAGMA user_version = 3;

CREATE TABLE IF NOT EXISTS environments (
  id             TEXT PRIMARY KEY,
  project_id     TEXT,                            -- 可选：挂到某个项目下
  name           TEXT NOT NULL,
  base_url       TEXT,                            -- 空串表示不提供 baseUrl（节点必须写全地址）
  variables_json TEXT NOT NULL DEFAULT '{}',      -- 普通变量（明文，可进报告）
  headers_json   TEXT NOT NULL DEFAULT '{}',      -- 全局默认请求头
  settings_json  TEXT NOT NULL DEFAULT '{}',      -- 预留（M3 coverage 采样等）
  version        INTEGER NOT NULL DEFAULT 1,      -- 每次变更 +1，执行记录按版本对齐
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_environments_project ON environments(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_environments_project_name
  ON environments(COALESCE(project_id, ''), name);

CREATE TABLE IF NOT EXISTS environment_secrets (
  environment_id TEXT NOT NULL,
  key            TEXT NOT NULL,                   -- 键名可参与 {{key}} 插值
  value_blob     BLOB NOT NULL,                   -- version||IV||tag||ciphertext
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (environment_id, key)
);

ALTER TABLE executions ADD COLUMN env_id TEXT;
ALTER TABLE executions ADD COLUMN env_version INTEGER;
