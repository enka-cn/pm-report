import type { ItemLinkRow } from '@manager/shared';
import { all, lastId, nowIso, one, run, transaction, type Db } from '../db/index.ts';
import { recordEvent } from './events.ts';

/**
 * 需求链接：内部 wiki、设计稿、看板之类的入口。
 *
 * **只允许 http / https**，两个理由都是硬的：
 *   1. `javascript:alert(1)` 这种 URL 渲染成 `<a href>` 就是可执行代码。
 *      单机自用风险低，但没理由留着这个口子。
 *   2. 敲错的相对路径点进去是 404 / 找不到页面 —— 不如在录入那一刻就告诉他。
 */
export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`这不是一个完整的网址：${url}（要带 http:// 或 https://）`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`链接只支持 http / https，收到的是「${parsed.protocol}」`);
  }
}

/** 没写标题时从网址里凑一个：优先最后一段路径，退而求其次用域名 */
export function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split('/').filter(Boolean).pop();
    return tail ? decodeURIComponent(tail) : parsed.hostname;
  } catch {
    return url;
  }
}

export function listLinks(db: Db, itemId: number): ItemLinkRow[] {
  return all<ItemLinkRow>(db, 'SELECT * FROM item_link WHERE item_id = ? ORDER BY id', itemId);
}

export function getLink(db: Db, linkId: number): ItemLinkRow | undefined {
  return one<ItemLinkRow>(db, 'SELECT * FROM item_link WHERE id = ?', linkId);
}

export interface AddLinkInput {
  itemId: number;
  url: string;
  /** 不写就从网址里凑一个 */
  label?: string | null;
}

export function addLink(db: Db, input: AddLinkInput): ItemLinkRow {
  const url = input.url.trim();
  assertHttpUrl(url);
  const label = input.label?.trim() || labelFromUrl(url);
  if (!label) throw new Error('链接标题不能为空');

  return transaction(db, () => {
    const exists = one<{ id: number }>(db, 'SELECT id FROM item WHERE id = ?', input.itemId);
    if (!exists) throw new Error(`需求不存在: ${input.itemId}`);

    const when = nowIso();
    const info = run(
      db,
      'INSERT INTO item_link (item_id, label, url, created_at) VALUES (?, ?, ?, ?)',
      input.itemId,
      label,
      url,
      when,
    );
    const linkId = lastId(info);

    recordEvent(db, {
      type: 'link_added',
      itemId: input.itemId,
      occurredAt: when,
      payload: { link_id: linkId, label, url },
    });

    return getLink(db, linkId)!;
  });
}

export interface UpdateLinkInput {
  label?: string;
  url?: string;
}

export function updateLink(db: Db, linkId: number, patch: UpdateLinkInput): ItemLinkRow {
  const link = getLink(db, linkId);
  if (!link) throw new Error(`链接不存在: ${linkId}`);

  const label = patch.label === undefined ? link.label : patch.label.trim();
  if (!label) throw new Error('链接标题不能为空');

  const url = patch.url === undefined ? link.url : patch.url.trim();
  assertHttpUrl(url);

  run(db, 'UPDATE item_link SET label = ?, url = ? WHERE id = ?', label, url, linkId);
  return getLink(db, linkId)!;
}

/**
 * 删链接。
 *
 * 留下 `link_removed` 事件：「我加过又删了」也是历史，而这个系统的价值就在于历史是完整的。
 * 汇报里不会因为它多出一段（`link_*` 在 buildReportData 里没有分支，会被忽略 —— 见那边的过滤器）。
 */
export function removeLink(db: Db, linkId: number): void {
  transaction(db, () => {
    const link = getLink(db, linkId);
    if (!link) throw new Error(`链接不存在: ${linkId}`);

    run(db, 'DELETE FROM item_link WHERE id = ?', linkId);
    recordEvent(db, {
      type: 'link_removed',
      itemId: link.item_id,
      payload: { link_id: linkId, label: link.label, url: link.url },
    });
  });
}
