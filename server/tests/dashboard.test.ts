import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/db/index.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { computeDashboard, computeDashboardPayload, dashboardSummary } from '../src/domain/dashboard.ts';
import { daysBetween } from '../src/domain/dates.ts';
import { closeItem, createItem, suspendItem } from '../src/domain/items.ts';
import { openBlocker } from '../src/domain/stages.ts';
import { REAL_TODAY, advanceUntil, cardsOf, codeOf, codesOf, freshDb, shift , makeItem } from './helpers.ts';

const TEMPLATES = loadPipelines();
const T = { today: REAL_TODAY };

test('空库返回全部 7 个桶，且都是空的', () => {
  const db = freshDb();
  const sections = computeDashboard(db, T);

  assert.deepEqual(
    sections.map((s) => s.key),
    ['overdue', 'due_soon', 'blocked_by_others', 'blocking_others', 'stale', 'no_ddl', 'suspended'],
  );
  assert.ok(sections.every((s) => s.cards.length === 0));
  assert.ok(sections.every((s) => s.sortHint.length > 0), '每个桶都要说明自己的排序依据');
  db.close();
});

test('到期桶：逾期 / 3 日内 / 还早 / 无 DDL 各归各位', () => {
  const db = freshDb();
  const overdue = makeItem(db, TEMPLATES, { title: '逾期项', role: 'dev', dueAt: shift(REAL_TODAY, -5) });
  const soon = makeItem(db, TEMPLATES, { title: '临期项', role: 'dev', dueAt: shift(REAL_TODAY, 2) });
  const later = makeItem(db, TEMPLATES, { title: '还早', role: 'dev', dueAt: shift(REAL_TODAY, 30) });
  const none = makeItem(db, TEMPLATES, { title: '无 DDL', role: 'dev' });

  const s = computeDashboard(db, T);

  assert.deepEqual(codesOf(s, 'overdue'), [overdue.item.code]);
  assert.equal(cardsOf(s, 'overdue')[0]!.reason, '已逾期 5 天');
  assert.equal(cardsOf(s, 'overdue')[0]!.metric, 5);

  assert.deepEqual(codesOf(s, 'due_soon'), [soon.item.code]);
  assert.equal(cardsOf(s, 'due_soon')[0]!.reason, '还有 2 天到期');

  assert.equal(codesOf(s, 'overdue').includes(codeOf(later.item)), false);
  // 「无 DDL」是安全网：没有 DDL 的需求不会自己浮上来，必须单独列
  assert.deepEqual(codesOf(s, 'no_ddl'), [none.item.code]);
  assert.equal(cardsOf(s, 'no_ddl')[0]!.reason, '没有设置任何 DDL');

  db.close();
});

test('到期当天算「今天到期」，不算逾期', () => {
  const db = freshDb();
  const today = makeItem(db, TEMPLATES, { title: '今天到', role: 'dev', dueAt: REAL_TODAY });
  const s = computeDashboard(db, T);

  assert.deepEqual(codesOf(s, 'overdue'), []);
  assert.deepEqual(codesOf(s, 'due_soon'), [today.item.code]);
  assert.equal(cardsOf(s, 'due_soon')[0]!.reason, '今天到期');
  assert.equal(cardsOf(s, 'due_soon')[0]!.metric, 0);

  db.close();
});

test('阻塞两个方向分开成桶，且说清在等谁、等什么', () => {
  const db = freshDb();
  const blocked = makeItem(db, TEMPLATES, { title: '等测试报告', role: 'dev' });
  advanceUntil(db, blocked.item.id, 'wait_test_report');

  const blocking = makeItem(db, TEMPLATES, { title: '别人在等我', role: 'dev' });
  openBlocker(db, {
    itemId: blocking.item.id,
    direction: 'blocking_others',
    counterparty: '隔壁模块',
    need: '接口定义',
  });

  const s = computeDashboard(db, T);

  assert.deepEqual(codesOf(s, 'blocked_by_others'), [blocked.item.code]);
  assert.match(cardsOf(s, 'blocked_by_others')[0]!.reason, /等 测试 的「测试报告」/);

  assert.deepEqual(codesOf(s, 'blocking_others'), [blocking.item.code]);
  assert.match(cardsOf(s, 'blocking_others')[0]!.reason, /隔壁模块 在等我：接口定义/);

  // 别人在等我，不是我动不了 —— 状况仍是 normal
  assert.equal(cardsOf(s, 'blocking_others')[0]!.condition, 'normal');
  assert.equal(cardsOf(s, 'blocked_by_others')[0]!.condition, 'blocked');

  db.close();
});

test('承诺时间已过的阻塞排在前面，即使等待天数相同', () => {
  const db = freshDb();
  const late = makeItem(db, TEMPLATES, { title: '承诺过期', role: 'dev' });
  const nopromise = makeItem(db, TEMPLATES, { title: '没承诺', role: 'dev' });

  openBlocker(db, {
    itemId: late.item.id,
    direction: 'blocked_by_others',
    counterparty: '张三',
    need: '接口实现',
    promisedAt: shift(REAL_TODAY, -3),
  });
  openBlocker(db, {
    itemId: nopromise.item.id,
    direction: 'blocked_by_others',
    counterparty: '李四',
    need: '测试环境',
  });

  const cards = cardsOf(computeDashboard(db, T), 'blocked_by_others');
  assert.equal(cards[0]!.code, late.item.code, '承诺时间已过的应排在前面');
  assert.match(cards[0]!.reason, /承诺时间 .* 已过/);

  db.close();
});

test('同一需求可以同时出现在多个桶里', () => {
  const db = freshDb();
  const it = makeItem(db, TEMPLATES, { title: '又逾期又被卡', role: 'dev', dueAt: shift(REAL_TODAY, -3) });
  advanceUntil(db, it.item.id, 'wait_test_report');

  const s = computeDashboard(db, T);
  assert.ok(codesOf(s, 'overdue').includes(codeOf(it.item)), '应在逾期桶');
  assert.ok(codesOf(s, 'blocked_by_others').includes(codeOf(it.item)), '应同时在被阻塞桶');

  db.close();
});

test('挂起是「别催我」开关：退出逾期桶，但单独列出并标注挂起时已逾期多久', () => {
  const db = freshDb();
  const it = makeItem(db, TEMPLATES, { title: '挂起项', role: 'dev', dueAt: shift(REAL_TODAY, -10) });
  suspendItem(db, it.item.id, '人力被抽走');

  const s = computeDashboard(db, T);

  assert.equal(codesOf(s, 'overdue').includes(codeOf(it.item)), false, '挂起项应退出逾期桶');
  assert.deepEqual(codesOf(s, 'suspended'), [it.item.code]);

  const card = cardsOf(s, 'suspended')[0]!;
  assert.equal(card.condition, 'suspended');
  assert.match(card.reason, /已挂起 0 天：人力被抽走/);
  // 挂起不能变成藏逾期的地方
  assert.match(card.reason, /挂起时已逾期 10 天/);

  db.close();
});

test('停滞桶：按距最近一次事件的天数判定', () => {
  const db = freshDb();
  const it = makeItem(db, TEMPLATES, { title: '久未动', role: 'dev', dueAt: shift(REAL_TODAY, 60) });

  assert.deepEqual(codesOf(computeDashboard(db, T), 'stale'), [], '刚建的需求不该算停滞');

  const later = computeDashboard(db, { today: shift(REAL_TODAY, 30) });
  assert.deepEqual(codesOf(later, 'stale'), [it.item.code]);
  assert.equal(cardsOf(later, 'stale')[0]!.metric, 30);
  assert.match(cardsOf(later, 'stale')[0]!.reason, /30 天没有任何进展记录/);

  db.close();
});

test('已关闭的需求不出现在任何桶里', () => {
  const db = freshDb();
  const it = makeItem(db, TEMPLATES, { title: '关掉的', role: 'dev', dueAt: shift(REAL_TODAY, -20) });
  closeItem(db, it.item.id, { reason: 'cancelled' });

  const s = computeDashboard(db, T);
  for (const section of s) {
    assert.equal(section.cards.length, 0, `${section.key} 应为空`);
  }
  db.close();
});

test('手动置顶/置底永远覆盖自动排序', () => {
  const db = freshDb();
  const a = makeItem(db, TEMPLATES, { title: '甲', role: 'dev', dueAt: shift(REAL_TODAY, -1) });
  const b = makeItem(db, TEMPLATES, { title: '乙', role: 'dev', dueAt: shift(REAL_TODAY, -9) });

  // 默认按超期天数：逾期更久的乙在前
  assert.deepEqual(codesOf(computeDashboard(db, T), 'overdue'), [b.item.code, a.item.code]);

  run(db, 'UPDATE item SET priority_override = 1 WHERE id = ?', a.item.id);
  let cards = cardsOf(computeDashboard(db, T), 'overdue');
  assert.equal(cards[0]!.code, a.item.code, '置顶应压过自动排序');
  assert.equal(cards[0]!.pinned, 'top');

  run(db, 'UPDATE item SET priority_override = -1 WHERE id = ?', a.item.id);
  cards = cardsOf(computeDashboard(db, T), 'overdue');
  assert.equal(cards.at(-1)!.code, a.item.code, '置底应排到最后');
  assert.equal(cards.at(-1)!.pinned, 'bottom');

  db.close();
});

test('打分公式：越临近 DDL、越关键，分越高', () => {
  const db = freshDb();
  const urgent = makeItem(db, TEMPLATES, {
    title: '明天到期',
    role: 'dev',
    dueAt: shift(REAL_TODAY, 1),
    criticality: 5,
  });
  const relaxed = makeItem(db, TEMPLATES, {
    title: '下月到期',
    role: 'dev',
    dueAt: shift(REAL_TODAY, 30),
    criticality: 1,
  });

  const s = computeDashboard(db, T);
  const all = s.flatMap((x) => x.cards);

  const u = all.find((c) => c.code === urgent.item.code);
  assert.ok(u, '明天到期的应出现在临期桶');
  assert.equal(
    all.find((c) => c.code === relaxed.item.code),
    undefined,
    '下月到期的既不在到期桶，也没有阻塞/停滞/无 DDL',
  );

  // 手工验算：daysLeft=1 → urgency = 1 - 1/14 = 0.92857；criticality=5 → crit = 1
  // score = 0.40*0.92857 + 0.20*1 = 0.57143
  assert.ok(Math.abs(u.score - 0.5714) < 0.001, `分数应约为 0.5714，实际 ${u.score}`);

  db.close();
});

test('摘要数字与各桶数量一致', () => {
  const db = freshDb();
  makeItem(db, TEMPLATES, { title: '逾期', role: 'dev', dueAt: shift(REAL_TODAY, -2) });
  makeItem(db, TEMPLATES, { title: '无 DDL', role: 'dev' });

  const s = computeDashboard(db, T);
  const summary = dashboardSummary(s);
  assert.equal(summary['overdue'], 1);
  assert.equal(summary['no_ddl'], 1);
  assert.equal(summary['suspended'], 0);

  db.close();
});

// ---------------------------------------------------------------------------
// 仪表盘：焦点列表与甘特图
// ---------------------------------------------------------------------------

test('焦点列表各截前 3 条，最紧急的在最前', () => {
  const db = freshDb();
  const items = [5, 4, 3, 2].map((days, i) =>
    makeItem(db, TEMPLATES, {
      title: `逾期 ${days} 天`,
      role: 'dev',
      dueAt: shift(REAL_TODAY, -days),
      criticality: 5 - i,
    }),
  );

  const { focus } = computeDashboardPayload(db, T);
  assert.equal(focus.urgent.length, 3, '最多给 3 条');
  assert.equal(focus.urgent[0]!.code, items[0]!.item.code, '分最高的排最前');
  assert.match(focus.urgent[0]!.reason, /已逾期 5 天/);
  assert.match(focus.urgent[0]!.reason, /关键度 5/);

  db.close();
});

test('三条焦点列表各管一类：最紧要 / 别人等我 / 我等别人', () => {
  const db = freshDb();
  const urgentOnly = makeItem(db, TEMPLATES, {
    title: '只是紧急',
    role: 'dev',
    dueAt: shift(REAL_TODAY, 1),
  });
  const blocking = makeItem(db, TEMPLATES, { title: '别人等我', role: 'dev' });
  const blocked = makeItem(db, TEMPLATES, { title: '我等别人', role: 'dev' });

  openBlocker(db, {
    itemId: blocking.item.id,
    direction: 'blocking_others',
    counterparty: '网关模块',
    need: '接口定义',
  });
  openBlocker(db, {
    itemId: blocked.item.id,
    direction: 'blocked_by_others',
    counterparty: '测试组',
    need: '测试报告',
    promisedAt: shift(REAL_TODAY, -2),
  });

  const { focus } = computeDashboardPayload(db, T);

  assert.deepEqual(
    focus.blockingOthers.map((c) => c.code),
    [blocking.item.code],
    '「需要我去推动」只收别人在等我的',
  );
  assert.match(focus.blockingOthers[0]!.reason, /网关模块 在等我/);

  assert.deepEqual(
    focus.blockedByOthers.map((c) => c.code),
    [blocked.item.code],
    '「我被卡住」只收我在等别人的',
  );
  assert.match(focus.blockedByOthers[0]!.reason, /承诺已过期/);

  // 最紧要里三条都在（都是非挂起），只是排序不同
  assert.equal(focus.urgent.length, 3);
  assert.ok(focus.urgent.some((c) => c.code === urgentOnly.item.code));

  db.close();
});

test('挂起的需求不进焦点列表', () => {
  const db = freshDb();
  const it = makeItem(db, TEMPLATES, { title: '挂起的', role: 'dev', dueAt: shift(REAL_TODAY, -9) });
  suspendItem(db, it.item.id, '人力被抽走');

  const { focus } = computeDashboardPayload(db, T);
  assert.equal(focus.urgent.length, 0);
  assert.equal(focus.blockingOthers.length, 0);
  assert.equal(focus.blockedByOthers.length, 0);

  db.close();
});

test('甘特图：窗口、逾期段、阶段里程碑、无 DDL 的单独列出', () => {
  const db = freshDb();
  const soon = makeItem(db, TEMPLATES, { title: '快到期', role: 'dev', dueAt: shift(REAL_TODAY, 4) });
  const late = makeItem(db, TEMPLATES, { title: '已逾期', role: 'dev', dueAt: shift(REAL_TODAY, -6) });
  const none = makeItem(db, TEMPLATES, { title: '没 DDL', role: 'dev' });

  // 给「已逾期」的第二个阶段设一个阶段 DDL，它应该在图上成为一个里程碑
  run(
    db,
    'UPDATE stage SET planned_end = ? WHERE id = ?',
    shift(REAL_TODAY, 2),
    late.stages[1]!.id,
  );

  const { gantt } = computeDashboardPayload(db, T);
  const byCode = new Map(gantt.bars.map((b) => [b.code, b]));

  assert.equal(gantt.bars.length, 2, '没 DDL 的不该出现在时间轴上');
  assert.deepEqual(
    gantt.withoutDdl.map((w) => w.code),
    [none.item.code],
  );
  assert.equal(gantt.todayDay, daysBetween(gantt.windowStart, REAL_TODAY));

  const lateBar = byCode.get(late.item.code)!;
  assert.equal(lateBar.overdueDays, 6);
  assert.ok(lateBar.endDay < gantt.todayDay, '逾期条的终点应落在今天之前');
  assert.equal(lateBar.milestones.length, 1);
  assert.equal(lateBar.milestones[0]!.name, '开发');
  assert.equal(lateBar.milestones[0]!.plannedEnd, shift(REAL_TODAY, 2));

  const soonBar = byCode.get(soon.item.code)!;
  assert.equal(soonBar.overdueDays, 0);
  assert.ok(soonBar.endDay > gantt.todayDay);
  assert.equal(soonBar.milestones.length, 0);

  assert.equal(gantt.bars[0]!.code, late.item.code, '越早到期越靠前');
  assert.ok(gantt.totalDays > 0);
  assert.ok(gantt.ticks.length >= 2);
  assert.equal(gantt.beyondWindow, 0);

  db.close();
});

test('甘特图：挂起的排在最后，不占「先动哪个」的头几行', () => {
  const db = freshDb();
  // 挂起的那条逾期最久，按纯时间排序它本该排第一
  const suspended = makeItem(db, TEMPLATES, {
    title: '挂起的',
    role: 'dev',
    dueAt: shift(REAL_TODAY, -30),
  });
  suspendItem(db, suspended.item.id, '搁置');
  const normal = makeItem(db, TEMPLATES, {
    title: '正常的',
    role: 'dev',
    dueAt: shift(REAL_TODAY, 5),
  });

  const { gantt } = computeDashboardPayload(db, T);
  assert.equal(gantt.bars.length, 2);
  assert.equal(gantt.bars[0]!.code, normal.item.code, '未挂起的排在前面');
  assert.equal(gantt.bars[1]!.code, suspended.item.code);

  db.close();
});

test('甘特图：DDL 太远的不画出来，但会报个数', () => {
  const db = freshDb();
  makeItem(db, TEMPLATES, { title: '近的', role: 'dev', dueAt: shift(REAL_TODAY, 5) });
  makeItem(db, TEMPLATES, { title: '很远的', role: 'dev', dueAt: shift(REAL_TODAY, 200) });

  const { gantt } = computeDashboardPayload(db, T);
  assert.equal(gantt.bars.length, 1, '200 天后的那条超出窗口');
  assert.equal(gantt.beyondWindow, 1);
  assert.ok(
    daysBetween(gantt.windowStart, gantt.windowEnd) <= 90 + 45,
    '窗口永远不超过硬边界，否则一条远期 DDL 会把整张图压成一根线',
  );

  db.close();
});

test('甘特图：没有需求时返回可渲染的空图，不炸', () => {
  const db = freshDb();
  const payload = computeDashboardPayload(db, T);

  assert.equal(payload.gantt.bars.length, 0);
  assert.equal(payload.gantt.withoutDdl.length, 0);
  assert.equal(payload.gantt.beyondWindow, 0);
  assert.ok(payload.gantt.totalDays > 0, '窗口本身仍然成立');
  assert.ok(payload.gantt.ticks.length >= 2);
  assert.deepEqual(payload.focus.urgent, []);
  assert.equal(Object.keys(payload.summary).length, 7);

  db.close();
});
