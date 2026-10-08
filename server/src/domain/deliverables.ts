import type {
  DeliverableCategory,
  DeliverableRow,
  DeliverableVersionRow,
  DeliverableWithVersions,
} from '@manager/shared';
import { all, lastId, nowIso, one, run, transaction, type Db } from '../db/index.ts';
import { recordEvent } from './events.ts';

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
  name: string;
  category?: DeliverableCategory;
  /** 必交项会变成阶段卡点：未上传时推进阶段需要强制确认 */
  required?: boolean;
  file: NewFileInput;
}

function insertVersion(db: Db, deliverableId: number, file: NewFileInput, when: string): DeliverableVersionRow {
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
      `INSERT INTO deliverable (item_id, stage_id, name, category, required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.itemId,
      input.stageId ?? null,
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
      ? all<DeliverableRow>(db, 'SELECT * FROM deliverable WHERE item_id = ? ORDER BY id', itemId)
      : all<DeliverableRow>(
          db,
          'SELECT * FROM deliverable WHERE item_id = ? AND stage_id IS ? ORDER BY id',
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

/** 该阶段还没上传的必交项。推进阶段时的卡点就是它。 */
export function missingRequiredDeliverables(db: Db, stageId: number): DeliverableRow[] {
  return all<DeliverableRow>(
    db,
    'SELECT * FROM deliverable WHERE stage_id = ? AND required = 1 AND current_version_id IS NULL ORDER BY id',
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
