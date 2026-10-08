import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nowIso, openDb, run } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { listTimeline, voidEvent } from '../src/domain/events.ts';
import {
  closeItem,
  createItem,
  getItem,
  listItems,
  nextDdl,
  reopenItem,
  resumeItem,
  suspendItem,
} from '../src/domain/items.ts';
import { advanceStage, closeBlocker, listTodos, removeTodo, setTodoDone } from '../src/domain/stages.ts';
import { advanceUntil, completeStageTodos, freshDb } from './helpers.ts';

const TEMPLATES = loadPipelines();

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------

test('迁移：可重复执行；改动已应用的迁移会报错而不是默默跑过去', () => {
  const dir = tempDir('manager-mig-');
  const db = openDb(path.join(dir, 'm.db'));

  fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  assert.equal(migrate(db, dir).length, 1);
  assert.equal(migrate(db, dir).length, 0, '重复执行不应再次应用');

  fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT);');
  assert.throws(() => migrate(db, dir), /checksum 不匹配/);

  db.close();
});

test('建需求：按角色实例化流水线与待办，首阶段自动开始', () => {
  const db = freshDb();
  const detail = createItem(db, TEMPLATES, { title: '接口改造', role: 'dev' });

  assert.match(detail.item.code, /^REQ-\d+$/);
  assert.equal(detail.item.condition, 'normal');
  assert.equal(detail.item.criticality, 3, '未指定关键度时取 settings 默认值');

  assert.deepEqual(
    detail.stages.map((s) => s.key),
    ['req_reverse_walkthrough', 'coding', 'dt', 'submit_test', 'wait_test_report', 'dts_fix', 'merge'],
  );
  assert.equal(detail.todos.length, 15);

  const first = detail.stages[0]!;
  assert.ok(first.actual_start_at, '首阶段应已开始');
  assert.equal(first.actual_end_at, null);
  assert.equal(detail.item.active_stage_id, first.id);

  // 模板生成的待办不写事件，否则时间线会被冲成噪声
  assert.deepEqual(
    listTimeline(db, detail.item.id).map((e) => e.type),
    ['item_created', 'stage_enter'],
  );

  db.close();
});

test('SE 角色走另一套流水线', () => {
  const db = freshDb();
  const detail = createItem(db, TEMPLATES, { title: '架构设计', role: 'se' });
  assert.deepEqual(
    detail.stages.map((s) => s.key),
    ['arch_design', 'seg_review', 'tmg_review', 'req_walkthrough', 'dev_tracking', 'close'],
  );
  db.close();
});

test('阶段推进必须显式确认：待办没勾完拒绝，强推必须写原因，跳过硬性要求原因', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'x', role: 'dev' });
  const s1 = d.stages[0]!;
  const itemId = d.item.id;

  assert.throws(() => advanceStage(db, { itemId, stageId: s1.id }), /还不能推进/);
  assert.throws(
    () => advanceStage(db, { itemId, stageId: s1.id, forced: true }),
    /必须填写原因/,
  );
  assert.throws(
    () => advanceStage(db, { itemId, stageId: s1.id, outcome: 'skipped', forced: true, reason: '不做了' }),
    /跳过阶段必须填写 skip_reason/,
  );

  // 没有任何副作用：阶段仍在进行中
  assert.equal(getItem(db, itemId)!.item.active_stage_id, s1.id);

  completeStageTodos(db, s1.id);
  const r = advanceStage(db, { itemId, stageId: s1.id });
  assert.equal(r.fromStageKey, 'req_reverse_walkthrough');
  assert.equal(r.toStageKey, 'coding');
  assert.equal(r.forced, false);
  assert.deepEqual(r.bypassed, []);

  const after = getItem(db, itemId)!;
  assert.equal(after.stages[0]!.outcome, 'completed');
  assert.ok(after.stages[0]!.actual_end_at);
  assert.ok(after.stages[1]!.actual_start_at);
  assert.equal(after.item.active_stage_id, after.stages[1]!.id);

  // 已结束的阶段不能再推进
  assert.throws(() => advanceStage(db, { itemId, stageId: s1.id }), /已经结束/);

  db.close();
});

test('强推会记录被越过的事项，便于事后追溯', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'x', role: 'dev' });
  const s1 = d.stages[0]!;

  const r = advanceStage(db, { itemId: d.item.id, stageId: s1.id, forced: true, reason: '急上线，先跳过' });
  assert.equal(r.forced, true);
  assert.equal(r.bypassed.length, 1);
  assert.match(r.bypassed[0]!, /2 项待办未完成/);

  const exit = listTimeline(db, d.item.id).find((e) => e.type === 'stage_exit')!;
  const payload = JSON.parse(exit.payload!);
  assert.equal(payload.forced, true);
  assert.equal(payload.reason, '急上线，先跳过');

  db.close();
});

test('状况由事实投影：normal → blocked → suspended → closed', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'y', role: 'dev' });
  const itemId = d.item.id;

  assert.equal(getItem(db, itemId)!.item.condition, 'normal');

  // 推进到「等待测试报告」（kind=wait）
  advanceUntil(db, itemId, 'wait_test_report');

  const atWait = getItem(db, itemId)!;
  assert.equal(atWait.item.condition, 'blocked', 'kind=wait 阶段进入时应自动建阻塞');

  const open = atWait.blockers.filter((b) => b.closed_at === null);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.direction, 'blocked_by_others');
  assert.equal(open[0]!.counterparty, '测试');
  assert.equal(open[0]!.need, '测试报告');

  // 挂起优先于阻塞，且不需要「谁覆盖谁」的规则：两个事实都成立，取更强的那个
  suspendItem(db, itemId, '人力被抽走');
  assert.equal(getItem(db, itemId)!.item.condition, 'suspended');

  resumeItem(db, itemId);
  assert.equal(getItem(db, itemId)!.item.condition, 'blocked');

  closeBlocker(db, open[0]!.id, '报告已收到');
  assert.equal(getItem(db, itemId)!.item.condition, 'normal');

  closeItem(db, itemId, { reason: 'cancelled' });
  assert.equal(getItem(db, itemId)!.item.condition, 'closed');

  reopenItem(db, itemId);
  assert.equal(getItem(db, itemId)!.item.condition, 'normal');

  db.close();
});

test('「我阻塞别人」不算我被阻塞', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'z', role: 'dev' });
  const itemId = d.item.id;

  db.prepare(
    `INSERT INTO blocker (item_id, direction, counterparty, need, opened_at)
     VALUES (?, 'blocking_others', '隔壁模块', '等我的接口定义', ?)`,
  ).run(itemId, nowIso());

  // blocker 表里有一条未解除的记录，但方向是「我阻塞别人」，
  // 所以需求状况仍是 normal —— 这一点弄错会让驾驶舱把「别人等我」显示成「我动不了」。
  assert.equal(getItem(db, itemId)!.item.condition, 'normal');

  db.close();
});

test('数据库强制「同一需求最多一个进行中阶段」', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'w', role: 'dev' });
  const when = nowIso();

  assert.throws(
    () =>
      run(
        db,
        `INSERT INTO stage (item_id, seq, key, name, kind, actual_start_at, created_at, updated_at)
         VALUES (?, 99, 'dup', '重复阶段', 'work', ?, ?, ?)`,
        d.item.id,
        when,
        when,
        when,
      ),
    /UNIQUE/,
  );

  db.close();
});

test('事件表 append-only：改与删被数据库拒绝，作废可行', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'v', role: 'se' });
  const ev = listTimeline(db, d.item.id)[0]!;

  assert.throws(() => run(db, 'UPDATE event SET type = ? WHERE id = ?', 'note', ev.id), /append-only/);
  assert.throws(() => run(db, 'DELETE FROM event WHERE id = ?', ev.id), /append-only/);

  voidEvent(db, ev.id, '记错了');
  const withVoided = listTimeline(db, d.item.id, { includeVoided: true });
  assert.ok(withVoided.find((e) => e.id === ev.id)!.voided_at);
  assert.equal(
    listTimeline(db, d.item.id).some((e) => e.id === ev.id),
    false,
    '作废后默认不出现在时间线',
  );

  db.close();
});

test('下一个 DDL = min(未结束阶段的 planned_end, 需求整体 due_at)', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'u', role: 'dev', dueAt: '2026-12-31' });
  const second = d.stages[1]!;

  run(db, 'UPDATE stage SET planned_end = ? WHERE id = ?', '2026-03-01', second.id);
  let detail = getItem(db, d.item.id)!;
  assert.equal(nextDdl(detail.item, detail.stages), '2026-03-01');

  // 该阶段结束后就不再构成压力
  run(
    db,
    `UPDATE stage SET actual_start_at = ?, actual_end_at = ?, outcome = 'completed' WHERE id = ?`,
    nowIso(),
    nowIso(),
    second.id,
  );
  detail = getItem(db, d.item.id)!;
  assert.equal(nextDdl(detail.item, detail.stages), '2026-12-31');

  db.close();
});

test('列表默认不含已关闭需求', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const b = createItem(db, TEMPLATES, { title: '乙', role: 'se' });

  assert.equal(listItems(db).length, 2);
  closeItem(db, b.item.id, { reason: 'cancelled' });
  assert.equal(listItems(db).length, 1);
  assert.equal(listItems(db, { includeClosed: true }).length, 2);
  assert.equal(listItems(db, { condition: 'closed' })[0]!.id, b.item.id);
  assert.equal(listItems(db, { q: '甲' })[0]!.id, a.item.id);

  db.close();
});

test('待办可删：行不留，但事件日志里留下原文', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const s1 = d.stages[0]!;
  const todo = d.todos.find((t) => t.stage_id === s1.id && t.source === 'template')!;

  assert.equal(removeTodo(db, todo.id).text, todo.text);

  assert.equal(
    listTodos(db, d.item.id).some((t) => t.id === todo.id),
    false,
    '行应该真的没了',
  );

  // 但事件日志是唯一真相源：删掉的东西在复盘里仍然看得到
  const removed = listTimeline(db, d.item.id).find((e) => e.type === 'todo_removed')!;
  assert.ok(removed, '应该留下一条 todo_removed 事件');
  const payload = JSON.parse(removed.payload!) as { text: string; source: string; was_done: boolean };
  assert.equal(payload.text, todo.text);
  assert.equal(payload.source, 'template');
  assert.equal(payload.was_done, false);

  // 删两次要报人话
  assert.throws(() => removeTodo(db, todo.id), /待办不存在/);

  db.close();
});

test('删除已完成的待办也不会影响汇报口径（汇报读的是事件）', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const s1 = d.stages[0]!;
  const todo = d.todos.find((t) => t.stage_id === s1.id)!;

  setTodoDone(db, todo.id, true);
  removeTodo(db, todo.id);

  const types = listTimeline(db, d.item.id).map((e) => e.type);
  assert.deepEqual(types.slice(-2), ['todo_done', 'todo_removed']);

  const removed = listTimeline(db, d.item.id).at(-1)!;
  assert.equal((JSON.parse(removed.payload!) as { was_done: boolean }).was_done, true);

  db.close();
});
