import type { BatchAction, BatchResult, DeliverableRow } from '@manager/shared';
import { all, transaction, type Db } from '../db/index.ts';
import { removeDeliverableInTx, restoreDeliverableInTx } from './deliverables.ts';
import { getFolder, moveDeliverableInTx } from './folders.ts';

/**
 * 批量操作。
 *
 * 为什么要有它：单个操作解决的是「这一条怎样」，批量解决的是「我建错了一个文件夹，
 * 想把里面 30 个截图挪出去」—— 一个个拖是没法用的。
 *
 * **整个批次在一个事务里**，所以要么全成要么全不成。半截生效比失败更让人困惑：
 * 你以为都成功了，实际上只动了一半，还得自己找出哪一半。
 *
 * 放在独立模块是因为它同时要用 deliverables 和 folders ——
 * 让那两个互相 import 会成环。
 */

/** 一次最多处理多少条。挡住手滑和畸形请求，不是性能考虑 */
const MAX_BATCH = 1000;

export interface BatchInput {
  ids: number[];
  action: BatchAction;
  /** action === 'move' 时用。null = 根目录 */
  folderId?: number | null;
  reason?: string | null;
}

export function batchDeliverables(db: Db, input: BatchInput): BatchResult {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) throw new Error('没有选中任何交付物');
  if (!ids.every((id) => Number.isInteger(id) && id > 0)) {
    throw new Error('交付物 id 不合法');
  }
  if (ids.length > MAX_BATCH) {
    throw new Error(`一次最多处理 ${MAX_BATCH} 个，收到 ${ids.length} 个`);
  }

  const folderId = input.folderId ?? null;

  return transaction(db, () => {
    // 目标文件夹先验一次，好让「选错了文件夹」这种错误在动数据之前就报出来
    if (input.action === 'move' && folderId !== null && !getFolder(db, folderId)) {
      throw new Error(`文件夹不存在: ${folderId}`);
    }

    const marks = ids.map(() => '?').join(',');
    const rows = new Map(
      all<DeliverableRow>(db, `SELECT * FROM deliverable WHERE id IN (${marks})`, ...ids).map((r) => [
        r.id,
        r,
      ]),
    );
    const missing = ids.filter((id) => !rows.has(id));

    let changed = 0;
    let unchanged = 0;

    for (const id of ids) {
      const row = rows.get(id);
      if (!row) continue; // missing 已经记下了

      if (input.action === 'move') {
        // 已移除的不在界面上、也就选不中；真被选中了就当没变化，不当错误
        if (row.removed_at !== null || row.folder_id === folderId) {
          unchanged++;
          continue;
        }
        moveDeliverableInTx(db, id, folderId);
      } else if (input.action === 'remove') {
        if (row.removed_at !== null) {
          unchanged++;
          continue;
        }
        removeDeliverableInTx(db, id, input.reason ?? undefined);
      } else {
        if (row.removed_at === null) {
          unchanged++;
          continue;
        }
        restoreDeliverableInTx(db, id);
      }
      changed++;
    }

    return { changed, unchanged, missing };
  });
}
