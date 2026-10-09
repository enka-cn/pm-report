-- 005_links_and_folders.sql
--
-- 两件事：需求级链接，以及需求级文件树。
--
-- 【为什么文件夹不是「交付物上的一个路径字符串」】
-- 路径字符串看着简单，但改名一个文件夹要改它所有后代的路径，而且**空文件夹存不下来**。
-- 而用户的第一句话就是「我想建立一个 assets 文件夹」—— 建了还是空的，这时候它就必须存在。
-- 所以用真正的树：parent_id 自引用。
--
-- 【阶段和文件夹是两个正交的轴】
--   阶段   = 这份交付物在流程里的位置（决定阶段卡点，由流水线推进）
--   文件夹 = 你自己怎么归置（随时可改，不影响任何流程判断）
-- 所以 deliverable 同时有 stage_id 和 folder_id，互不干涉。

-- ---------------------------------------------------------------------------
-- 需求链接：内部 wiki 之类的入口
-- ---------------------------------------------------------------------------
CREATE TABLE item_link (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_item_link_item ON item_link(item_id, id);

-- ---------------------------------------------------------------------------
-- 交付物文件夹（需求级）
-- ---------------------------------------------------------------------------
CREATE TABLE folder (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  -- 根文件夹的 parent_id 是 NULL
  parent_id  INTEGER REFERENCES folder(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_folder_item ON folder(item_id, parent_id);

-- 同一层里不允许重名。IFNULL 把根层（parent_id 为 NULL）也纳入唯一约束 ——
-- 不然根层可以建出无数个同名文件夹。
CREATE UNIQUE INDEX idx_folder_unique_name ON folder(item_id, IFNULL(parent_id, -1), name);

-- 交付物归到哪个文件夹。NULL = 根目录。
-- ON DELETE SET NULL 是兜底：领域层会拒绝删除非空文件夹，这里是数据库层的第二道保险。
ALTER TABLE deliverable ADD COLUMN folder_id INTEGER REFERENCES folder(id) ON DELETE SET NULL;

CREATE INDEX idx_deliverable_folder ON deliverable(folder_id);

-- ---------------------------------------------------------------------------
-- 链接也进全文索引
--
-- 搜「那个 wiki 页叫啥来着」应该能找到记过它的那条需求。
-- rowid 约定沿用 004：类别序号 * 1e8 + 源表行 id，这里 link = 7。
-- ---------------------------------------------------------------------------
CREATE TRIGGER search_link_ai AFTER INSERT ON item_link BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (700000000 + NEW.id, 'link', NEW.id, NEW.item_id,
          (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.created_at,
          '', NEW.label || ' ' || NEW.url);
END;

CREATE TRIGGER search_link_au AFTER UPDATE ON item_link BEGIN
  DELETE FROM search_fts WHERE rowid = 700000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (700000000 + NEW.id, 'link', NEW.id, NEW.item_id,
          (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.created_at,
          '', NEW.label || ' ' || NEW.url);
END;

CREATE TRIGGER search_link_ad AFTER DELETE ON item_link BEGIN
  DELETE FROM search_fts WHERE rowid = 700000000 + OLD.id;
END;

-- 回填已有的链接（新建表，实际是空的，但保持和 004 一致的结构：
-- 迁移里的回填就是「存量必须补一遍」这条规矩的体现）
INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
SELECT 700000000 + id, 'link', id, item_id,
       (SELECT project_id FROM item WHERE id = item_link.item_id), created_at,
       '', label || ' ' || url
  FROM item_link;
