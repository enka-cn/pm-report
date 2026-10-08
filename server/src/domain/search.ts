import type { SearchHit, SearchKind, SearchResult } from '@manager/shared';
import { all, run, type Db } from '../db/index.ts';

/**
 * 全文检索。
 *
 * 索引表 `search_fts` 由迁移 004 的触发器维护（7 张源表 → 一个统一索引），
 * 这里只负责查询和排序。设计取舍见 `server/src/db/migrations/004_search_fts.sql` 的文件头。
 *
 * 【为什么统一走 LIKE 而不是 MATCH】实测结论：
 *   MATCH '"排期"'  → 0 条（trigram 的 MATCH 要求 >= 3 字符，而中文两字词极常见）
 *   LIKE  '%排期%'  → 命中
 * trigram 表对 >= 3 字符的 LIKE 有索引优化（两万行 0ms），短查询退化为扫描
 * （两万行 5~13ms），结果始终正确。所以一条查询路径就够了。
 */

export const SEARCH_KINDS: readonly SearchKind[] = [
  'item',
  'note',
  'todo',
  'blocker',
  'deliverable',
  'project',
];

interface FtsRow {
  kind: SearchKind;
  ref_id: number;
  item_id: number | null;
  project_id: number | null;
  occurred_at: string;
  title: string | null;
  body: string | null;
  in_title: number;
  item_code: string | null;
  item_title: string | null;
  project_name: string | null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 把查询词在正文里的位置挖出来，前后各留一点上下文 */
function snippetOf(text: string, q: string, width = 36): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  const at = clean.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return clip(clean, width * 2);

  const start = Math.max(0, at - width);
  const end = Math.min(clean.length, at + q.length + width);
  return (
    (start > 0 ? '…' : '') +
    clean.slice(start, at) +
    '[' +
    clean.slice(at, at + q.length) +
    ']' +
    clean.slice(at + q.length, end) +
    (end < clean.length ? '…' : '')
  );
}

/**
 * LIKE 的通配符必须转义。
 *
 * 不转义的话，搜「完成率 50%」会变成「以『完成率 50』开头的一切」，
 * 搜「a_b」里的 `_` 会匹配任意单字符 —— 搜出来的东西跟你打的字没关系。
 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 【实测结论，别删】`ESCAPE` 会**静默关掉 trigram 的 LIKE 索引优化**。
 *
 *   不带 ESCAPE：MULTI-INDEX OR → SCAN search_fts VIRTUAL TABLE INDEX 0:L5  ← 走索引
 *   带   ESCAPE：                → SCAN search_fts VIRTUAL TABLE INDEX 0:     ← 全表扫
 *
 * 两万行实测：唯一命中 0ms → 9ms，无命中 0ms → 6ms。
 * 代价还随着索引表变大而线性增长，而索引优化不会。
 *
 * 所以只有**查询里真的含通配符**时才加 ESCAPE。日常查询（纯中文/英文）走索引，
 * 极少数要搜字面 `%` 或 `_` 的查询退化为扫描 —— 这类查询本来就罕见，正确优先。
 */
const needsEscape = (query: string): boolean => /[\\%_]/.test(query);

export interface SearchOptions {
  /** 只看某一类 */
  kind?: SearchKind | null;
  limit?: number;
}

export function search(db: Db, q: string, opts: SearchOptions = {}): SearchResult {
  const query = q.trim();
  const empty: SearchResult = {
    q: query,
    total: 0,
    hits: [],
    counts: Object.fromEntries(SEARCH_KINDS.map((k) => [k, 0])) as Record<SearchKind, number>,
  };
  if (!query) return empty;

  const escape = needsEscape(query);
  const like = `%${escape ? escapeLike(query) : query}%`;
  /** 大概率的写法不加 ESCAPE，好让 trigram 索引能生效 */
  const col = (column: string): string =>
    escape ? `${column} LIKE ? ESCAPE '\\'` : `${column} LIKE ?`;
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);

  // 参数顺序跟着 SQL 文本里的 ? 走：(s.title LIKE ?) 在最前，然后 WHERE 的两个，最后 LIMIT。
  // 写成命名参数更好看，但整个代码库都用位置参数，保持一致。
  const where = [`(${col('s.title')} OR ${col('s.body')})`];
  const params: unknown[] = [like, like, like];
  if (opts.kind) {
    where.push('s.kind = ?');
    params.push(opts.kind);
  }
  params.push(limit);

  const rows = all<FtsRow>(
    db,
    `SELECT s.kind, s.ref_id, s.item_id, s.project_id, s.occurred_at, s.title, s.body,
            (${col('s.title')}) AS in_title,
            i.code  AS item_code,
            i.title AS item_title,
            p.name  AS project_name
       FROM search_fts s
       LEFT JOIN item    i ON i.id = s.item_id
       LEFT JOIN project p ON p.id = COALESCE(s.project_id, i.project_id)
      WHERE ${where.join(' AND ')}
      ORDER BY in_title DESC, s.occurred_at DESC
      LIMIT ?`,
    ...params,
  );

  const countRows = all<{ kind: SearchKind; n: number }>(
    db,
    `SELECT s.kind, COUNT(*) AS n
       FROM search_fts s
      WHERE (${col('s.title')} OR ${col('s.body')})
      GROUP BY s.kind`,
    like,
    like,
  );

  const counts = Object.fromEntries(SEARCH_KINDS.map((k) => [k, 0])) as Record<SearchKind, number>;
  for (const row of countRows) counts[row.kind] = row.n;

  const hits = rows.map<SearchHit>((row) => {
    const title = row.title ?? '';
    const body = row.body ?? '';
    const inTitle = row.in_title === 1;
    const inBody = body.toLowerCase().includes(query.toLowerCase());

    return {
      kind: row.kind,
      refId: row.ref_id,
      itemId: row.item_id,
      projectId: row.project_id,
      occurredAt: row.occurred_at,
      inTitle,
      // 标题在结果行里已经显示了，所以优先展示正文里命中的那一段
      snippet: inBody ? snippetOf(body, query) : inTitle ? clip(title, 90) : clip(body, 72),
      itemCode: row.item_code,
      itemTitle: row.item_title,
      projectName: row.project_name,
    };
  });

  return { q: query, total: hits.length, hits, counts };
}

/**
 * 重建索引。
 *
 * 正常情况下用不上（触发器保证增量同步），但它是索引的**真相校验手段**：
 * 怀疑索引漂了的时候跑一遍，或者拿它跟增量维护的结果对账。
 */
export function rebuildSearchIndex(db: Db): number {
  run(db, 'DELETE FROM search_fts');

  const statements = [
    `INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
     SELECT 100000000 + id, 'item', id, id, project_id, updated_at,
            code || ' ' || title, IFNULL(description, '') FROM item`,
    `INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
     SELECT 200000000 + id, 'note', id, item_id,
            COALESCE(project_id, (SELECT project_id FROM item WHERE id = event.item_id)),
            occurred_at, '', note FROM event WHERE note IS NOT NULL AND voided_at IS NULL`,
    `INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
     SELECT 300000000 + id, 'todo', id, item_id,
            (SELECT project_id FROM item WHERE id = todo.item_id), created_at, '', text
       FROM todo WHERE source = 'manual'`,
    `INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
     SELECT 400000000 + id, 'blocker', id, item_id,
            (SELECT project_id FROM item WHERE id = blocker.item_id), opened_at, '',
            counterparty || ' ' || need || IFNULL(' ' || resolution, '') FROM blocker`,
    `INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
     SELECT 500000000 + id, 'deliverable', id, item_id,
            (SELECT project_id FROM item WHERE id = deliverable.item_id), updated_at, '', name
       FROM deliverable`,
    `INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
     SELECT 600000000 + id, 'project', id, NULL, id, updated_at, code || ' ' || name,
            IFNULL(description, '') || IFNULL(' ' || watch_for, '')
       FROM project WHERE is_default = 0`,
  ];

  for (const sql of statements) run(db, sql);

  const total = all<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM search_fts')[0]!;
  return total.n;
}
