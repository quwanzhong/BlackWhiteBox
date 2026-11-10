-- 004_suites.sql · M2-2：套件（Suite）与套件执行（Suite Run）
--
-- 设计要点：
-- 1) Suite 只是 Flow 的有序集合 + 执行策略（并发/重试/failFast），不复制 Flow；
-- 2) 每次「一键执行」生成一条 suite_runs，具体每条流程仍是一次独立 executions；
--    executions.suite_run_id 把两者关联起来，报告页无需改模型；
-- 3) 策略与环境在执行开始时快照进 suite_runs，之后改 Suite 不影响历史记录。

PRAGMA user_version = 4;

CREATE TABLE IF NOT EXISTS suites (
  id              TEXT PRIMARY KEY,
  project_id      TEXT,
  name            TEXT NOT NULL,
  description     TEXT,
  flow_ids_json   TEXT NOT NULL DEFAULT '[]',
  strategy_json   TEXT NOT NULL DEFAULT '{}',
  environment_id  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
-- 同一项目（全局套件 project_id 为空）内重名拒绝；与 environments 同一口径
CREATE UNIQUE INDEX IF NOT EXISTS idx_suites_project_name ON suites(COALESCE(project_id, ''), name);

CREATE TABLE IF NOT EXISTS suite_runs (
  id             TEXT PRIMARY KEY,
  suite_id       TEXT NOT NULL,
  suite_name     TEXT,
  project_id     TEXT,
  status         TEXT NOT NULL,              -- queued | running | passed | failed | stopped
  strategy_json  TEXT NOT NULL DEFAULT '{}', -- 执行时快照，含 concurrency/retry/failFast
  env_id         TEXT,
  env_version    INTEGER,
  summary_json   TEXT,                       -- {total,passed,failed,skipped,flaky,durationMs,flows[]}
  started_at     INTEGER,
  finished_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suite_runs_suite ON suite_runs(suite_id, created_at DESC);

ALTER TABLE executions ADD COLUMN suite_run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_exec_suite_run ON executions(suite_run_id, started_at);
