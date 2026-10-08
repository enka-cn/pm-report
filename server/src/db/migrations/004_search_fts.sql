-- 004_search_fts.sql
--
-- 全文检索（设计文档 §4 的实现）。
--
-- 【为什么是 trigram】默认的 unicode61 不切分中文，整串中文变成一个 token，
-- "等待测试报告" 搜 "测试" 返回空。trigram 按 3 字符序列索引，中文子串可以命中。
--
-- 【为什么查询走 LIKE 而不是 MATCH】trigram 的 MATCH 要求查询 >= 3 字符，
-- 而中文两字词极常见（评审 / 串讲 / 开发 / 排期）。实测：
--   MATCH '"排期"'  → 0 条（两字，trigram 不支持）
--   LIKE  '%排期%'  → 命中
-- 所以统一走 LIKE。trigram 表对长度 >= 3 的 LIKE 有索引优化（两万行实测 0ms），
-- 短于 3 字符时退化为扫描（两万行 5~13ms），结果始终正确。
--
-- 【为什么用触发器】索引是可派生的，但**派生物就会过期**。
-- 靠人记得在每次写入后更新索引，迟早会漏；触发器由数据库保证，漏不掉。
-- 代价是 13 个触发器，机械但可靠。
--
-- 【rowid 约定】rowid = 类别序号 * 1e8 + 源表行 id。
-- 有了稳定的 rowid，更新就是「删掉再插」这一件事，不需要 FTS5 的 'delete' 命令
-- （那个命令在普通 FTS5 表上实测会报 SQL logic error，DELETE FROM 才是对的）。

CREATE VIRTUAL TABLE search_fts USING fts5(
  kind,                  -- item | note | todo | blocker | deliverable | project
  ref_id UNINDEXED,      -- 源表里那一行的 id
  item_id UNINDEXED,     -- 用来跳转：备注/待办/交付物/阻塞都挂在某条需求上
  project_id UNINDEXED,
  occurred_at UNINDEXED, -- 排序用；不参与检索
  title,                 -- 参与检索。只有需求和项目有（子条目不重复父标题，
                         -- 否则一条需求的 20 个待办会全部命中同一个词，全是噪音）
  body,                  -- 参与检索
  tokenize = 'trigram'
);

-- ---------------------------------------------------------------------------
-- 需求
-- ---------------------------------------------------------------------------
CREATE TRIGGER search_item_ai AFTER INSERT ON item BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (100000000 + NEW.id, 'item', NEW.id, NEW.id, NEW.project_id, NEW.updated_at,
          NEW.code || ' ' || NEW.title, IFNULL(NEW.description, ''));
END;

CREATE TRIGGER search_item_au AFTER UPDATE ON item BEGIN
  DELETE FROM search_fts WHERE rowid = 100000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (100000000 + NEW.id, 'item', NEW.id, NEW.id, NEW.project_id, NEW.updated_at,
          NEW.code || ' ' || NEW.title, IFNULL(NEW.description, ''));
END;

-- ---------------------------------------------------------------------------
-- 备注 / 进展（event.note）
--
-- event 是 append-only 的，所以没有 delete 触发器；但「作废」是一次 UPDATE，
-- 索引必须跟着把那条抽掉，否则搜索会捞到已经作废的记录。
-- ---------------------------------------------------------------------------
CREATE TRIGGER search_event_ai AFTER INSERT ON event
WHEN NEW.note IS NOT NULL AND NEW.voided_at IS NULL BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (200000000 + NEW.id, 'note', NEW.id, NEW.item_id,
          COALESCE(NEW.project_id, (SELECT project_id FROM item WHERE id = NEW.item_id)),
          NEW.occurred_at, '', NEW.note);
END;

CREATE TRIGGER search_event_au AFTER UPDATE ON event BEGIN
  DELETE FROM search_fts WHERE rowid = 200000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  SELECT 200000000 + NEW.id, 'note', NEW.id, NEW.item_id,
         COALESCE(NEW.project_id, (SELECT project_id FROM item WHERE id = NEW.item_id)),
         NEW.occurred_at, '', NEW.note
   WHERE NEW.note IS NOT NULL AND NEW.voided_at IS NULL;
END;

-- ---------------------------------------------------------------------------
-- 待办（可以删，所以三个触发器都要）
--
-- 【只索引手工待办】模板生成的待办是样板文字：每条 dev 需求都有「详细设计」
-- 「编码」「自验证」这几条，索引进去以后搜「设计」会被十几条一模一样的行淹没。
-- 用户自己敲的待办才是内容。
-- ---------------------------------------------------------------------------
CREATE TRIGGER search_todo_ai AFTER INSERT ON todo WHEN NEW.source = 'manual' BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (300000000 + NEW.id, 'todo', NEW.id, NEW.item_id,
          (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.created_at, '', NEW.text);
END;

CREATE TRIGGER search_todo_au AFTER UPDATE ON todo BEGIN
  DELETE FROM search_fts WHERE rowid = 300000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  SELECT 300000000 + NEW.id, 'todo', NEW.id, NEW.item_id,
         (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.created_at, '', NEW.text
   WHERE NEW.source = 'manual';
END;

CREATE TRIGGER search_todo_ad AFTER DELETE ON todo BEGIN
  DELETE FROM search_fts WHERE rowid = 300000000 + OLD.id;
END;

-- ---------------------------------------------------------------------------
-- 阻塞：等谁、等什么、怎么解的，都要能搜到
-- ---------------------------------------------------------------------------
CREATE TRIGGER search_blocker_ai AFTER INSERT ON blocker BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (400000000 + NEW.id, 'blocker', NEW.id, NEW.item_id,
          (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.opened_at, '',
          NEW.counterparty || ' ' || NEW.need || IFNULL(' ' || NEW.resolution, ''));
END;

CREATE TRIGGER search_blocker_au AFTER UPDATE ON blocker BEGIN
  DELETE FROM search_fts WHERE rowid = 400000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (400000000 + NEW.id, 'blocker', NEW.id, NEW.item_id,
          (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.opened_at, '',
          NEW.counterparty || ' ' || NEW.need || IFNULL(' ' || NEW.resolution, ''));
END;

-- ---------------------------------------------------------------------------
-- 交付物：搜文件名（"送测申请单" 这种）
-- ---------------------------------------------------------------------------
CREATE TRIGGER search_deliverable_ai AFTER INSERT ON deliverable BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (500000000 + NEW.id, 'deliverable', NEW.id, NEW.item_id,
          (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.updated_at, '', NEW.name);
END;

CREATE TRIGGER search_deliverable_au AFTER UPDATE ON deliverable BEGIN
  DELETE FROM search_fts WHERE rowid = 500000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (500000000 + NEW.id, 'deliverable', NEW.id, NEW.item_id,
          (SELECT project_id FROM item WHERE id = NEW.item_id), NEW.updated_at, '', NEW.name);
END;

-- ---------------------------------------------------------------------------
-- 项目：说明和看护条件里的内容
--
-- 【排除默认项目】它对用户是隐形的（is_default = 1，UI 从不显示），
-- 索引进去只会在结果里冒出一个用户从没见过的「DEFAULT 默认项目」。
-- ---------------------------------------------------------------------------
CREATE TRIGGER search_project_ai AFTER INSERT ON project WHEN NEW.is_default = 0 BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (600000000 + NEW.id, 'project', NEW.id, NULL, NEW.id, NEW.updated_at,
          NEW.code || ' ' || NEW.name,
          IFNULL(NEW.description, '') || IFNULL(' ' || NEW.watch_for, ''));
END;

CREATE TRIGGER search_project_au AFTER UPDATE ON project BEGIN
  DELETE FROM search_fts WHERE rowid = 600000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  SELECT 600000000 + NEW.id, 'project', NEW.id, NULL, NEW.id, NEW.updated_at,
         NEW.code || ' ' || NEW.name,
         IFNULL(NEW.description, '') || IFNULL(' ' || NEW.watch_for, '')
   WHERE NEW.is_default = 0;
END;

-- ---------------------------------------------------------------------------
-- 回填已有数据。
-- 触发器只对新写入生效，所以存量必须在迁移里补一遍 ——
-- 否则升级完会发现以前写的东西一条都搜不到。
-- ---------------------------------------------------------------------------
INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
SELECT 100000000 + id, 'item', id, id, project_id, updated_at,
       code || ' ' || title, IFNULL(description, '')
  FROM item;

INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
SELECT 200000000 + id, 'note', id, item_id,
       COALESCE(project_id, (SELECT project_id FROM item WHERE id = event.item_id)),
       occurred_at, '', note
  FROM event
 WHERE note IS NOT NULL AND voided_at IS NULL;

INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
SELECT 300000000 + id, 'todo', id, item_id,
       (SELECT project_id FROM item WHERE id = todo.item_id), created_at, '', text
  FROM todo
 WHERE source = 'manual';

INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
SELECT 400000000 + id, 'blocker', id, item_id,
       (SELECT project_id FROM item WHERE id = blocker.item_id), opened_at, '',
       counterparty || ' ' || need || IFNULL(' ' || resolution, '')
  FROM blocker;

INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
SELECT 500000000 + id, 'deliverable', id, item_id,
       (SELECT project_id FROM item WHERE id = deliverable.item_id), updated_at, '', name
  FROM deliverable;

INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
SELECT 600000000 + id, 'project', id, NULL, id, updated_at,
       code || ' ' || name, IFNULL(description, '') || IFNULL(' ' || watch_for, '')
  FROM project
 WHERE is_default = 0;
