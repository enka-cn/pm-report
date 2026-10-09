import type {
  BlockerRow,
  CloseReason,
  ItemDetail,
  ItemViewRow,
  PipelineTemplate,
  ProjectRow,
  Role,
  StageRow,
  TodoRow,
} from '@manager/shared';
import { all, count, lastId, nowIso, one, run, transaction, type Db } from '../db/index.ts';
import { loadSettings } from '../config.ts';
import { listEventsInRange, listTimeline, recordEvent } from './events.ts';
import { activeStage, listBlockers, listStages, listTodos, startStageInTx } from './stages.ts';
import { resolvePipeline } from './pipeline.ts';
import { listDeliverables, listRemovedDeliverables } from './deliverables.ts';
import { folderTree } from './folders.ts';
import { listLinks } from './links.ts';
import { assertDateOnly } from './dates.ts';

// ---------------------------------------------------------------------------
// 项目容器（P1 隐式，UI 不暴露；见设计文档 D4）
// ---------------------------------------------------------------------------

export function ensureDefaultProject(db: Db): number {
  const existing = one<{ id: number }>(db, 'SELECT id FROM project WHERE is_default = 1');
  if (existing) return Number(existing.id);

  const when = nowIso();
  const info = run(
    db,
    `INSERT INTO project (code, name, description, is_default, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
    'DEFAULT',
    '默认项目',
    'P1 只有一个隐式项目容器，UI 不暴露；将来启用项目层时把需求挪进真实项目即可（设计文档 D4）',
    when,
    when,
  );
  return lastId(info);
}

// ---------------------------------------------------------------------------
// 需求
// ---------------------------------------------------------------------------

export interface CreateItemInput {
  title: string;
  role: Role;
  description?: string | null;
  criticality?: number;
  dueAt?: string | null;
  /** 不传则按角色取第一个模板 */
  pipelineKey?: string | null;
  /** 归属项目。不传就是隐式的默认项目。 */
  projectId?: number | null;
}

export function createItem(
  db: Db,
  templates: PipelineTemplate[],
  input: CreateItemInput,
): ItemDetail {
  if (!input.title?.trim()) throw new Error('需求标题不能为空');
  const settings = loadSettings();
  const pipeline = resolvePipeline(templates, input.role, input.pipelineKey);

  const projectId = input.projectId ?? ensureDefaultProject(db);
  const project = one<ProjectRow>(db, 'SELECT * FROM project WHERE id = ?', projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}`);
  if (project.archived_at) throw new Error(`项目「${project.name}」已归档，不能再往里加需求`);

  return transaction(db, () => {
    const when = nowIso();

    // 单用户场景，取 max(id)+1 生成人类可读编号足够；UNIQUE 约束是兜底。
    const nextId = Number(one<{ n: number }>(db, 'SELECT IFNULL(MAX(id), 0) + 1 AS n FROM item')!.n);
    const code = `${settings.item.code_prefix}-${nextId}`;

    const info = run(
      db,
      `INSERT INTO item
         (code, project_id, title, description, role, criticality, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code,
      projectId,
      input.title,
      input.description ?? null,
      input.role,
      input.criticality ?? settings.item.default_criticality,
      input.dueAt ?? null,
      when,
      when,
    );
    const itemId = lastId(info);

    recordEvent(db, {
      type: 'item_created',
      itemId,
      occurredAt: when,
      payload: {
        code,
        role: input.role,
        pipeline_key: pipeline.key,
        stages: pipeline.stages.map((s) => s.key),
      },
    });

    pipeline.stages.forEach((def, idx) => {
      const sInfo = run(
        db,
        `INSERT INTO stage
           (item_id, seq, key, name, kind, wait_counterparty, wait_for, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        itemId,
        idx + 1,
        def.key,
        def.name,
        def.kind,
        def.wait_counterparty ?? null,
        def.wait_for ?? null,
        when,
        when,
      );
      const stageId = lastId(sInfo);

      // 模板生成的待办不写事件：它们是 item_created 的一部分。
      // 逐条写 todo_added 会把时间线冲成噪声，汇报就没法看了。
      (def.todos ?? []).forEach((text, ti) => {
        run(
          db,
          `INSERT INTO todo (item_id, stage_id, text, seq, source, created_at)
           VALUES (?, ?, ?, ?, 'template', ?)`,
          itemId,
          stageId,
          text,
          ti + 1,
          when,
        );
      });

      if (idx === 0) {
        startStageInTx(db, itemId, one<StageRow>(db, 'SELECT * FROM stage WHERE id = ?', stageId)!, when);
      }
    });

    return getItem(db, itemId)!;
  });
}

export function getItem(db: Db, itemId: number): ItemDetail | null {
  const item = one<ItemViewRow>(db, 'SELECT * FROM v_item WHERE id = ?', itemId);
  if (!item) return null;

  const project = one<ProjectRow>(db, 'SELECT * FROM project WHERE id = ?', item.project_id);
  if (!project) throw new Error(`需求 ${item.code} 指向的项目 ${item.project_id} 不存在`);

  return {
    item,
    project,
    stages: listStages(db, itemId),
    todos: listTodos(db, itemId),
    blockers: listBlockers(db, itemId),
    deliverables: listDeliverables(db, itemId),
    removedDeliverables: listRemovedDeliverables(db, itemId),
    links: listLinks(db, itemId),
    tree: folderTree(db, itemId),
  };
}

export interface ListItemsFilter {
  /** 标题或编号的模糊匹配 */
  q?: string;
  role?: Role;
  condition?: ItemViewRow['condition'];
  /** 只看某个项目下的需求 */
  projectId?: number;
  /** 默认不含已关闭的需求 */
  includeClosed?: boolean;
  limit?: number;
}

export function listItems(db: Db, filter: ListItemsFilter = {}): ItemViewRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  // 「默认隐藏已关闭」和「显式只看已关闭」是互相矛盾的两个条件，
  // 撞在一起会让 condition='closed' 永远返回空。显式要 closed 就等于要 includeClosed。
  const wantsClosed = filter.includeClosed === true || filter.condition === 'closed';
  if (!wantsClosed) where.push('closed_at IS NULL');
  if (filter.q) {
    where.push('(title LIKE ? OR code LIKE ? OR IFNULL(description, \'\') LIKE ?)');
    const like = `%${filter.q}%`;
    params.push(like, like, like);
  }
  if (filter.role) {
    where.push('role = ?');
    params.push(filter.role);
  }
  if (filter.projectId !== undefined) {
    where.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.condition) {
    where.push('condition = ?');
    params.push(filter.condition);
  }

  const sql =
    `SELECT * FROM v_item` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    // 手动置顶/置底永远覆盖自动排序，但列表页仍按关键度+编号给个稳定顺序
    ` ORDER BY (priority_override IS NULL), priority_override DESC, criticality DESC, id DESC` +
    (filter.limit ? ' LIMIT ?' : '');
  if (filter.limit) params.push(filter.limit);

  return all<ItemViewRow>(db, sql, ...params);
}

/**
 * 需求的「下一个 DDL」= min(未结束阶段的 planned_end, 需求整体 due_at)。
 * 这是驾驶舱的核心输入，所以单独抽出来并做成纯函数，便于测试。
 */
export function nextDdl(item: { due_at: string | null }, stages: StageRow[]): string | null {
  const candidates: string[] = [];
  if (item.due_at) candidates.push(item.due_at);
  for (const s of stages) {
    if (s.actual_end_at) continue; // 已结束的阶段不再是待办压力
    if (s.planned_end) candidates.push(s.planned_end);
  }
  if (candidates.length === 0) return null;
  return candidates.sort()[0]!;
}

// ---------------------------------------------------------------------------
// 需求级状态变更
// ---------------------------------------------------------------------------

/** 记一条进展备注。汇报的「备注」段直接照录这些内容。 */
export function noteItem(db: Db, itemId: number, text: string, occurredAt?: string): number {
  if (!text.trim()) throw new Error('备注内容不能为空');
  return transaction(db, () => {
    const item = one<{ id: number }>(db, 'SELECT id FROM item WHERE id = ?', itemId);
    if (!item) throw new Error(`需求不存在: ${itemId}`);
    return recordEvent(db, { type: 'note', itemId, note: text, occurredAt });
  });
}

export function setItemDueDate(db: Db, itemId: number, dueAt: string | null): void {
  transaction(db, () => {
    const item = one<{ due_at: string | null }>(db, 'SELECT due_at FROM item WHERE id = ?', itemId);
    if (!item) throw new Error(`需求不存在: ${itemId}`);
    if (dueAt !== null) assertDateOnly(dueAt, '需求交付日期');

    const when = nowIso();
    run(db, 'UPDATE item SET due_at = ?, updated_at = ? WHERE id = ?', dueAt, when, itemId);
    recordEvent(db, {
      type: 'ddl_change',
      itemId,
      occurredAt: when,
      payload: { scope: 'item', old: item.due_at, new: dueAt },
    });
  });
}

/** 挂起整个需求：跨越阶段，语义是「我知道它停了，别催我」。 */
export function suspendItem(db: Db, itemId: number, reason: string): void {
  if (!reason.trim()) throw new Error('挂起必须写原因');
  transaction(db, () => {
    const item = one<{ suspended_at: string | null; closed_at: string | null }>(
      db,
      'SELECT suspended_at, closed_at FROM item WHERE id = ?',
      itemId,
    );
    if (!item) throw new Error(`需求不存在: ${itemId}`);
    if (item.closed_at) throw new Error('需求已经关闭，不能再挂起');
    if (item.suspended_at) throw new Error('需求已经处于挂起状态');

    const when = nowIso();
    run(
      db,
      'UPDATE item SET suspended_at = ?, suspended_reason = ?, updated_at = ? WHERE id = ?',
      when,
      reason,
      when,
      itemId,
    );
    recordEvent(db, {
      type: 'suspend',
      itemId,
      occurredAt: when,
      payload: { scope: 'item', reason },
    });
  });
}

export function resumeItem(db: Db, itemId: number): void {
  transaction(db, () => {
    const item = one<{ suspended_at: string | null }>(
      db,
      'SELECT suspended_at FROM item WHERE id = ?',
      itemId,
    );
    if (!item) throw new Error(`需求不存在: ${itemId}`);
    if (!item.suspended_at) throw new Error('需求本来就没有挂起');

    const when = nowIso();
    run(
      db,
      'UPDATE item SET suspended_at = NULL, suspended_reason = NULL, updated_at = ? WHERE id = ?',
      when,
      itemId,
    );
    recordEvent(db, { type: 'resume', itemId, occurredAt: when, payload: { scope: 'item' } });
  });
}

export interface CloseItemInput {
  reason: CloseReason;
  note?: string;
  /** 还有未结束的阶段时，必须显式强推 */
  forced?: boolean;
}

export function closeItem(db: Db, itemId: number, input: CloseItemInput): void {
  transaction(db, () => {
    const item = one<{ closed_at: string | null }>(db, 'SELECT closed_at FROM item WHERE id = ?', itemId);
    if (!item) throw new Error(`需求不存在: ${itemId}`);
    if (item.closed_at) throw new Error('需求已经关闭');

    const unfinished = all<{ name: string }>(
      db,
      'SELECT name FROM stage WHERE item_id = ? AND actual_end_at IS NULL ORDER BY seq',
      itemId,
    );
    if (unfinished.length > 0 && input.reason === 'done' && !input.forced) {
      throw new Error(
        `还有 ${unfinished.length} 个阶段没结束（${unfinished.map((s) => s.name).join('、')}）。` +
          `确认已完成请传 forced=true；如果其实是取消了，请用 reason='cancelled'。`,
      );
    }

    const when = nowIso();
    run(
      db,
      'UPDATE item SET closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?',
      when,
      input.reason,
      when,
      itemId,
    );
    recordEvent(db, {
      type: 'item_close',
      itemId,
      occurredAt: when,
      note: input.note ?? null,
      payload: {
        close_reason: input.reason,
        unfinished_stages: unfinished.map((s) => s.name),
      },
    });
  });
}

export function reopenItem(db: Db, itemId: number, note?: string): void {
  transaction(db, () => {
    const item = one<{ closed_at: string | null }>(db, 'SELECT closed_at FROM item WHERE id = ?', itemId);
    if (!item) throw new Error(`需求不存在: ${itemId}`);
    if (!item.closed_at) throw new Error('需求本来就没有关闭');

    const when = nowIso();
    run(
      db,
      'UPDATE item SET closed_at = NULL, close_reason = NULL, updated_at = ? WHERE id = ?',
      when,
      itemId,
    );
    recordEvent(db, { type: 'item_reopen', itemId, occurredAt: when, note: note ?? null, payload: {} });
  });
}

export { activeStage, listStages, listTodos, listBlockers, listTimeline, listEventsInRange, count };
