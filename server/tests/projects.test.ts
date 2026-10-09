import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, run } from '../src/db/index.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { listProjectTimeline } from '../src/domain/events.ts';
import { createItem, getItem, listItems } from '../src/domain/items.ts';
import { advanceStage, openBlocker } from '../src/domain/stages.ts';
import { computeDashboardPayload } from '../src/domain/dashboard.ts';
import {
  acceptHandoff,
  archiveProject,
  createProject,
  getProjectDetail,
  handoffProject,
  listProjects,
  reclaimProject,
  unarchiveProject,
  updateProject,
} from '../src/domain/projects.ts';
import { REAL_TODAY, completeStageTodos, freshDb, shift , makeItem } from './helpers.ts';

const TEMPLATES = loadPipelines();

const CARETAKING = {
  name: '模型量化看护',
  kind: 'caretaking' as const,
  watchFor: '新平台需要量化时会触发一次量化训练和编译',
  description: '算法组交付；已完成平台A、平台B 的量化。',
};

// ---------------------------------------------------------------------------

test('默认项目仍然隐式存在：不传 projectId 的需求照旧走它', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  assert.equal(item.project.is_default, 1);
  assert.equal(item.project.code, 'DEFAULT');
  assert.equal(item.project.kind, 'delivery');
  assert.equal(item.project.owner, 'me');

  // 但默认项目不出现在项目列表里（它对用户是隐形的）
  assert.deepEqual(listProjects(db), []);

  db.close();
});

test('建项目并把需求挂进去', () => {
  const db = freshDb();
  const project = createProject(db, {
    name: '2026H1 版本',
    description: '上半年的交付批次',
    dueAt: shift(REAL_TODAY, 60),
  });

  assert.equal(project.code, null, '项目编号也可以没有');
  assert.equal(project.ref, '2026H1 版本', '没编号时 ref 就是项目名');
  assert.equal(project.kind, 'delivery');
  assert.equal(project.owner, 'me');

  const item = makeItem(db, TEMPLATES, {
    title: '接口鉴权改造',
    role: 'dev',
    projectId: project.id,
  });
  assert.equal(item.project.id, project.id);

  const detail = getProjectDetail(db, project.id)!;
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0]!.code, item.item.code);

  const summary = listProjects(db)[0]!;
  assert.equal(summary.total_items, 1);
  assert.equal(summary.active_items, 1);
  assert.ok(summary.last_activity_at, '应该能算出最近活动时间');

  assert.equal(listItems(db, { projectId: project.id }).length, 1);
  assert.equal(listItems(db, { projectId: 99999 }).length, 0);

  db.close();
});

test('看护型项目必须写清看护条件', () => {
  const db = freshDb();

  assert.throws(
    () => createProject(db, { name: '模型量化看护', kind: 'caretaking' }),
    /必须写清「看护条件」/,
  );

  const project = createProject(db, CARETAKING);
  assert.equal(project.kind, 'caretaking');
  assert.equal(project.due_at, null, '看护型不该有交付日期');

  // 也不能事后清空——那是接手的人唯一必须知道的事
  assert.throws(
    () => updateProject(db, project.id, { watchFor: '' }),
    /不能清空/,
  );

  db.close();
});

test('看护型项目不进时间桶，但出现在驾驶舱的「看护中」', () => {
  const db = freshDb();
  const project = createProject(db, CARETAKING);

  // 容器本身不是 item，所以任何桶里都不该有它
  let payload = computeDashboardPayload(db, { today: REAL_TODAY });
  assert.ok(payload.sections.every((s) => s.cards.length === 0), '空项目不该出现在任何桶里');
  assert.equal(payload.caretaking.length, 1);
  assert.equal(payload.caretaking[0]!.name, CARETAKING.name);
  assert.equal(payload.caretaking[0]!.active_items, 0, '没有在途子需求是正常状态');
  assert.equal(payload.caretaking[0]!.watch_for, CARETAKING.watchFor);

  // 子需求是普通需求：真逾期了就该进逾期桶
  const item = makeItem(db, TEMPLATES, {
    title: '平台C 量化',
    role: 'dev',
    dueAt: shift(REAL_TODAY, -3),
    projectId: project.id,
  });
  payload = computeDashboardPayload(db, { today: REAL_TODAY });

  assert.deepEqual(
    payload.sections.find((s) => s.key === 'overdue')!.cards.map((c) => c.code),
    [item.item.code],
    '看护项目下的子需求照常逾期提醒 —— 这是对的，不是噪声',
  );
  assert.equal(payload.caretaking[0]!.active_items, 1);

  db.close();
});

test('有在途子需求的看护项目排在前面', () => {
  const db = freshDb();
  const idle = createProject(db, { ...CARETAKING, name: '闲置看护' });
  const busy = createProject(db, { ...CARETAKING, name: '忙碌看护' });
  makeItem(db, TEMPLATES, { title: '平台C 量化', role: 'dev', projectId: busy.id });

  const { caretaking } = computeDashboardPayload(db, { today: REAL_TODAY });
  assert.deepEqual(
    caretaking.map((p) => p.name),
    ['忙碌看护', '闲置看护'],
  );
  assert.equal(caretaking[0]!.id, busy.id);
  assert.equal(caretaking[1]!.id, idle.id);

  db.close();
});

test('交接：改负责人，并把接手方需要知道的全部上下文写进事件', () => {
  const db = freshDb();
  const project = createProject(db, CARETAKING);

  const a = makeItem(db, TEMPLATES, {
    title: '平台C 量化',
    role: 'dev',
    dueAt: shift(REAL_TODAY, 5),
    projectId: project.id,
  });
  const done = makeItem(db, TEMPLATES, { title: '平台A 量化', role: 'dev', projectId: project.id });
  // 把平台A 那条关掉：它不该出现在交接清单里
  run(db, 'UPDATE item SET closed_at = ?, close_reason = ? WHERE id = ?', '2026-01-01T00:00:00Z', 'done', done.item.id);
  openBlocker(db, {
    itemId: a.item.id,
    direction: 'blocked_by_others',
    counterparty: '算法组',
    need: '量化脚本与精度基线',
  });

  const result = handoffProject(db, {
    projectId: project.id,
    toOwner: 'SE组-张三',
    note: '回 SE 组，量化责任转出',
  });

  assert.equal(result.project.owner, 'SE组-张三');
  assert.equal(result.pending_items.length, 1, '只交代未关闭的子需求');
  assert.equal(result.pending_items[0]!.code, a.item.code);
  assert.equal(result.open_blockers, 1);

  const event = listProjectTimeline(db, project.id).at(-1)!;
  assert.equal(event.type, 'project_handoff');
  assert.equal(event.note, '回 SE 组，量化责任转出');

  const payload = JSON.parse(event.payload!) as Record<string, unknown>;
  assert.equal(payload['from_owner'], 'me');
  assert.equal(payload['to_owner'], 'SE组-张三');
  assert.equal(payload['watch_for'], CARETAKING.watchFor, '看护条件必须一起交出去');
  assert.equal((payload['pending_items'] as unknown[]).length, 1);
  assert.equal(payload['open_blockers'], 1);

  // 交出去之后按负责人过滤就看不到了，但还查得到
  assert.equal(listProjects(db, { owner: 'me' }).length, 0);
  assert.equal(listProjects(db, { owner: 'SE组-张三' }).length, 1);
  assert.ok(getProjectDetail(db, project.id));

  // 驾驶舱的看护块：交出去之后**对方还没接**，所以它仍然留着（见下一个测试）
  const pending = computeDashboardPayload(db, { today: REAL_TODAY }).caretaking;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.pending_handoff, true);

  db.close();
});

test('待接收：交出去但对方没接的这段时间，它不能从我的视图消失', () => {
  const db = freshDb();
  const project = createProject(db, CARETAKING);

  assert.equal(computeDashboardPayload(db, { today: REAL_TODAY }).caretaking.length, 1);

  handoffProject(db, { projectId: project.id, toOwner: 'SE组' });

  // 关键：交出去之后**对方还没接**，这段真空期我还在兜底，所以它仍然留在我的看护清单里
  const pending = computeDashboardPayload(db, { today: REAL_TODAY }).caretaking;
  assert.equal(pending.length, 1, '待接收期间不能从我的视图消失 —— 否则责任就蒸发了');
  assert.equal(pending[0]!.owner, 'SE组');
  assert.equal(pending[0]!.pending_handoff, true);

  // 对方确认接手，这时才真正划掉
  acceptHandoff(db, project.id);
  const after = computeDashboardPayload(db, { today: REAL_TODAY }).caretaking;
  assert.equal(after.length, 0, '确认接手后才从我的驾驶舱消失');

  // 但项目页里还在（含已交接的），能查到
  const all = listProjects(db, { kind: 'caretaking' });
  assert.equal(all.length, 1);
  assert.equal(all[0]!.pending_handoff, false);

  db.close();
});

test('接收：只能接一次；收回后回到我名下', () => {
  const db = freshDb();
  const project = createProject(db, CARETAKING);

  assert.throws(() => acceptHandoff(db, project.id), /本来就归我负责/);
  assert.throws(() => reclaimProject(db, project.id), /本来就归我负责/);

  handoffProject(db, { projectId: project.id, toOwner: 'SE组-张三' });

  const accepted = acceptHandoff(db, project.id, '已交接完成');
  assert.ok(accepted.handoff_accepted_at);
  assert.throws(() => acceptHandoff(db, project.id), /已经确认接手/);

  // 收回：没有这个动作，交出去的项目就永远回不来
  const reclaimed = reclaimProject(db, project.id, '对方没人接，先收回来');
  assert.equal(reclaimed.owner, 'me');
  assert.equal(reclaimed.handoff_accepted_at, null);
  assert.equal(
    computeDashboardPayload(db, { today: REAL_TODAY }).caretaking.length,
    1,
    '收回后重新出现在我的看护清单里',
  );
  assert.throws(() => reclaimProject(db, project.id), /本来就归我负责/);

  const types = listProjectTimeline(db, project.id).map((e) => e.type);
  assert.deepEqual(types, ['project_created', 'project_handoff', 'project_handoff_accepted', 'project_reclaim']);

  db.close();
});

test('再次交出去会清掉上一次的接收确认，重新进入待接收', () => {
  const db = freshDb();
  const project = createProject(db, CARETAKING);

  handoffProject(db, { projectId: project.id, toOwner: 'A' });
  acceptHandoff(db, project.id);
  assert.equal(listProjects(db, { kind: 'caretaking' })[0]!.pending_handoff, false);

  handoffProject(db, { projectId: project.id, toOwner: 'B' });
  const again = listProjects(db, { kind: 'caretaking' })[0]!;
  assert.equal(again.owner, 'B');
  assert.equal(again.pending_handoff, true, '换了人接手就又是一段新的真空期');

  db.close();
});

test('交接的几种错法都要报人话', () => {
  const db = freshDb();
  const project = createProject(db, CARETAKING);

  assert.throws(() => handoffProject(db, { projectId: project.id, toOwner: '  ' }), /写清交给谁/);
  assert.throws(() => handoffProject(db, { projectId: project.id, toOwner: 'me' }), /交给自己没有意义/);
  assert.throws(() => handoffProject(db, { projectId: 99999, toOwner: 'x' }), /项目不存在/);

  handoffProject(db, { projectId: project.id, toOwner: 'SE组' });
  assert.throws(
    () => handoffProject(db, { projectId: project.id, toOwner: 'SE组' }),
    /本来就归 SE组 负责/,
  );

  const def = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' }).project.id;
  assert.throws(() => handoffProject(db, { projectId: def, toOwner: 'x' }), /默认项目不能交接/);

  db.close();
});

test('归档：有未关闭子需求时拒绝，没有则成功，归档后不能再加需求', () => {
  const db = freshDb();
  const project = createProject(db, { name: '2026H1 版本' });
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev', projectId: project.id });

  assert.throws(() => archiveProject(db, project.id), /还有 1 条未关闭的子需求/);

  run(db, 'UPDATE item SET closed_at = ?, close_reason = ? WHERE id = ?', '2026-01-01T00:00:00Z', 'done', item.item.id);
  const archived = archiveProject(db, project.id);
  assert.ok(archived.archived_at);

  assert.throws(() => archiveProject(db, project.id), /已经归档/);
  assert.throws(
    () => makeItem(db, TEMPLATES, { title: '乙', role: 'dev', projectId: project.id }),
    /已归档，不能再往里加需求/,
  );

  assert.equal(listProjects(db).length, 0, '归档的默认不列出');
  assert.equal(listProjects(db, { includeArchived: true }).length, 1);

  const back = unarchiveProject(db, project.id);
  assert.equal(back.archived_at, null);
  assert.throws(() => unarchiveProject(db, project.id), /本来就没有归档/);

  db.close();
});

test('项目级事件也是 append-only：project_id 不可改', () => {
  const db = freshDb();
  const project = createProject(db, CARETAKING);
  const event = listProjectTimeline(db, project.id)[0]!;

  assert.throws(
    () => run(db, 'UPDATE event SET project_id = NULL WHERE id = ?', event.id),
    /append-only/,
  );
  assert.throws(() => run(db, 'UPDATE event SET type = ? WHERE id = ?', 'note', event.id), /append-only/);
  assert.throws(() => run(db, 'DELETE FROM event WHERE id = ?', event.id), /append-only/);

  // 作废仍然可行（只写 voided_at）
  run(db, 'UPDATE event SET voided_at = ?, void_reason = ? WHERE id = ?', '2026-01-01T00:00:00Z', '建错了', event.id);
  assert.equal(listProjectTimeline(db, project.id).length, 0, '作废后不出现在时间线');

  db.close();
});

test('项目类型只能是 delivery 或 caretaking', () => {
  const db = freshDb();
  assert.throws(
    () => createProject(db, { name: 'x', kind: '乱写' as never }),
    /项目类型只能是/,
  );
  db.close();
});

test('看护项目下的流水线照常走 —— 触发时它就是一次普通开发', () => {
  const db = freshDb();
  const project = createProject(db, CARETAKING);
  const item = makeItem(db, TEMPLATES, { title: '平台C 量化', role: 'dev', projectId: project.id });

  completeStageTodos(db, item.stages[0]!.id);
  const r = advanceStage(db, { itemId: item.item.id, stageId: item.stages[0]!.id });
  assert.equal(r.fromStageKey, 'req_reverse_walkthrough');
  assert.equal(r.toStageKey, 'coding');

  const after = getItem(db, item.item.id)!;
  assert.equal(after.project.kind, 'caretaking');
  assert.equal(after.stages[1]!.actual_start_at !== null, true);

  // 项目级时间线只装项目级事件，不混进子需求的推进
  const projectEvents = listProjectTimeline(db, project.id).map((e) => e.type);
  assert.deepEqual(projectEvents, ['project_created']);

  db.close();
});

test('项目列表可按类型和负责人过滤', () => {
  const db = freshDb();
  createProject(db, { name: '交付容器' });
  createProject(db, { ...CARETAKING, name: '看护容器' });

  assert.equal(listProjects(db).length, 2);
  assert.deepEqual(listProjects(db, { kind: 'caretaking' }).map((p) => p.name), ['看护容器']);
  assert.deepEqual(listProjects(db, { kind: 'delivery' }).map((p) => p.name), ['交付容器']);
  assert.equal(listProjects(db, { owner: 'nobody' }).length, 0);

  db.close();
});

test('统计口径：未关闭子需求数与未解除阻塞数', () => {
  const db = freshDb();
  const project = createProject(db, CARETAKING);
  const a = makeItem(db, TEMPLATES, { title: '甲', role: 'dev', projectId: project.id });
  const b = makeItem(db, TEMPLATES, { title: '乙', role: 'dev', projectId: project.id });

  openBlocker(db, { itemId: a.item.id, direction: 'blocked_by_others', counterparty: 'x', need: 'y' });
  openBlocker(db, { itemId: b.item.id, direction: 'blocking_others', counterparty: 'p', need: 'q' });
  run(db, 'UPDATE blocker SET closed_at = ?, resolution = ? WHERE id = 1', '2026-01-01T00:00:00Z', '已解除');

  const summary = listProjects(db, { kind: 'caretaking' })[0]!;
  assert.equal(summary.total_items, 2);
  assert.equal(summary.active_items, 2);
  assert.equal(summary.open_blockers, 1, '只有未解除的那条算数');

  const detail = getProjectDetail(db, project.id)!;
  assert.equal(detail.open_blockers.length, 1);
  assert.equal(all(db, 'SELECT id FROM blocker').length, 2);

  db.close();
});
