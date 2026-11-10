-- 007_coverage.sql · M3-1：白盒运行时证据（按节点归因的覆盖率原始快照）
--
-- 设计取舍（docs/02 §6.2 / §7.1）：
--   1) exec_blob 直接存 BLOB（PoC 实测单节点 118~158 B、空载 36 B），不落文件、不进导出包；
--   2) result_json 与原始证据分离：M3-2 解析出的 files/classes/totals 写这里，exec_blob 永不改写，
--      解析规则升级时可重算，不会丢证据；
--   3) 唯一索引 (execution_id, node_id)：一次执行每个节点一份快照；重跑是新执行，不覆盖历史；
--   4) agent 不可用时仍写一行 status='unavailable' + error，UI 显示「无运行时证据」，
--      绝不把「没采到」伪装成「0% 覆盖」或「通过」；
--   5) M3-2 只有 status='captured' 才会被分析；分析失败保持 captured + error（原始证据保留），
--      与「未配置 classfiles 的 pending」通过 error 字段区分。
PRAGMA user_version = 7;

CREATE TABLE IF NOT EXISTS coverage (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  source       TEXT NOT NULL,              -- jacoco | v8 | lcov
  mode         TEXT NOT NULL,              -- per-node | snapshot
  status       TEXT NOT NULL,              -- captured | analyzed | unavailable
  exec_blob    BLOB,                       -- JaCoCo .exec 原始数据（M3-1 采集）
  result_json  TEXT,                       -- 解析后的 Coverage { files[], classes[] }（M3-2）
  error        TEXT,                       -- 降级原因（agent 不可达 / 协议错误 / 超时）
  captured_at  INTEGER NOT NULL,
  analyzed_at  INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coverage_execution_node
  ON coverage(execution_id, node_id);
CREATE INDEX IF NOT EXISTS idx_coverage_execution
  ON coverage(execution_id);
