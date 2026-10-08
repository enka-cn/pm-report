import type {
  BlockerRow,
  HandoffResult,
  ItemViewRow,
  ProjectDetail,
  ProjectKind,
  ProjectRow,
  ProjectSummary,
} from '@manager/shared';
import { all, count, lastId, nowIso, one, run, transaction, type Db } from '../db/index.ts';
import { listProjectTimeline, recordEvent } from './events.ts';
import { assertDateOnly } from './dates.ts';
import { ensureDefaultProject } from './items.ts';

/**
 * 项目容器。
 *
 * P1 里它只是隐式的默认项目（见设计文档 D4）。这里启用它，是为了装下
 * §13.1 的看护型项目：一个长期持有、事件驱动、**将来要交接出去**的对象。
 *
 * 两类项目的区别不在「状态」，而在「这是哪种东西」：
 *   - delivery   交付型：有日程，沿流水线推进，子需求做完这个容器也就完成使命
 *   - caretaking 看护型：没有日程，只在外部事件到来时才动，长期持有并可交接
 * 无论哪一类，**容器本身都不进任何时间桶** —— 它压根不是 item，
 * 所以「无 DDL 被骂」这个矛盾自然不存在。
 */

const KINDS: readonly ProjectKind[] = ['delivery', 'caretaking'];

/**
 * P1 没有账号体系，「我」就是 `owner = 'me'`。
 *
 * 交接出去之后项目就不再是**我的**责任，要从我的看护清单里消失（但仍查得到）。
 * 这是「交接」区别于「改个字段」的地方：它改变的是**谁的压力**。
 */
export const CURRENT_OWNER = 'me';

/**
 * 待接收：已经交出去了，但对方还没确认接手。
 *
 * 这段真空期里它**仍然算我的责任** —— 否则责任会在交接的缝隙里蒸发，
 * 而看护型项目的触发条件可能一年后才成立，到那时没人记得。
 */
export function isPendingHandoff(project: ProjectRow): boolean {
  return project.owner !== CURRENT_OWNER && project.handoff_accepted_at === null;
}

function ensureKind(value: unknown): ProjectKind {
  if (typeof value === 'string' && (KINDS as readonly string[]).includes(value)) {
    return value as ProjectKind;
  }
  throw new Error(`项目类型只能是 ${KINDS.join(' / ')}，收到「${String(value)}」`);
}

export function getProject(db: Db, id: number): ProjectRow | undefined {
  return one<ProjectRow>(db, 'SELECT * FROM project WHERE id = ?', id);
}

export interface CreateProjectInput {
  name: string;
  kind?: ProjectKind;
  description?: string | null;
  /** 看护型必填：等什么会触发下一次动作 */
  watchFor?: string | null;
  owner?: string;
  dueAt?: string | null;
}

export function createProject(db: Db, input: CreateProjectInput): ProjectRow {
  if (!input.name?.trim()) throw new Error('项目名称不能为空');
  const kind = ensureKind(input.kind ?? 'delivery');
  if (kind === 'caretaking' && !input.watchFor?.trim()) {
    // 看护条件是这个类型存在的意义：接手的人唯一必须知道的就是「我在等什么才会动」
    throw new Error('看护型项目必须写清「看护条件」——等什么会触发下一次动作');
  }
  if (input.dueAt != null) assertDateOnly(input.dueAt, '项目截止日期');

  return transaction(db, () => {
    const when = nowIso();
    const nextId = Number(one<{ n: number }>(db, 'SELECT IFNULL(MAX(id), 0) + 1 AS n FROM project')!.n);
    const code = `PRJ-${nextId}`;

    const info = run(
      db,
      `INSERT INTO project
         (code, name, description, due_at, is_default, kind, owner, watch_for, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      code,
      input.name.trim(),
      input.description ?? null,
      kind === 'caretaking' ? null : (input.dueAt ?? null),
      kind,
      input.owner ?? 'me',
      input.watchFor ?? null,
      when,
      when,
    );
    const projectId = lastId(info);

    recordEvent(db, {
      type: 'project_created',
      projectId,
      occurredAt: when,
      payload: {
        code,
        name: input.name.trim(),
        kind,
        owner: input.owner ?? 'me',
        watch_for: input.watchFor ?? null,
      },
    });

    return getProject(db, projectId)!;
  });
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  watchFor?: string | null;
  dueAt?: string | null;
}

export function updateProject(db: Db, id: number, patch: UpdateProjectInput): ProjectRow {
  return transaction(db, () => {
    const project = getProject(db, id);
    if (!project) throw new Error(`项目不存在: ${id}`);

    if (patch.dueAt != null) assertDateOnly(patch.dueAt, '项目截止日期');
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('项目名称不能为空');
    if (
      project.kind === 'caretaking' &&
      patch.watchFor !== undefined &&
      !patch.watchFor?.trim()
    ) {
      throw new Error('看护型项目的「看护条件」不能清空——那是接手的人唯一必须知道的事');
    }

    const when = nowIso();
    run(
      db,
      `UPDATE project
          SET name = ?, description = ?, watch_for = ?, due_at = ?, updated_at = ?
        WHERE id = ?`,
      patch.name?.trim() ?? project.name,
      patch.description === undefined ? project.description : patch.description,
      patch.watchFor === undefined ? project.watch_for : patch.watchFor,
      patch.dueAt === undefined ? project.due_at : patch.dueAt,
      when,
      id,
    );

    recordEvent(db, {
      type: 'project_updated',
      projectId: id,
      occurredAt: when,
      payload: { name: patch.name ?? project.name, changed: Object.keys(patch) },
    });

    return getProject(db, id)!;
  });
}

export interface HandoffInput {
  projectId: number;
  toOwner: string;
  note?: string;
}

/**
 * 交接：把这份责任交给别人。
 *
 * 这是**容器级**动作 —— 你不会「交接一次量化」，你会「交接这个看护责任」。
 * 所以除了改负责人，还要在事件里留下接手方需要知道的全部上下文：
 * 看护条件、未关闭的子需求、未解除的阻塞。写在脑子里的交接等于没交接。
 */
export function handoffProject(db: Db, input: HandoffInput): HandoffResult {
  if (!input.toOwner?.trim()) throw new Error('交接必须写清交给谁');
  if (input.toOwner.trim() === 'me') throw new Error('交给自己没有意义');
  if (input.projectId === getDefaultProjectId(db)) throw new Error('默认项目不能交接');

  return transaction(db, () => {
    const project = getProject(db, input.projectId);
    if (!project) throw new Error(`项目不存在: ${input.projectId}`);
    if (project.owner === input.toOwner.trim()) {
      throw new Error(`这个项目本来就归 ${input.toOwner.trim()} 负责`);
    }

    const pendingItems = all<ItemViewRow>(
      db,
      `SELECT v.* FROM v_item v
        WHERE v.project_id = ? AND v.closed_at IS NULL
        ORDER BY v.id`,
      input.projectId,
    ).map((item) => ({
      code: item.code,
      title: item.title,
      current_stage:
        item.active_stage_id === null
          ? null
          : (one<{ name: string }>(db, 'SELECT name FROM stage WHERE id = ?', item.active_stage_id)
              ?.name ?? null),
    }));

    const openBlockers = count(
      db,
      `SELECT COUNT(*) AS n FROM blocker b
         JOIN item i ON i.id = b.item_id
        WHERE i.project_id = ? AND b.closed_at IS NULL`,
      input.projectId,
    );

    const when = nowIso();
    run(
      db,
      // 交出 = 对方还没确认，清掉上一次的确认时间
      'UPDATE project SET owner = ?, handoff_accepted_at = NULL, updated_at = ? WHERE id = ?',
      input.toOwner.trim(),
      when,
      input.projectId,
    );

    recordEvent(db, {
      type: 'project_handoff',
      projectId: input.projectId,
      occurredAt: when,
      note: input.note ?? null,
      payload: {
        from_owner: project.owner,
        to_owner: input.toOwner.trim(),
        watch_for: project.watch_for,
        pending_items: pendingItems,
        open_blockers: openBlockers,
        /** 待接收：在对方确认之前，这条责任仍然留在交出方的看护清单里 */
        awaiting_acceptance: true,
      },
    });

    return { project: getProject(db, input.projectId)!, pending_items: pendingItems, open_blockers: openBlockers };
  });
}

/** 接手方确认接手。到这一刻，交出方才能真正把它从自己的视图里划掉。 */
export function acceptHandoff(db: Db, projectId: number, note?: string): ProjectRow {
  return transaction(db, () => {
    const project = getProject(db, projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    if (project.owner === CURRENT_OWNER) throw new Error('这个项目本来就归我负责，不需要接收');
    if (project.handoff_accepted_at) throw new Error(`${project.owner} 已经确认接手了`);

    const when = nowIso();
    run(
      db,
      'UPDATE project SET handoff_accepted_at = ?, updated_at = ? WHERE id = ?',
      when,
      when,
      projectId,
    );
    recordEvent(db, {
      type: 'project_handoff_accepted',
      projectId,
      occurredAt: when,
      note: note ?? null,
      payload: { owner: project.owner },
    });
    return getProject(db, projectId)!;
  });
}

/**
 * 把责任收回来。
 *
 * 没有这个动作就是个死结：`handoffProject` 拒绝交给自己，
 * 于是一旦交出去，项目永远回不到我名下。
 */
export function reclaimProject(db: Db, projectId: number, note?: string): ProjectRow {
  return transaction(db, () => {
    const project = getProject(db, projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    if (project.owner === CURRENT_OWNER) throw new Error('这个项目本来就归我负责');

    const when = nowIso();
    run(
      db,
      'UPDATE project SET owner = ?, handoff_accepted_at = NULL, updated_at = ? WHERE id = ?',
      CURRENT_OWNER,
      when,
      projectId,
    );
    recordEvent(db, {
      type: 'project_reclaim',
      projectId,
      occurredAt: when,
      note: note ?? null,
      payload: { from_owner: project.owner, to_owner: CURRENT_OWNER },
    });
    return getProject(db, projectId)!;
  });
}

export function archiveProject(db: Db, id: number): ProjectRow {
  return transaction(db, () => {
    const project = getProject(db, id);
    if (!project) throw new Error(`项目不存在: ${id}`);
    if (project.is_default === 1) throw new Error('默认项目不能归档');
    if (project.archived_at) throw new Error('项目已经归档了');

    const active = count(
      db,
      'SELECT COUNT(*) AS n FROM item WHERE project_id = ? AND closed_at IS NULL',
      id,
    );
    if (active > 0) {
      throw new Error(`这个项目还有 ${active} 条未关闭的子需求，先处理掉再归档`);
    }

    const when = nowIso();
    run(db, 'UPDATE project SET archived_at = ?, updated_at = ? WHERE id = ?', when, when, id);
    recordEvent(db, {
      type: 'project_archived',
      projectId: id,
      occurredAt: when,
      payload: { name: project.name },
    });
    return getProject(db, id)!;
  });
}

export function unarchiveProject(db: Db, id: number): ProjectRow {
  return transaction(db, () => {
    const project = getProject(db, id);
    if (!project) throw new Error(`项目不存在: ${id}`);
    if (!project.archived_at) throw new Error('项目本来就没有归档');

    const when = nowIso();
    run(db, 'UPDATE project SET archived_at = NULL, updated_at = ? WHERE id = ?', when, id);
    recordEvent(db, {
      type: 'project_unarchived',
      projectId: id,
      occurredAt: when,
      payload: { name: project.name },
    });
    return getProject(db, id)!;
  });
}

export function getDefaultProjectId(db: Db): number {
  return ensureDefaultProject(db);
}

/** 项目 + 派生统计。列表页和驾驶舱的「看护中」共用。 */
export function listProjects(
  db: Db,
  opts: { kind?: ProjectKind; includeArchived?: boolean; includeDefault?: boolean; owner?: string } = {},
): ProjectSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!opts.includeArchived) where.push('archived_at IS NULL');
  if (!opts.includeDefault) where.push('is_default = 0');
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.owner) {
    where.push('owner = ?');
    params.push(opts.owner);
  }

  const projects = all<ProjectRow>(
    db,
    `SELECT * FROM project ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`,
    ...params,
  );

  return projects.map((p) => summarizeProject(db, p));
}

export function summarizeProject(db: Db, project: ProjectRow): ProjectSummary {
  const totalItems = count(db, 'SELECT COUNT(*) AS n FROM item WHERE project_id = ?', project.id);
  const activeItems = count(
    db,
    'SELECT COUNT(*) AS n FROM item WHERE project_id = ? AND closed_at IS NULL',
    project.id,
  );
  const openBlockers = count(
    db,
    `SELECT COUNT(*) AS n FROM blocker b
       JOIN item i ON i.id = b.item_id
      WHERE i.project_id = ? AND b.closed_at IS NULL`,
    project.id,
  );
  const last = one<{ last: string | null }>(
    db,
    `SELECT MAX(occurred_at) AS last FROM event e
      WHERE e.voided_at IS NULL
        AND (e.project_id = ? OR e.item_id IN (SELECT id FROM item WHERE project_id = ?))`,
    project.id,
    project.id,
  );

  return {
    ...project,
    total_items: totalItems,
    active_items: activeItems,
    open_blockers: openBlockers,
    last_activity_at: last?.last ?? null,
    pending_handoff: isPendingHandoff(project),
  };
}

export function getProjectDetail(db: Db, id: number): ProjectDetail | undefined {
  const project = getProject(db, id);
  if (!project) return undefined;

  const items = all<ItemViewRow>(
    db,
    // 未关闭的排前面（接手的人先看这些），其余按编号
    'SELECT * FROM v_item WHERE project_id = ? ORDER BY (closed_at IS NOT NULL), id',
    id,
  );
  const openBlockers = all<BlockerRow>(
    db,
    `SELECT b.* FROM blocker b
       JOIN item i ON i.id = b.item_id
      WHERE i.project_id = ? AND b.closed_at IS NULL
      ORDER BY b.opened_at`,
    id,
  );

  return {
    project,
    items,
    open_blockers: openBlockers,
    last_activity_at: summarizeProject(db, project).last_activity_at,
  };
}

export { listProjectTimeline };
