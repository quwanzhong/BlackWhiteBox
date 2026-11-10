-- 006_session_resume.sql · M2-5：会话持久化（断点恢复）
--
-- 设计要点（docs/02 §5.3、ADR-2 #1、FR-4.8）：
-- 1) 恢复点 = 节点边界：每个 step_end 后把「已执行节点 / 待执行队列 / 变量 / 事件游标」
--    写进 executions.resume_json，进程重启后按它重建 RunSession 续跑；
-- 2) 落库前统一掩码：vars 若含环境 secret 明文（extract 恰好取到 secret）会变成 ***，
--    恢复会话不还原 secret 明文（S7 明文不落盘的取舍，见 docs/02 §9.3）；
-- 3) HTTP 节点是原子的：进行中的请求无法跨进程续传，恢复时该次尝试记为 skipped
--    （error 注明「服务重启」），节点本身重跑一次，证据完整保留。

PRAGMA user_version = 6;

ALTER TABLE executions ADD COLUMN resume_json TEXT;
