-- 008_project_source_kind.sql · M3'-1：项目列表页的来源类型投影列
--
-- 设计要点：
-- 1) 列表页只读 projects 表的投影列，不能为了一个 sourceKind 去解析 data_json（里面是整份接口快照）；
-- 2) 历史数据默认 'apifox'，与迁移前读路径（project.apifox）一致，无需回填脚本；
-- 3) 新写入以 project.source.kind 为准，data_json 仍是完整事实来源，列只是索引。

PRAGMA user_version = 8;

ALTER TABLE projects ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'apifox';

CREATE INDEX IF NOT EXISTS idx_projects_source_kind ON projects(source_kind);
