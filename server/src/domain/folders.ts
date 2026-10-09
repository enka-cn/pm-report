import type { FolderNode, FolderRow } from '@manager/shared';
import { all, lastId, nowIso, one, run, transaction, type Db } from '../db/index.ts';
import { listDeliverables } from './deliverables.ts';

/**
 * 交付物文件夹（需求级）。
 *
 * 和「阶段」是**两个正交的轴**：
 *   阶段   = 这份交付物在流程里的位置，决定阶段卡点，由流水线推进
 *   文件夹 = 你自己怎么归置，随时可改，不影响任何流程判断
 *
 * 用真正的一棵树（parent_id 自引用）而不是「交付物上存一个路径字符串」：
 * 路径字符串改名一个文件夹要动它所有后代，而且**空文件夹存不下来** ——
 * 而「我想建立一个 assets 文件夹」正是先有文件夹、后有内容。
 */

/** 文件夹名不能带路径分隔符：这不是路径，带斜杠只会让人以为是层级 */
const ILLEGAL_IN_NAME = /[/\\]/;

function assertFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('文件夹名不能为空');
  if (ILLEGAL_IN_NAME.test(trimmed)) throw new Error('文件夹名里不能有斜杠');
  if (trimmed.length > 60) throw new Error('文件夹名太长了（最多 60 个字）');
  if (trimmed === '.' || trimmed === '..') throw new Error('「.」和「..」不能用作文件夹名');
  return trimmed;
}

/** 同一层里重名要靠人话拦下来，而不是让唯一索引抛一句 SQL 错误 */
function assertNameFree(
  db: Db,
  itemId: number,
  parentId: number | null,
  name: string,
  exceptId?: number,
): void {
  const dup = one<{ id: number }>(
    db,
    `SELECT id FROM folder
      WHERE item_id = ? AND IFNULL(parent_id, -1) = IFNULL(?, -1) AND name = ? AND id <> ?`,
    itemId,
    parentId,
    name,
    exceptId ?? -1,
  );
  if (dup) throw new Error(`这一层已经有叫「${name}」的文件夹了`);
}

export function listFolders(db: Db, itemId: number): FolderRow[] {
  return all<FolderRow>(
    db,
    'SELECT * FROM folder WHERE item_id = ? ORDER BY name',
    itemId,
  );
}

export function getFolder(db: Db, folderId: number): FolderRow | undefined {
  return one<FolderRow>(db, 'SELECT * FROM folder WHERE id = ?', folderId);
}

/**
 * 组装文件树。
 *
 * 根节点是**虚的**（folder 为 null），只用来装根目录下的东西 ——
 * 递归渲染时就不用为「根」写特例了。
 */
export function folderTree(db: Db, itemId: number): FolderNode {
  const folders = listFolders(db, itemId);
  const files = listDeliverables(db, itemId);

  const root: FolderNode = { folder: null, children: [], files: [] };
  const nodes = new Map<number, FolderNode>();
  for (const folder of folders) {
    nodes.set(folder.id, { folder, children: [], files: [] });
  }

  for (const folder of folders) {
    const node = nodes.get(folder.id)!;
    // 父节点理论上一定在（同一个需求下）。真找不到就挂到根上，别让整棵树渲染不出来。
    const parent = folder.parent_id === null ? root : (nodes.get(folder.parent_id) ?? root);
    parent.children.push(node);
  }

  for (const file of files) {
    const node = file.folder_id === null ? root : (nodes.get(file.folder_id) ?? root);
    node.files.push(file);
  }

  return root;
}

export interface CreateFolderInput {
  itemId: number;
  /** 不传 = 建在根层 */
  parentId?: number | null;
  name: string;
}

export function createFolder(db: Db, input: CreateFolderInput): FolderRow {
  const name = assertFolderName(input.name);
  const parentId = input.parentId ?? null;

  return transaction(db, () => {
    const item = one<{ id: number }>(db, 'SELECT id FROM item WHERE id = ?', input.itemId);
    if (!item) throw new Error(`需求不存在: ${input.itemId}`);

    if (parentId !== null) {
      const parent = getFolder(db, parentId);
      if (!parent) throw new Error(`上级文件夹不存在: ${parentId}`);
      if (parent.item_id !== input.itemId) throw new Error('上级文件夹不属于这个需求');
    }

    assertNameFree(db, input.itemId, parentId, name);

    const info = run(
      db,
      'INSERT INTO folder (item_id, parent_id, name, created_at) VALUES (?, ?, ?, ?)',
      input.itemId,
      parentId,
      name,
      nowIso(),
    );
    return getFolder(db, lastId(info))!;
  });
}

function mustGetFolder(db: Db, folderId: number): FolderRow {
  const folder = getFolder(db, folderId);
  if (!folder) throw new Error(`文件夹不存在: ${folderId}`);
  return folder;
}

function renameInTx(db: Db, folder: FolderRow, name: string): FolderRow {
  const clean = assertFolderName(name);
  assertNameFree(db, folder.item_id, folder.parent_id, clean, folder.id);
  run(db, 'UPDATE folder SET name = ? WHERE id = ?', clean, folder.id);
  return getFolder(db, folder.id)!;
}

/**
 * 移动文件夹。
 *
 * 必须检查环：把文件夹移进它自己的子孙里，树就断了 ——
 * 那样 `folderTree` 会得到一个永远走不到根的孤岛，界面上它直接消失。
 */
function moveInTx(db: Db, folder: FolderRow, parentId: number | null): FolderRow {
  if (parentId === folder.id) throw new Error('不能把文件夹移进它自己');

  if (parentId !== null) {
    const parent = getFolder(db, parentId);
    if (!parent) throw new Error(`目标文件夹不存在: ${parentId}`);
    if (parent.item_id !== folder.item_id) throw new Error('不能跨需求移动文件夹');

    // 从目标往上走，撞到自己就是环
    let cursor: number | null = parentId;
    const seen = new Set<number>();
    while (cursor !== null) {
      if (cursor === folder.id) throw new Error('不能把文件夹移进它自己的子文件夹里');
      if (seen.has(cursor)) throw new Error('文件夹层级里有环，先修好再移动');
      seen.add(cursor);
      cursor = getFolder(db, cursor)?.parent_id ?? null;
    }
  }

  assertNameFree(db, folder.item_id, parentId, folder.name, folder.id);
  run(db, 'UPDATE folder SET parent_id = ? WHERE id = ?', parentId, folder.id);
  return getFolder(db, folder.id)!;
}

export function renameFolder(db: Db, folderId: number, name: string): FolderRow {
  return transaction(db, () => renameInTx(db, mustGetFolder(db, folderId), name));
}

export function moveFolder(db: Db, folderId: number, parentId: number | null): FolderRow {
  return transaction(db, () => moveInTx(db, mustGetFolder(db, folderId), parentId));
}

/**
 * 改名和移动一起做，**在同一个事务里**。
 *
 * 分开调用的话，改名成功、移动失败就会留下半截改动。
 * 顺序也不能反：先按旧父层校验重名，再按新父层校验。
 */
export function updateFolder(
  db: Db,
  folderId: number,
  patch: { name?: string; parentId?: number | null },
): FolderRow {
  return transaction(db, () => {
    let folder = mustGetFolder(db, folderId);
    if (patch.name !== undefined) folder = renameInTx(db, folder, patch.name);
    if (patch.parentId !== undefined) folder = moveInTx(db, folder, patch.parentId);
    return folder;
  });
}

/** 该文件夹下直接放着的东西（不含子文件夹里的） */
export function folderContents(
  db: Db,
  folderId: number,
): { folders: number; files: number } {
  return {
    folders: all<{ id: number }>(db, 'SELECT id FROM folder WHERE parent_id = ?', folderId).length,
    files: all<{ id: number }>(
      db,
      'SELECT id FROM deliverable WHERE folder_id = ?',
      folderId,
    ).length,
  };
}

/**
 * 删文件夹。
 *
 * **不删里面的东西** —— 里面有文件或子文件夹时直接拒绝，并说清有几个。
 * 自动把内容挪到上一级看着方便，但「我删了个文件夹，结果 30 个截图散到根目录了」
 * 更让人恼火。宁可让用户明确地先移走。
 */
export function deleteFolder(db: Db, folderId: number): void {
  transaction(db, () => {
    const folder = getFolder(db, folderId);
    if (!folder) throw new Error(`文件夹不存在: ${folderId}`);

    const { folders, files } = folderContents(db, folderId);
    if (folders > 0 || files > 0) {
      const parts: string[] = [];
      if (files > 0) parts.push(`${files} 个交付物`);
      if (folders > 0) parts.push(`${folders} 个子文件夹`);
      throw new Error(`「${folder.name}」里还有${parts.join('和')}，先把它们移走再删`);
    }

    run(db, 'DELETE FROM folder WHERE id = ?', folderId);
  });
}

/** 把交付物归到某个文件夹（null = 根目录）。只改归置，不碰阶段。 */
export function moveDeliverable(db: Db, deliverableId: number, folderId: number | null): void {
  transaction(db, () => {
    const deliverable = one<{ id: number; item_id: number }>(
      db,
      'SELECT id, item_id FROM deliverable WHERE id = ?',
      deliverableId,
    );
    if (!deliverable) throw new Error(`交付物不存在: ${deliverableId}`);

    if (folderId !== null) {
      const folder = getFolder(db, folderId);
      if (!folder) throw new Error(`文件夹不存在: ${folderId}`);
      if (folder.item_id !== deliverable.item_id) throw new Error('不能把交付物移到别的需求的文件夹里');
    }

    run(
      db,
      'UPDATE deliverable SET folder_id = ?, updated_at = ? WHERE id = ?',
      folderId,
      nowIso(),
      deliverableId,
    );
  });
}

/** 交付物 + 它所在的文件夹名，用来在阶段视图里显示「在 assets/」 */
export function folderNameOf(db: Db, folderId: number | null): string | null {
  if (folderId === null) return null;
  return getFolder(db, folderId)?.name ?? null;
}
