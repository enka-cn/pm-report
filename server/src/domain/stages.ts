import type {
  AdvanceStageResult,
  BlockerDirection,
  BlockerRow,
  BlockerSeverity,
  StageOutcome,
  StageRow,
  TodoRow,
} from '@manager/shared';
import { all, count, lastId, nowIso, one, run, transaction, type Db } from '../db/index.ts';
import { recordEvent } from './events.ts';
import { missingRequiredDeliverables } from './deliverables.ts';
import { assertDateOnly } from './dates.ts';

// ---------------------------------------------------------------------------
// 约定：公开函数自己开事务；*InTx 后缀的内部函数要求调用方已持有事务。
// 事务不支持嵌套，所以这个区分是必须的，不是风格问题。
// ---------------------------------------------------------------------------

export function getStage(db: Db, stageId: number): StageRow | undefined {
  return one<StageRow>(db, 'SELECT * FROM stage WHERE id = ?', stageId);
}

export function listStages(db: Db, itemId: number): StageRow[] {
  return all<StageRow>(db, 'SELECT * FROM stage WHERE item_id = ? ORDER BY seq', itemId);
}

/** 进行中的阶段 = 已开始且未结束（没有 status 字段，见设计文档 D2） */
export function activeStage(db: Db, itemId: number): StageRow | undefined {
  return one<StageRow>(
    db,
    `SELECT * FROM stage
      WHERE item_id = ? AND actual_start_at IS NOT NULL AND actual_end_at IS NULL
      LIMIT 1`,
    itemId,
  );
}

// ---------------------------------------------------------------------------
// 阻塞
// ---------------------------------------------------------------------------

export interface OpenBlockerInput {
  itemId: number;
  stageId?: number | null;
  direction: BlockerDirection;
  counterparty: string;
  need: string;
  severity?: BlockerSeverity;
  promisedAt?: string | null;
  openedAt?: string;
}

export function openBlockerInTx(db: Db, input: OpenBlockerInput): number {
  if (!input.counterparty.trim()) throw new Error('阻塞必须写清对方是谁');
  if (!input.need.trim()) throw new Error('阻塞必须写清需要什么');

  const at = input.openedAt ?? nowIso();
  const info = run(
    db,
    `INSERT INTO blocker
       (item_id, stage_id, direction, counterparty, need, severity, opened_at, promised_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.itemId,
    input.stageId ?? null,
    input.direction,
    input.counterparty,
    input.need,
    input.severity ?? 'medium',
    at,
    input.promisedAt ?? null,
  );
  const blockerId = lastId(info);

  recordEvent(db, {
    type: 'blocker_open',
    itemId: input.itemId,
    stageId: input.stageId ?? null,
    blockerId,
    occurredAt: at,
    payload: {
      blocker_id: blockerId,
      direction: input.direction,
      counterparty: input.counterparty,
      need: input.need,
      severity: input.severity ?? 'medium',
    },
  });
  return blockerId;
}

export function openBlocker(db: Db, input: OpenBlockerInput): number {
  return transaction(db, () => openBlockerInTx(db, input));
}

export function closeBlockerInTx(db: Db, blockerId: number, resolution: string, at?: string): void {
  if (!resolution.trim()) throw new Error('解除阻塞必须写原因');
  const blocker = one<BlockerRow>(db, 'SELECT * FROM blocker WHERE id = ?', blockerId);
  if (!blocker) throw new Error(`阻塞不存在: ${blockerId}`);
  if (blocker.closed_at) throw new Error(`阻塞 ${blockerId} 已经解除了`);

  const when = at ?? nowIso();
  run(db, 'UPDATE blocker SET closed_at = ?, resolution = ? WHERE id = ?', when, resolution, blockerId);

  recordEvent(db, {
    type: 'blocker_close',
    itemId: blocker.item_id,
    stageId: blocker.stage_id,
    blockerId,
    occurredAt: when,
    payload: {
      blocker_id: blockerId,
      direction: blocker.direction,
      counterparty: blocker.counterparty,
      need: blocker.need,
      resolution,
    },
  });
}

export function closeBlocker(db: Db, blockerId: number, resolution: string): void {
  transaction(db, () => closeBlockerInTx(db, blockerId, resolution));
}

export function listBlockers(db: Db, itemId: number): BlockerRow[] {
  return all<BlockerRow>(db, 'SELECT * FROM blocker WHERE item_id = ? ORDER BY opened_at DESC', itemId);
}

// ---------------------------------------------------------------------------
// 阶段流转
// ---------------------------------------------------------------------------

/**
 * 启动一个阶段。幂等：已开始过就直接返回。
 *
 * kind='wait' 的阶段在这里自动建一条 blocked_by_others 阻塞（设计文档 D6）——
 * 「等待测试报告」这种阶段本身就是阻塞场景，不该要求你手动再记一次。
 */
export function startStageInTx(db: Db, itemId: number, stage: StageRow, at?: string): void {
  if (stage.actual_start_at) return;
  const when = at ?? nowIso();

  run(db, 'UPDATE stage SET actual_start_at = ?, updated_at = ? WHERE id = ?', when, when, stage.id);
  recordEvent(db, {
    type: 'stage_enter',
    itemId,
    stageId: stage.id,
    occurredAt: when,
    payload: { stage_key: stage.key, from_stage_key: null },
  });

  if (stage.kind === 'wait') {
    openBlockerInTx(db, {
      itemId,
      stageId: stage.id,
      direction: 'blocked_by_others',
      counterparty: stage.wait_counterparty ?? '未指定',
      need: stage.wait_for ?? '等待外部',
      severity: 'medium',
      openedAt: when,
    });
  }
}

/**
 * 推进这个阶段会被什么挡住。
 *
 * 抽成独立函数是因为**预览和执行必须用同一份判断**：命令面板的预览要能提前告诉
 * 你「执行会被拒绝」，而不是等你按下回车才报错。两处各写一份迟早会不一致。
 */
export function stageAdvanceBlockers(db: Db, stageId: number): string[] {
  const reasons: string[] = [];

  const missing = missingRequiredDeliverables(db, stageId);
  if (missing.length > 0) {
    reasons.push(`${missing.length} 个必交交付物未上传（${missing.map((d) => d.name).join('、')}）`);
  }

  const openTodos = count(db, 'SELECT COUNT(*) AS n FROM todo WHERE stage_id = ? AND done = 0', stageId);
  if (openTodos > 0) reasons.push(`${openTodos} 项待办未完成`);

  return reasons;
}

export interface AdvanceStageInput {
  itemId: number;
  stageId: number;
  outcome?: StageOutcome;
  skipReason?: string;
  /** 有待办未完成 / 必交交付物未上传时，必须显式强推并说明原因 */
  forced?: boolean;
  reason?: string;
  /** 默认 true：离开阶段时把它未解除的阻塞一并解除 */
  closeBlockers?: boolean;
}

/**
 * 推进阶段 —— 这是整个系统里最重要的一个动作。
 *
 * 阶段完成**必须显式确认**（设计文档 D5）：勾完待办不等于阶段完成，
 * 所以这里不会自动推进；反过来，没勾完也允许推进，但必须写明原因。
 */
export function advanceStage(db: Db, input: AdvanceStageInput): AdvanceStageResult {
  return transaction(db, () => {
    const when = nowIso();
    const stage = one<StageRow>(
      db,
      'SELECT * FROM stage WHERE id = ? AND item_id = ?',
      input.stageId,
      input.itemId,
    );
    if (!stage) {
      throw new Error(`阶段不存在或不属于该需求（stage=${input.stageId} item=${input.itemId}）`);
    }
    if (stage.actual_end_at) throw new Error(`阶段「${stage.name}」已经结束了`);
    if (!stage.actual_start_at) throw new Error(`阶段「${stage.name}」还没开始，不能推进`);

    const outcome: StageOutcome = input.outcome ?? 'completed';
    if (outcome === 'skipped' && !input.skipReason?.trim()) {
      throw new Error('跳过阶段必须填写 skip_reason');
    }

    const bypassed = stageAdvanceBlockers(db, stage.id);

    if (bypassed.length > 0 && !input.forced) {
      throw new Error(
        `阶段「${stage.name}」还不能推进：${bypassed.join('；')}。` +
          `确认要推进请传 forced=true 并说明原因。`,
      );
    }
    if (input.forced && !input.reason?.trim()) {
      throw new Error('强制推进必须填写原因（会写进事件日志）');
    }

    // 数据卫生：离开阶段时清理它未解除的阻塞，
    // 否则那条阻塞会永远躺在「我需要支援」列表里，让驾驶舱和汇报开始骗人。
    const openBlockers = all<BlockerRow>(
      db,
      'SELECT * FROM blocker WHERE stage_id = ? AND closed_at IS NULL',
      stage.id,
    );
    const closedBlockerIds: number[] = [];
    if (openBlockers.length > 0) {
      if (input.closeBlockers === false) {
        throw new Error(
          `阶段「${stage.name}」还有 ${openBlockers.length} 条未解除的阻塞，` +
            `请先解除，或传 closeBlockers=true 让它们随阶段推进一并解除`,
        );
      }
      for (const b of openBlockers) {
        closeBlockerInTx(db, b.id, `随阶段「${stage.name}」推进一并解除`, when);
        closedBlockerIds.push(b.id);
      }
    }

    // 跳过一个从未开始的阶段时补上开始时间，
    // 否则时间线上会出现「结束了但没开始过」这种读不通的阶段。
    const startedAt = stage.actual_start_at ?? when;
    run(
      db,
      `UPDATE stage
          SET actual_start_at = ?, actual_end_at = ?, outcome = ?, skip_reason = ?,
              suspended_at = NULL, suspended_reason = NULL, updated_at = ?
        WHERE id = ?`,
      startedAt,
      when,
      outcome,
      input.skipReason ?? null,
      when,
      stage.id,
    );

    const next = one<StageRow>(
      db,
      'SELECT * FROM stage WHERE item_id = ? AND seq > ? ORDER BY seq LIMIT 1',
      input.itemId,
      stage.seq,
    );

    recordEvent(db, {
      type: 'stage_exit',
      itemId: input.itemId,
      stageId: stage.id,
      occurredAt: when,
      note: input.reason ?? null,
      payload: {
        stage_key: stage.key,
        to_stage_key: next?.key ?? null,
        outcome,
        forced: input.forced === true,
        reason: input.reason ?? null,
        bypassed,
      },
    });

    if (next) startStageInTx(db, input.itemId, next, when);

    return {
      itemId: input.itemId,
      fromStageKey: stage.key,
      fromStageName: stage.name,
      toStageKey: next?.key ?? null,
      toStageName: next?.name ?? null,
      outcome,
      forced: input.forced === true,
      closedBlockerIds,
      bypassed,
    };
  });
}

export function suspendStage(
  db: Db,
  stageId: number,
  reason: string,
): void {
  transaction(db, () => {
    const stage = getStage(db, stageId);
    if (!stage) throw new Error(`阶段不存在: ${stageId}`);
    if (stage.actual_end_at) throw new Error(`阶段「${stage.name}」已经结束了，不能再挂起`);
    if (stage.suspended_at) throw new Error(`阶段「${stage.name}」已经处于挂起状态`);
    if (!reason.trim()) throw new Error('挂起必须写原因');

    const when = nowIso();
    run(db, 'UPDATE stage SET suspended_at = ?, suspended_reason = ?, updated_at = ? WHERE id = ?', when, reason, when, stageId);
    recordEvent(db, {
      type: 'suspend',
      itemId: stage.item_id,
      stageId,
      occurredAt: when,
      payload: { scope: 'stage', stage_key: stage.key, reason },
    });
  });
}

export function resumeStage(db: Db, stageId: number): void {
  transaction(db, () => {
    const stage = getStage(db, stageId);
    if (!stage) throw new Error(`阶段不存在: ${stageId}`);
    if (!stage.suspended_at) throw new Error(`阶段「${stage.name}」本来就没有挂起`);

    const when = nowIso();
    run(db, 'UPDATE stage SET suspended_at = NULL, suspended_reason = NULL, updated_at = ? WHERE id = ?', when, stageId);
    recordEvent(db, {
      type: 'resume',
      itemId: stage.item_id,
      stageId,
      occurredAt: when,
      payload: { scope: 'stage', stage_key: stage.key },
    });
  });
}

export interface StageScheduleInput {
  plannedStart?: string | null;
  plannedEnd?: string | null;
}

/**
 * 设置阶段的计划起止 —— 这就是「各阶段 DDL」。
 *
 * 只改计划时间。阶段的实际起止由事件推导（actual_start_at / actual_end_at），
 * 不在这里碰，也不允许手填。
 */
export function setStageSchedule(db: Db, stageId: number, input: StageScheduleInput): StageRow {
  return transaction(db, () => {
    const stage = getStage(db, stageId);
    if (!stage) throw new Error(`阶段不存在: ${stageId}`);

    if (input.plannedStart != null) assertDateOnly(input.plannedStart, '阶段开始日期');
    if (input.plannedEnd != null) assertDateOnly(input.plannedEnd, '阶段截止日期');

    const nextStart = input.plannedStart === undefined ? stage.planned_start : input.plannedStart;
    const nextEnd = input.plannedEnd === undefined ? stage.planned_end : input.plannedEnd;
    if (nextStart !== null && nextEnd !== null && nextEnd < nextStart) {
      throw new Error(`阶段截止日期不能早于开始日期（${nextStart} > ${nextEnd}）`);
    }

    const when = nowIso();
    run(
      db,
      'UPDATE stage SET planned_start = ?, planned_end = ?, updated_at = ? WHERE id = ?',
      nextStart,
      nextEnd,
      when,
      stageId,
    );

    recordEvent(db, {
      type: 'ddl_change',
      itemId: stage.item_id,
      stageId,
      occurredAt: when,
      payload: {
        scope: 'stage',
        stage_key: stage.key,
        old: { start: stage.planned_start, end: stage.planned_end },
        new: { start: nextStart, end: nextEnd },
      },
    });

    return getStage(db, stageId)!;
  });
}

// ---------------------------------------------------------------------------
// 待办
// ---------------------------------------------------------------------------

export function listTodos(db: Db, itemId: number): TodoRow[] {
  return all<TodoRow>(
    db,
    `SELECT t.* FROM todo t
       LEFT JOIN stage s ON s.id = t.stage_id
      WHERE t.item_id = ?
      ORDER BY IFNULL(s.seq, 9999), t.seq, t.id`,
    itemId,
  );
}

export function addTodo(
  db: Db,
  input: { itemId: number; stageId?: number | null; text: string; dueAt?: string | null; seq?: number },
): TodoRow {
  return transaction(db, () => {
    if (!input.text.trim()) throw new Error('待办内容不能为空');
    const when = nowIso();
    const seq =
      input.seq ??
      count(db, 'SELECT IFNULL(MAX(seq), 0) + 1 AS n FROM todo WHERE stage_id IS ?', input.stageId ?? null);

    const info = run(
      db,
      `INSERT INTO todo (item_id, stage_id, text, due_at, seq, source, created_at)
       VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
      input.itemId,
      input.stageId ?? null,
      input.text,
      input.dueAt ?? null,
      seq,
      when,
    );
    const todoId = lastId(info);

    // 手工新增的待办写事件；模板生成的待办不写（它们是 item_created 的一部分，
    // 逐条写会把时间线冲成噪声）。
    recordEvent(db, {
      type: 'todo_added',
      itemId: input.itemId,
      stageId: input.stageId ?? null,
      occurredAt: when,
      payload: { todo_id: todoId, text: input.text },
    });

    return one<TodoRow>(db, 'SELECT * FROM todo WHERE id = ?', todoId)!;
  });
}

/** 勾选/取消待办。注意：勾完不等于阶段完成（D5），这里不会触发任何阶段流转。 */
export function setTodoDone(db: Db, todoId: number, done: boolean): TodoRow {
  return transaction(db, () => {
    const todo = one<TodoRow>(db, 'SELECT * FROM todo WHERE id = ?', todoId);
    if (!todo) throw new Error(`待办不存在: ${todoId}`);

    const when = nowIso();
    if (done && todo.done === 0) {
      run(db, 'UPDATE todo SET done = 1, done_at = ? WHERE id = ?', when, todoId);
      recordEvent(db, {
        type: 'todo_done',
        itemId: todo.item_id,
        stageId: todo.stage_id,
        occurredAt: when,
        payload: { todo_id: todoId, text: todo.text },
      });
    } else if (!done && todo.done === 1) {
      run(db, 'UPDATE todo SET done = 0, done_at = NULL WHERE id = ?', todoId);
      recordEvent(db, {
        type: 'todo_reopened',
        itemId: todo.item_id,
        stageId: todo.stage_id,
        occurredAt: when,
        payload: { todo_id: todoId, text: todo.text },
      });
    }
    return one<TodoRow>(db, 'SELECT * FROM todo WHERE id = ?', todoId)!;
  });
}

/**
 * 删除一条待办。
 *
 * 模板带来的待办常常有几条你根本用不上，不能让它们一直堆在那儿。
 * 删掉行，但**留一条 todo_removed 事件**把原文记下来 —— 事件日志是唯一真相源，
 * 删掉的东西在汇报和复盘里仍然看得到，这是 D1 的直接推论。
 */
export function removeTodo(db: Db, todoId: number, reason?: string): TodoRow {
  return transaction(db, () => {
    const todo = one<TodoRow>(db, 'SELECT * FROM todo WHERE id = ?', todoId);
    if (!todo) throw new Error(`待办不存在: ${todoId}`);

    const when = nowIso();
    run(db, 'DELETE FROM todo WHERE id = ?', todoId);

    recordEvent(db, {
      type: 'todo_removed',
      itemId: todo.item_id,
      stageId: todo.stage_id,
      occurredAt: when,
      note: reason ?? null,
      payload: {
        todo_id: todoId,
        text: todo.text,
        was_done: todo.done === 1,
        source: todo.source,
      },
    });

    return todo;
  });
}

/** 当前阶段的待办完成情况，供 UI 提示「可以推进了」 */
export function stageTodoProgress(
  db: Db,
  stageId: number,
): { total: number; done: number; open: number } {
  const total = count(db, 'SELECT COUNT(*) AS n FROM todo WHERE stage_id = ?', stageId);
  const done = count(db, 'SELECT COUNT(*) AS n FROM todo WHERE stage_id = ? AND done = 1', stageId);
  return { total, done, open: total - done };
}
