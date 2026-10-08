import type { EventRow, EventType } from '@manager/shared';
import { all, lastId, nowIso, one, run, type Db } from '../db/index.ts';

export interface RecordEventInput {
  type: EventType;
  itemId?: number | null;
  stageId?: number | null;
  deliverableId?: number | null;
  blockerId?: number | null;
  /** 项目级事件（建项目、交接…）用这个 */
  projectId?: number | null;
  payload?: Record<string, unknown> | null;
  note?: string | null;
  actor?: string;
  /** 允许回填（补记昨天做的事）。默认 now。 */
  occurredAt?: string;
}

/**
 * 写入事件的**唯一入口**（设计文档 D1）。
 *
 * 任何状态变更都必须经过这里。UI 和未来的 CLI 都调同一套服务层，
 * 不允许旁路写库 —— 一旦有旁路，事件日志就不再是完整真相，
 * 汇报会开始骗人，而这个系统一旦撒谎就没有价值了。
 */
export function recordEvent(db: Db, input: RecordEventInput): number {
  const info = run(
    db,
    `INSERT INTO event
       (type, item_id, stage_id, deliverable_id, blocker_id, project_id, payload, note, actor, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.type,
    input.itemId ?? null,
    input.stageId ?? null,
    input.deliverableId ?? null,
    input.blockerId ?? null,
    input.projectId ?? null,
    input.payload == null ? null : JSON.stringify(input.payload),
    input.note ?? null,
    input.actor ?? 'me',
    input.occurredAt ?? nowIso(),
  );
  return lastId(info);
}

/**
 * 作废一条事件。事件表不允许改删（数据库触发器挡死），
 * 记错了只能作废留痕 —— 这是「历史不可篡改」的代价，也是它的价值。
 */
export function voidEvent(db: Db, eventId: number, reason: string): void {
  if (!reason.trim()) throw new Error('作废事件必须写原因');
  const existing = one<EventRow>(db, 'SELECT * FROM event WHERE id = ?', eventId);
  if (!existing) throw new Error(`事件不存在: ${eventId}`);
  if (existing.voided_at) throw new Error(`事件 ${eventId} 已经作废过了`);
  run(
    db,
    'UPDATE event SET voided_at = ?, void_reason = ? WHERE id = ?',
    nowIso(),
    reason,
    eventId,
  );
}

export interface TimelineOptions {
  /** 区间起点（含） */
  from?: string;
  /** 区间终点（不含） */
  to?: string;
  /** 默认排除已作废事件 */
  includeVoided?: boolean;
  limit?: number;
}

export function listTimeline(db: Db, itemId: number, opts: TimelineOptions = {}): EventRow[] {
  const where: string[] = ['item_id = ?'];
  const params: unknown[] = [itemId];

  if (opts.from) {
    where.push('occurred_at >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    where.push('occurred_at < ?');
    params.push(opts.to);
  }
  if (!opts.includeVoided) where.push('voided_at IS NULL');

  // 同一时刻的多条事件按 id 排，保证时间线顺序稳定
  let sql = `SELECT * FROM event WHERE ${where.join(' AND ')} ORDER BY occurred_at ASC, id ASC`;
  if (opts.limit) {
    sql = `SELECT * FROM (${sql} DESC) ORDER BY occurred_at DESC, id DESC LIMIT ?`;
    params.push(opts.limit);
  }
  return all<EventRow>(db, sql, ...params);
}

/** 项目级事件流（建项目、改看护条件、交接…） */
export function listProjectTimeline(db: Db, projectId: number): EventRow[] {
  return all<EventRow>(
    db,
    `SELECT * FROM event
      WHERE project_id = ? AND voided_at IS NULL
      ORDER BY occurred_at ASC, id ASC`,
    projectId,
  );
}

/** 区间内的事件，按需求分组。汇报生成的基础查询。 */
export function listEventsInRange(db: Db, from: string, to: string): EventRow[] {
  return all<EventRow>(
    db,
    `SELECT * FROM event
      WHERE occurred_at >= ? AND occurred_at < ? AND voided_at IS NULL
      ORDER BY occurred_at ASC, id ASC`,
    from,
    to,
  );
}
