-- 005_failure_class.sql · M2-3：失败归类投影列
--
-- 设计要点：
-- 1) 归类是**规则可解释**的枚举（8 类，见 src/reporting/classify.js 与 docs/02 §9.1），
--    不是 ML 猜测；写入时归类、读取时对老数据现算补齐（幂等）。
-- 2) 步骤级归类随 execution_steps.data_json 一起存（无需改表）；
--    执行级归类落投影列，让报告列表的筛选/排序不用解 JSON。
-- 3) failure_reason 与 error 同口径：已做 secret 掩码，可直接展示。

PRAGMA user_version = 5;

ALTER TABLE executions ADD COLUMN failure_class TEXT;
ALTER TABLE executions ADD COLUMN failure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_executions_failure_class ON executions(failure_class);
