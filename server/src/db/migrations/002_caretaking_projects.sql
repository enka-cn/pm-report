-- 002_caretaking_projects.sql
--
-- 启用设计文档 §13.1 的「看护型项目」：
--   - 项目分两种 kind：交付型（有日程、沿流水线推进）与看护型（事件驱动、长期持有、要交接）
--   - 项目有负责人（交接就是改它）
--   - 看护条件结构化存下来：那是接手的人唯一必须知道的事（"我在等什么才会动"）
--   - 项目级事件：交接必须留痕，而 event 之前只能挂 item

-- ---------------------------------------------------------------------------
-- project：类型、负责人、看护条件
--
-- 看护型项目不进任何时间桶（它压根不是 item），所以 due_at 对它没有意义；
-- 但也不删——交付型项目仍然用它。
-- ---------------------------------------------------------------------------
ALTER TABLE project ADD COLUMN kind TEXT NOT NULL DEFAULT 'delivery'
  CHECK (kind IN ('delivery', 'caretaking'));
ALTER TABLE project ADD COLUMN owner TEXT NOT NULL DEFAULT 'me';
ALTER TABLE project ADD COLUMN watch_for TEXT;

CREATE INDEX idx_project_kind ON project(kind, archived_at);

-- ---------------------------------------------------------------------------
-- event：项目级事件
--
-- 默认 NULL 是硬要求：SQLite 只允许在外键开启时给 ADD COLUMN 加
-- REFERENCES 子句且默认值为 NULL 的列。
-- ---------------------------------------------------------------------------
ALTER TABLE event ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE CASCADE;
CREATE INDEX idx_event_project ON event(project_id, occurred_at);

-- 重建 append-only 触发器，把新列也纳入不可改的范围。
-- 漏掉这一列的话，project_id 就成了唯一能被偷偷改掉的字段。
DROP TRIGGER event_append_only_update;
CREATE TRIGGER event_append_only_update BEFORE UPDATE ON event
WHEN NEW.type IS NOT OLD.type
  OR NEW.item_id IS NOT OLD.item_id
  OR NEW.stage_id IS NOT OLD.stage_id
  OR NEW.deliverable_id IS NOT OLD.deliverable_id
  OR NEW.blocker_id IS NOT OLD.blocker_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.payload IS NOT OLD.payload
  OR NEW.note IS NOT OLD.note
  OR NEW.actor IS NOT OLD.actor
  OR NEW.occurred_at IS NOT OLD.occurred_at
BEGIN
  SELECT RAISE(ABORT, 'event 是 append-only：只允许插入，或仅写 voided_at/void_reason 作废');
END;
