-- 006_deliverable_removal.sql
--
-- 「上传错了」的出路。
--
-- 【为什么之前没有出路，以及那不是设计意图】
-- 005 之前，交付物在数据库层面删不掉：event.deliverable_id 是 ON DELETE SET NULL，
-- 删一行 deliverable 会触发「把事件里的引用置空」，而那是一次 UPDATE event ——
-- 直接撞上 append-only 触发器。
--
-- 但那是**外键写法造成的事故**，不是原则。原则只有一条：
--   **事件日志必须 append-only** —— 它记录「发生过什么」。
-- 它不蕴含「文件字节必须永远留着」，那是**保留策略**，两码事。
-- 一条日志写着「2026-10-08 上传了《设计说明》v2」，即使后来文件被清掉，这句话依然是真的。
--
-- 所以：
--   移除交付物 = 软删除（行留下，removed_at 记时间）
--   回收磁盘   = 单独一步，把没有任何在册交付物引用的字节删掉
-- 外键一个没动，日志的完整性没被牺牲，200G 却能收回来。

ALTER TABLE deliverable ADD COLUMN removed_at TEXT;

-- 「活着的交付物」是最常见的过滤条件
CREATE INDEX idx_deliverable_live ON deliverable(item_id, removed_at);

-- ---------------------------------------------------------------------------
-- 重建交付物的搜索触发器：移除的不能留在索引里
-- ---------------------------------------------------------------------------
DROP TRIGGER search_deliverable_ai;
DROP TRIGGER search_deliverable_au;

CREATE TRIGGER search_deliverable_ai AFTER INSERT ON deliverable
WHEN NEW.removed_at IS NULL BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (500000000 + NEW.id, 'deliverable', NEW.id, NEW.item_id,
          (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.updated_at, '', NEW.name);
END;

CREATE TRIGGER search_deliverable_au AFTER UPDATE ON deliverable BEGIN
  DELETE FROM search_fts WHERE rowid = 500000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  SELECT 500000000 + NEW.id, 'deliverable', NEW.id, NEW.item_id,
         (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.updated_at, '', NEW.name
   WHERE NEW.removed_at IS NULL;
END;
