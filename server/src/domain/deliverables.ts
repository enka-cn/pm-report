import fs from 'node:fs';
import type {
  DeliverableCategory,
  DeliverableRow,
  DeliverableVersionRow,
  DeliverableWithVersions,
  DropFileResult,
} from '@manager/shared';
import { all, count, lastId, nowIso, one, run, transaction, type Db } from '../db/index.ts';
import { recordEvent } from './events.ts';
import { listStoredFiles } from './storage.ts';

export interface NewFileInput {
  sha256: string;
  relPath: string;
  /** 原始文件名，下载时还原 */
  filename: string;
  sizeBytes: number;
  mime?: string | null;
  note?: string | null;
}

export interface AddDeliverableInput {
  itemId: number;
  stageId?: number | null;
  /** 归到哪个文件夹。不传就是根目录 */
  folderId?: number | null;
  name: string;
  category?: DeliverableCategory;
  /** 必交项会变成阶段卡点：未上传时推进阶段需要强制确认 */
  required?: boolean;
  file: NewFileInput;
}

/**
 * sha256 是内容的唯一标识，也是下载接口唯一认的键（`/api/files/:sha256` 会对它做格式校验）。
 * 库里放一个格式不对的值，就等于放了一条永远下载不了的记录 —— 所以在唯一的写入口挡住。
 */
function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`不是合法的 sha256（应为 64 位小写十六进制）: ${value}`);
  }
}

function insertVersion(db: Db, deliverableId: number, file: NewFileInput, when: string): DeliverableVersionRow {
  assertSha256(file.sha256);

  const next = Number(
    one<{ n: number }>(
      db,
      'SELECT IFNULL(MAX(version_no), 0) + 1 AS n FROM deliverable_version WHERE deliverable_id = ?',
      deliverableId,
    )!.n,
  );

  const info = run(
    db,
    `INSERT INTO deliverable_version
       (deliverable_id, version_no, sha256, rel_path, original_filename, size_bytes, mime, note, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    deliverableId,
    next,
    file.sha256,
    file.relPath,
    file.filename,
    file.sizeBytes,
    file.mime ?? null,
    file.note ?? null,
    when,
  );
  const versionId = lastId(info);
  run(db, 'UPDATE deliverable SET current_version_id = ?, updated_at = ? WHERE id = ?', versionId, when, deliverableId);

  return one<DeliverableVersionRow>(db, 'SELECT * FROM deliverable_version WHERE id = ?', versionId)!;
}

/** 新建交付物并上传它的第一个版本 */
export function addDeliverable(db: Db, input: AddDeliverableInput): DeliverableWithVersions {
  if (!input.name.trim()) throw new Error('交付物名称不能为空');

  return transaction(db, () => {
    const item = one<{ id: number }>(db, 'SELECT id FROM item WHERE id = ?', input.itemId);
    if (!item) throw new Error(`需求不存在: ${input.itemId}`);

    const when = nowIso();
    const info = run(
      db,
      `INSERT INTO deliverable (item_id, stage_id, folder_id, name, category, required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.itemId,
      input.stageId ?? null,
      input.folderId ?? null,
      input.name,
      input.category ?? 'other',
      input.required ? 1 : 0,
      when,
      when,
    );
    const deliverableId = lastId(info);
    const version = insertVersion(db, deliverableId, input.file, when);

    recordEvent(db, {
      type: 'deliverable_added',
      itemId: input.itemId,
      stageId: input.stageId ?? null,
      deliverableId,
      occurredAt: when,
      payload: {
        deliverable_id: deliverableId,
        name: input.name,
        category: input.category ?? 'other',
        required: input.required === true,
        version_no: version.version_no,
        sha256: version.sha256,
        size_bytes: version.size_bytes,
      },
    });

    return getDeliverable(db, deliverableId)!;
  });
}

/** 给已有交付物加一个版本（同一份文档的第二稿） */
export function addDeliverableVersion(db: Db, deliverableId: number, file: NewFileInput): DeliverableWithVersions {
  return transaction(db, () => {
    const deliverable = one<DeliverableRow>(db, 'SELECT * FROM deliverable WHERE id = ?', deliverableId);
    if (!deliverable) throw new Error(`交付物不存在: ${deliverableId}`);

    const when = nowIso();
    const version = insertVersion(db, deliverableId, file, when);

    recordEvent(db, {
      type: 'deliverable_added',
      itemId: deliverable.item_id,
      stageId: deliverable.stage_id,
      deliverableId,
      occurredAt: when,
      payload: {
        deliverable_id: deliverableId,
        name: deliverable.name,
        category: deliverable.category,
        required: deliverable.required === 1,
        version_no: version.version_no,
        sha256: version.sha256,
        size_bytes: version.size_bytes,
      },
    });

    return getDeliverable(db, deliverableId)!;
  });
}

export function getDeliverable(db: Db, deliverableId: number): DeliverableWithVersions | null {
  const deliverable = one<DeliverableRow>(db, 'SELECT * FROM deliverable WHERE id = ?', deliverableId);
  if (!deliverable) return null;
  return {
    ...deliverable,
    versions: all<DeliverableVersionRow>(
      db,
      'SELECT * FROM deliverable_version WHERE deliverable_id = ? ORDER BY version_no DESC',
      deliverableId,
    ),
  };
}

export function listDeliverables(db: Db, itemId: number, stageId?: number | null): DeliverableWithVersions[] {
  const rows =
    stageId === undefined
      ? all<DeliverableRow>(
          db,
          'SELECT * FROM deliverable WHERE item_id = ? AND removed_at IS NULL ORDER BY id',
          itemId,
        )
      : all<DeliverableRow>(
          db,
          'SELECT * FROM deliverable WHERE item_id = ? AND stage_id IS ? AND removed_at IS NULL ORDER BY id',
          itemId,
          stageId,
        );

  return rows.map((d) => ({
    ...d,
    versions: all<DeliverableVersionRow>(
      db,
      'SELECT * FROM deliverable_version WHERE deliverable_id = ? ORDER BY version_no DESC',
      d.id,
    ),
  }));
}

/** 已移除的交付物。单独列出来，好让「移除」这件事是可逆的 */
export function listRemovedDeliverables(db: Db, itemId: number): DeliverableWithVersions[] {
  return all<DeliverableRow>(
    db,
    'SELECT * FROM deliverable WHERE item_id = ? AND removed_at IS NOT NULL ORDER BY removed_at DESC',
    itemId,
  ).map((d) => ({
    ...d,
    versions: all<DeliverableVersionRow>(
      db,
      'SELECT * FROM deliverable_version WHERE deliverable_id = ? ORDER BY version_no DESC',
      d.id,
    ),
  }));
}

/** 该阶段还没上传的必交项。推进阶段时的卡点就是它。 */
export function missingRequiredDeliverables(db: Db, stageId: number): DeliverableRow[] {
  return all<DeliverableRow>(
    db,
    `SELECT * FROM deliverable
      WHERE stage_id = ? AND required = 1 AND current_version_id IS NULL AND removed_at IS NULL
      ORDER BY id`,
    stageId,
  );
}

/** 标记/取消必交项 */
export function setDeliverableRequired(db: Db, deliverableId: number, required: boolean): void {
  transaction(db, () => {
    const deliverable = one<DeliverableRow>(db, 'SELECT * FROM deliverable WHERE id = ?', deliverableId);
    if (!deliverable) throw new Error(`交付物不存在: ${deliverableId}`);
    run(
      db,
      'UPDATE deliverable SET required = ?, updated_at = ? WHERE id = ?',
      required ? 1 : 0,
      nowIso(),
      deliverableId,
    );
  });
}

/** 按 sha256 反查一个版本，用于下载时还原原始文件名 */
export function findVersionBySha(db: Db, sha256: string): DeliverableVersionRow | undefined {
  return one<DeliverableVersionRow>(
    db,
    'SELECT * FROM deliverable_version WHERE sha256 = ? ORDER BY id LIMIT 1',
    sha256,
  );
}

/** 改类别。猜错了得能改回来，否则「拖进来自动分类」就是个陷阱。 */
export function setDeliverableCategory(
  db: Db,
  deliverableId: number,
  category: DeliverableCategory,
): void {
  transaction(db, () => {
    const deliverable = one<DeliverableRow>(db, 'SELECT * FROM deliverable WHERE id = ?', deliverableId);
    if (!deliverable) throw new Error(`交付物不存在: ${deliverableId}`);
    run(
      db,
      'UPDATE deliverable SET category = ?, updated_at = ? WHERE id = ?',
      category,
      nowIso(),
      deliverableId,
    );
  });
}

/**
 * 改交付物名。
 *
 * 拖进来的名字是从文件名来的（`QQ图片20261008` 这种），不能改就没法看了。
 * 原始文件名不受影响 —— 它在版本的 `original_filename` 里。
 */
export function renameDeliverable(db: Db, deliverableId: number, name: string): void {
  const clean = name.trim();
  if (!clean) throw new Error('交付物名称不能为空');

  transaction(db, () => {
    const deliverable = one<DeliverableRow>(db, 'SELECT * FROM deliverable WHERE id = ?', deliverableId);
    if (!deliverable) throw new Error(`交付物不存在: ${deliverableId}`);
    run(
      db,
      'UPDATE deliverable SET name = ?, updated_at = ? WHERE id = ?',
      clean,
      nowIso(),
      deliverableId,
    );
  });
}

// ---------------------------------------------------------------------------
// 移除与回收 —— 「上传错了」的出路
//
// 分两步是刻意的：**记录**和**字节**是两件事。
//   移除：行留下（removed_at 记时间），界面各处不再显示 —— 可逆
//   回收：把没有任何在册交付物引用的字节从磁盘删掉 —— 不可逆，但也不是必须马上做
// 合并成一步的话，误点一次就找不回来了；而分两步，200G 一样能收回来。
// ---------------------------------------------------------------------------

/** 移除一个交付物。软删除：行留着，「回收磁盘」时才真正动文件。 */
export function removeDeliverable(db: Db, deliverableId: number, reason?: string): void {
  transaction(db, () => {
    const deliverable = one<DeliverableRow>(db, 'SELECT * FROM deliverable WHERE id = ?', deliverableId);
    if (!deliverable) throw new Error(`交付物不存在: ${deliverableId}`);
    if (deliverable.removed_at) throw new Error(`「${deliverable.name}」已经移除过了`);

    const when = nowIso();
    run(db, 'UPDATE deliverable SET removed_at = ?, updated_at = ? WHERE id = ?', when, when, deliverableId);

    recordEvent(db, {
      type: 'deliverable_removed',
      itemId: deliverable.item_id,
      stageId: deliverable.stage_id,
      deliverableId,
      occurredAt: when,
      note: reason ?? null,
      payload: { name: deliverable.name, category: deliverable.category, reason: reason ?? null },
    });
  });
}

export function restoreDeliverable(db: Db, deliverableId: number): void {
  transaction(db, () => {
    const deliverable = one<DeliverableRow>(db, 'SELECT * FROM deliverable WHERE id = ?', deliverableId);
    if (!deliverable) throw new Error(`交付物不存在: ${deliverableId}`);
    if (!deliverable.removed_at) throw new Error(`「${deliverable.name}」本来就没有移除`);

    const when = nowIso();
    run(db, 'UPDATE deliverable SET removed_at = NULL, updated_at = ? WHERE id = ?', when, deliverableId);

    recordEvent(db, {
      type: 'deliverable_restored',
      itemId: deliverable.item_id,
      stageId: deliverable.stage_id,
      deliverableId,
      occurredAt: when,
      payload: { name: deliverable.name },
    });
  });
}

/** 还有哪些 sha256 被「在册」的交付物引用着（已移除的不算） */
function liveShas(db: Db): Set<string> {
  return new Set(
    all<{ sha256: string }>(
      db,
      `SELECT DISTINCT v.sha256
         FROM deliverable_version v
         JOIN deliverable d ON d.id = v.deliverable_id
        WHERE d.removed_at IS NULL`,
    ).map((r) => r.sha256),
  );
}

export interface StorageUsageResult {
  totalFiles: number;
  totalBytes: number;
  recoverableFiles: number;
  recoverableBytes: number;
  removedDeliverables: number;
}

/** 磁盘上现在占了多少、其中多少是移除之后能收回来的 */
export function storageUsage(db: Db, filesDir: string): StorageUsageResult {
  const onDisk = listStoredFiles(filesDir);
  const live = liveShas(db);

  let recoverableFiles = 0;
  let recoverableBytes = 0;
  for (const file of onDisk) {
    if (live.has(file.sha256)) continue;
    recoverableFiles++;
    recoverableBytes += file.bytes;
  }

  return {
    totalFiles: onDisk.length,
    totalBytes: onDisk.reduce((sum, f) => sum + f.bytes, 0),
    recoverableFiles,
    recoverableBytes,
    removedDeliverables: count(
      db,
      'SELECT COUNT(*) AS n FROM deliverable WHERE removed_at IS NOT NULL',
    ),
  };
}

export interface PurgeOutcome {
  deletedVersions: number;
  deletedFiles: number;
  freedBytes: number;
  keptShared: number;
}

/**
 * 回收磁盘：删掉没有任何**在册**交付物引用的字节。
 *
 * 顺序是刻意的 —— **先提交数据库，再删文件**：
 *   - 反过来的话，数据库失败会留下一堆「记录还在、文件没了」的死链，点下载就 404
 *   - 这个顺序最坏只会留下孤儿文件（没人引用但还占着地），下次回收顺手就清了
 *
 * 内容寻址在这里帮了大忙：同一份内容被多个交付物引用时，只要还有一个在册的，
 * 字节就留着（`keptShared` 会告诉你保住了几个）。
 */
export function purgeFiles(db: Db, filesDir: string): PurgeOutcome {
  const { deletedVersions, live } = transaction(db, () => {
    // 已移除交付物的版本记录先删掉 —— 它们的字节引用随之失效
    const doomed = all<{ id: number }>(
      db,
      `SELECT v.id FROM deliverable_version v
         JOIN deliverable d ON d.id = v.deliverable_id
        WHERE d.removed_at IS NOT NULL`,
    );
    for (const v of doomed) run(db, 'DELETE FROM deliverable_version WHERE id = ?', v.id);

    // current_version_id 可能悬空了，收拾干净
    run(
      db,
      `UPDATE deliverable SET current_version_id = NULL
        WHERE current_version_id IS NOT NULL
          AND current_version_id NOT IN (SELECT id FROM deliverable_version)`,
    );

    return { deletedVersions: doomed.length, live: liveShas(db) };
  });

  let deletedFiles = 0;
  let freedBytes = 0;
  let keptShared = 0;

  for (const file of listStoredFiles(filesDir)) {
    if (live.has(file.sha256)) {
      keptShared++;
      continue;
    }
    try {
      fs.rmSync(file.abs, { force: true });
      deletedFiles++;
      freedBytes += file.bytes;
    } catch {
      // 删不掉（被占用之类）就先留着，下次回收再来
    }
  }

  return { deletedVersions, deletedFiles, freedBytes, keptShared };
}

// ---------------------------------------------------------------------------
// 拖进来就加入
// ---------------------------------------------------------------------------

/**
 * 从扩展名猜类别。
 *
 * 两条刻意的克制：
 *   1. **只看扩展名，不看文件名里的关键词。** 按关键词猜（比如名字含「评审」就归到评审记录）
 *      会变成"有时候猜得莫名其妙"，而这种不确定性比归错一类更烦人。
 *   2. 猜错的代价必须低 —— 所以界面上能改（见 setDeliverableCategory）。
 */
const CATEGORY_BY_EXT: Record<string, DeliverableCategory> = {
  // 截图
  png: 'screenshot', jpg: 'screenshot', jpeg: 'screenshot', gif: 'screenshot',
  webp: 'screenshot', bmp: 'screenshot', svg: 'screenshot',
  // 设计
  drawio: 'design', dio: 'design', puml: 'design', plantuml: 'design',
  mmd: 'design', vsdx: 'design', excalidraw: 'design',
  // 日志
  log: 'log', out: 'log', err: 'log',
  // 文档（含表格与幻灯片 —— 「文档」是这一档里最宽的桶）
  md: 'doc', txt: 'doc', doc: 'doc', docx: 'doc', pdf: 'doc', rtf: 'doc', odt: 'doc',
  xls: 'doc', xlsx: 'doc', csv: 'doc', ppt: 'doc', pptx: 'doc',
};

export function isDeliverableCategory(value: unknown): value is DeliverableCategory {
  return (
    typeof value === 'string' &&
    ['doc', 'design', 'screenshot', 'log', 'review_record', 'other'].includes(value)
  );
}

/** 取扩展名（小写，不含点）。没有扩展名返回空串。 */
function extensionOf(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function guessCategory(filename: string): DeliverableCategory {
  return CATEGORY_BY_EXT[extensionOf(filename)] ?? 'other';
}

/**
 * 文件名 → 交付物名。
 *
 * 去掉扩展名：交付物是「送测申请单」，`送测申请单.docx` 只是它的第 1 版。
 * 原始文件名没有丢 —— 它在版本的 `original_filename` 里，下载时还原。
 * 前导点不剥（`.gitignore` 是一个整体，不是名字 + 扩展名）。
 */
export function deliverableNameFrom(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '').trim();
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? base.slice(0, dot) : base;
  return name.trim() || base;
}

export type DropAction = DropFileResult['action'];

export interface DropInput {
  itemId: number;
  /** 落到哪个阶段。不传就是「不属于任何阶段」 */
  stageId?: number | null;
  /** 归到哪个文件夹。不传就是根目录 */
  folderId?: number | null;
  /** 已经落盘的文件元数据（storeFile 的结果） */
  files: NewFileInput[];
}

/**
 * 一批文件直接变成交付物。
 *
 * 三条规则：
 *   1. **同名归到同一条。** 同一条需求下已经有同名交付物时，这次上传是**它的新版本**，
 *      而不是又建一条。否则拖两次同一个文件就会得到两条长得一样的交付物。
 *      这也让「必交项」真正好用：你建一条叫「SEG 评审记录」并勾上必交，
 *      之后把文件拖进这个阶段，它自动补上那一版，卡点就解了。
 *   2. **内容没变就不造版本。** 同一个文件拖两次，第二次是空操作，不是 v2。
 *   3. **一个文件失败不拖累整批。** 拖 5 个进来不该因为第 3 个失败就全丢，
 *      所以每个文件独立成事务，失败的那个把原因记在结果里。
 */
export function dropDeliverables(db: Db, input: DropInput): DropFileResult[] {
  const item = one<{ id: number }>(db, 'SELECT id FROM item WHERE id = ?', input.itemId);
  if (!item) throw new Error(`需求不存在: ${input.itemId}`);

  return input.files.map((file) => {
    const name = deliverableNameFrom(file.filename);
    try {
      const existing = one<DeliverableRow>(
        db,
        `SELECT * FROM deliverable
          WHERE item_id = ? AND lower(trim(name)) = lower(trim(?)) AND removed_at IS NULL
          ORDER BY id LIMIT 1`,
        input.itemId,
        name,
      );

      if (!existing) {
        const created = addDeliverable(db, {
          itemId: input.itemId,
          stageId: input.stageId ?? null,
          folderId: input.folderId ?? null,
          name,
          category: guessCategory(file.filename),
          required: false,
          file,
        });
        return { filename: file.filename, deliverableName: name, action: 'created', deliverable: created };
      }

      const current =
        existing.current_version_id === null
          ? undefined
          : one<DeliverableVersionRow>(
              db,
              'SELECT * FROM deliverable_version WHERE id = ?',
              existing.current_version_id,
            );

      if (current && current.sha256 === file.sha256) {
        return {
          filename: file.filename,
          deliverableName: existing.name,
          action: 'unchanged',
          deliverable: getDeliverable(db, existing.id)!,
        };
      }

      const updated = addDeliverableVersion(db, existing.id, file);
      return {
        filename: file.filename,
        deliverableName: existing.name,
        action: 'versioned',
        deliverable: updated,
      };
    } catch (err) {
      return {
        filename: file.filename,
        deliverableName: name,
        action: 'failed',
        error: (err as Error).message,
      };
    }
  });
}
