-- 007_optional_codes.sql
--
-- 「没有编号」是一种真实存在的东西。
--
-- 预研 / 算法项目往往没有外部需求单号 —— 它们是上游团队交付过来、我们长期看护的东西。
-- 硬编一个 REQ-6 等于**凭空造了一个你必须记住的映射**，这比没有标识更糟：
-- 它看起来像个标识，实际是纯噪声。
--
-- 所以编号可以：没有、自己起个短名、拿到真单号之后再补上。
--
-- 【为什么这是一行的事】
-- SQLite 3.53 支持 ALTER COLUMN DROP NOT NULL。老版本没有这个能力，只能走
-- 「建新表 → 拷数据 → 删旧表 → 改名」的重建流程 —— 而 item 被 7 张表 + v_item
-- 视图 + 一堆触发器引用，那是最危险的一类迁移。实测过，所以这里敢用。
--
-- UNIQUE 保留。SQLite 把 NULL 当作互不相同，所以多行「没有编号」可以并存；
-- 但两个一样的编号仍然会被拦住（编号一旦有，就必须唯一）。

ALTER TABLE item ALTER COLUMN code DROP NOT NULL;
ALTER TABLE project ALTER COLUMN code DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 显示用的标识：ref
--
-- 有编号就是「编号  标题」，没有就只是「标题」。
--
-- 用**虚拟生成列**而不是让前端各写各的判断，好处很实在：
--   · 判断只写一次，改规则只改这里
--   · SELECT * 自动带上它，连 v_item（SELECT i.*）都不用改
--   · 以后新增的查询不会漏掉这个降级逻辑 —— 漏掉才是这类改动最容易出的错
--   · 改 code 之后 ref 自动重算（因为是虚拟的，每次读都现算）
-- ---------------------------------------------------------------------------
ALTER TABLE item ADD COLUMN ref TEXT
  GENERATED ALWAYS AS (CASE WHEN code IS NULL THEN title ELSE code || '  ' || title END) VIRTUAL;

ALTER TABLE project ADD COLUMN ref TEXT
  GENERATED ALWAYS AS (CASE WHEN code IS NULL THEN name ELSE code || '  ' || name END) VIRTUAL;

-- ---------------------------------------------------------------------------
-- 搜索索引改用 ref
--
-- 原来是 NEW.code || ' ' || NEW.title，而 SQLite 里 NULL || ' ' 还是 NULL ——
-- 没编号的需求会整条索引变成空字符串，也就是**搜不到**。
-- 这种 bug 不会报错，只会让东西悄悄找不到，所以必须改。
-- ---------------------------------------------------------------------------
DROP TRIGGER search_item_ai;
DROP TRIGGER search_item_au;

CREATE TRIGGER search_item_ai AFTER INSERT ON item BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (100000000 + NEW.id, 'item', NEW.id, NEW.id, NEW.project_id, NEW.updated_at,
          NEW.ref, IFNULL(NEW.description, ''));
END;

CREATE TRIGGER search_item_au AFTER UPDATE ON item BEGIN
  DELETE FROM search_fts WHERE rowid = 100000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (100000000 + NEW.id, 'item', NEW.id, NEW.id, NEW.project_id, NEW.updated_at,
          NEW.ref, IFNULL(NEW.description, ''));
END;

DROP TRIGGER search_project_ai;
DROP TRIGGER search_project_au;

CREATE TRIGGER search_project_ai AFTER INSERT ON project WHEN NEW.is_default = 0 BEGIN
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  VALUES (600000000 + NEW.id, 'project', NEW.id, NULL, NEW.id, NEW.updated_at,
          NEW.ref,
          IFNULL(NEW.description, '') || IFNULL(' ' || NEW.watch_for, ''));
END;

CREATE TRIGGER search_project_au AFTER UPDATE ON project BEGIN
  DELETE FROM search_fts WHERE rowid = 600000000 + OLD.id;
  INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
  SELECT 600000000 + NEW.id, 'project', NEW.id, NULL, NEW.id, NEW.updated_at,
         NEW.ref,
         IFNULL(NEW.description, '') || IFNULL(' ' || NEW.watch_for, '')
   WHERE NEW.is_default = 0;
END;
