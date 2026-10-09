-- 008_refresh_search_refs.sql
--
-- 007 把搜索触发器从 `code || ' ' || title` 换成了 `ref`，但**没有刷新已经存在的索引行**。
--
-- 后果很隐蔽：升级前建的需求，索引里还是老的单空格文本；而全量重建产生的是双空格。
-- 搜索照样能用（单双空格对 LIKE 没影响），所以谁也不会发现 —— 但「重建索引」不再是幂等的，
-- 只要某天重建一次，结果就和增量维护出来的不一样。这种不一致会在排查别的问题时咬人。
--
-- 教训写在这儿：**改了派生数据的计算方式，就必须把存量重算一遍**，
-- 光改触发器只对以后写入的行生效。这是给那类改动立的规矩。
--
-- 只重建 item / project 两段 —— 只有它们的表达式变了。

DELETE FROM search_fts WHERE kind IN ('item', 'project');

INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
SELECT 100000000 + id, 'item', id, id, project_id, updated_at, ref, IFNULL(description, '')
  FROM item;

INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
SELECT 600000000 + id, 'project', id, NULL, id, updated_at, ref,
       IFNULL(description, '') || IFNULL(' ' || watch_for, '')
  FROM project WHERE is_default = 0;
