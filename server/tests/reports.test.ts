import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { listTimeline } from '../src/domain/events.ts';
import { createItem, noteItem, suspendItem } from '../src/domain/items.ts';
import { advanceStage, openBlocker } from '../src/domain/stages.ts';
import { removeTodo } from '../src/domain/stages.ts';
import {
  buildReportData,
  deleteReport,
  finalizeReport,
  generateReport,
  getReport,
  listReportTemplates,
  listReports,
  loadReportTemplate,
  unfinalizeReport,
  updateReport,
} from '../src/domain/reports.ts';
import { REAL_TODAY, completeStageTodos, freshDb, shift } from './helpers.ts';

const TEMPLATES = loadPipelines();

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString();

// 「明确晚于现在」：ISO 时间戳只到毫秒，同一毫秒内做完的动作会被
// 左闭右开区间 [start, end) 漏掉（>= start 收得进，< end 收不进）。测试里不能碰运气。
const justAfterNow = () => new Date(Date.now() + 2000).toISOString();

/** 造一个「有推进、有阻塞、有备注」的需求，用来喂汇报 */
function scenario(db: ReturnType<typeof freshDb>) {
  const item = createItem(db, TEMPLATES, {
    title: '接口鉴权改造',
    role: 'dev',
    criticality: 5,
    dueAt: shift(REAL_TODAY, -5),
  });
  completeStageTodos(db, item.stages[0]!.id);
  advanceStage(db, { itemId: item.item.id, stageId: item.stages[0]!.id });
  noteItem(db, item.item.id, '与架构师对齐了鉴权协议');
  openBlocker(db, {
    itemId: item.item.id,
    direction: 'blocked_by_others',
    counterparty: '测试组',
    need: '测试报告',
    promisedAt: shift(REAL_TODAY, -1),
  });
  return item;
}

// ---------------------------------------------------------------------------

test('汇报数据：区间内的推进、阻塞、逾期都归到正确的段', () => {
  const db = freshDb();
  const item = scenario(db);

  const data = buildReportData(db, { periodStart: ago(1), periodEnd: justAfterNow(), today: REAL_TODAY });

  assert.equal(data.blockers.length, 1);
  const blocker = data.blockers[0]!;
  assert.equal(blocker.item_code, item.item.code);
  assert.equal(blocker.counterparty, '测试组');
  assert.equal(blocker.direction_label, '我被阻塞');
  assert.match(blocker.promise_note, /已过/, '承诺时间过了要说出来');

  assert.equal(data.overdue_items.length, 1);
  assert.equal(data.overdue_items[0]!.days, 5);

  assert.equal(data.items_with_events.length, 1);
  const progress = data.items_with_events[0]!;
  assert.deepEqual(progress.transitions, ['需求反串讲 → 开发']);
  assert.deepEqual(progress.notes, ['与架构师对齐了鉴权协议']);
  assert.equal(progress.done_todos, 2);
  assert.match(progress.current_stage, /开发/);

  assert.equal(data.active_items.length, 1);
  assert.equal(data.active_items[0]!.next_stage, 'DT');
  assert.equal(data.active_items[0]!.next_ddl, shift(REAL_TODAY, -5));

  db.close();
});

test('汇报数据：区间内零事件的需求进「静默」，不混进进展段', () => {
  const db = freshDb();
  const item = scenario(db);

  // 区间从「现在之后」开始，之前的动作都不算。
  // 这里必须真的往后挪一点：ISO 时间戳只到毫秒，同一毫秒内做完的动作
  // 会被 `occurred_at >= period_start` 收进来。
  const justAfter = new Date(Date.now() + 1000).toISOString();
  const data = buildReportData(db, { periodStart: justAfter, periodEnd: ahead(1), today: REAL_TODAY });

  assert.equal(data.items_with_events.length, 0);
  assert.equal(data.silent_items.length, 1);
  assert.equal(data.silent_items[0]!.code, item.item.code);
  assert.equal(data.silent_items[0]!.reason, '本区间无进展', '区间只有几秒时不该写「0 天无更新」');
  assert.equal(data.no_quiet_items, false);

  db.close();
});

test('静默项超过一天时给出天数', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, { title: '久未动', role: 'dev' });

  // 区间从需求创建之后开始，而「今天」推到 9 天之后
  const justAfter = new Date(Date.now() + 1000).toISOString();
  const data = buildReportData(db, {
    periodStart: justAfter,
    periodEnd: ahead(1),
    today: shift(REAL_TODAY, 9),
  });

  assert.equal(data.silent_items[0]!.code, item.item.code);
  assert.match(data.silent_items[0]!.reason, /天无更新$/);

  db.close();
});

test('汇报数据：挂起的需求不进风险段，单独列在第四节', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, {
    title: '日志采集优化',
    role: 'se',
    dueAt: shift(REAL_TODAY, -8),
  });
  openBlocker(db, {
    itemId: item.item.id,
    direction: 'blocked_by_others',
    counterparty: '平台组',
    need: '采集权限',
  });
  suspendItem(db, item.item.id, '人力被抽调');

  const data = buildReportData(db, { periodStart: ago(1), periodEnd: justAfterNow(), today: REAL_TODAY });

  assert.equal(data.blockers.length, 0, '挂起的东西不该出现在「需要支援」里');
  assert.equal(data.overdue_items.length, 0, '挂起的不算逾期压力');
  assert.equal(data.active_items.length, 0);
  assert.equal(data.suspended_items.length, 1);
  assert.equal(data.suspended_items[0]!.reason, '人力被抽调');

  db.close();
});

test('「我阻塞别人」也进风险段，方向标签正确', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, { title: '计费重构', role: 'dev' });
  openBlocker(db, {
    itemId: item.item.id,
    direction: 'blocking_others',
    counterparty: '网关模块',
    need: '接口定义冻结',
  });

  const data = buildReportData(db, { periodStart: ago(1), periodEnd: justAfterNow(), today: REAL_TODAY });
  assert.equal(data.blockers.length, 1);
  assert.equal(data.blockers[0]!.direction_label, '我阻塞别人');

  db.close();
});

test('删除的待办会出现在进展里（删了什么都得说清楚）', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  removeTodo(db, item.todos[0]!.id);

  const data = buildReportData(db, { periodStart: ago(1), periodEnd: justAfterNow(), today: REAL_TODAY });
  const progress = data.items_with_events.find((p) => p.code === item.item.code)!;
  assert.equal(progress.removed_todos, 1);
  assert.ok(progress.extra.some((x) => x.includes('新建需求')));

  db.close();
});

test('生成草稿：渲染出完整 Markdown，不残留模板标签', () => {
  const db = freshDb();
  const item = scenario(db);

  const report = generateReport(db, { periodStart: ago(1), periodEnd: justAfterNow() });

  assert.match(report.title, /^汇报（\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}）$/);
  assert.equal(report.finalized_at, null, '刚生成的是草稿');
  assert.equal(report.template_key, 'default');
  assert.equal(report.generated_md, report.content_md, '初稿原样存一份，便于对比你改了什么');

  const md = report.content_md!;
  assert.match(md, /^# 汇报（/);
  assert.match(md, /测试组/);
  assert.match(md, /阶段推进：需求反串讲 → 开发/);
  assert.match(md, /与架构师对齐了鉴权协议/);
  assert.match(md, new RegExp(`\\| ${item.item.code} \\|`), '下区间计划表里应有这条需求');
  assert.doesNotMatch(md, /\{\{|\}\}/, '渲染完不能残留模板标签');

  db.close();
});

test('区间自动衔接：定稿后下一次从它的终点开始', () => {
  const db = freshDb();
  scenario(db);

  const start = ago(30);
  const end = ago(10);
  const first = generateReport(db, { periodStart: start, periodEnd: end });
  assert.equal(first.period_start, start);
  assert.equal(first.period_end, end);

  // 没定稿时，下一次仍按「默认 7 天前」算，不会接上这条草稿
  const beforeFinalize = generateReport(db);
  assert.notEqual(beforeFinalize.period_start, first.period_end);

  finalizeReport(db, first.id);

  const second = generateReport(db);
  assert.equal(second.period_start, first.period_end, '下一次的起点应接上一次定稿的终点');
  assert.ok(second.period_start < second.period_end, '区间必须是正的');

  db.close();
});

test('定稿 / 取消定稿 / 删除的规则', () => {
  const db = freshDb();
  const report = generateReport(db, { periodStart: ago(2), periodEnd: ago(1) });

  assert.equal(report.finalized_at, null);

  const finalized = finalizeReport(db, report.id);
  assert.ok(finalized.finalized_at);

  assert.throws(() => finalizeReport(db, report.id), /已经定稿/);
  assert.throws(() => deleteReport(db, report.id), /已定稿的汇报不能删除/);
  assert.throws(() => updateReport(db, report.id, { contentMd: '改一下' }), /先「取消定稿」/);

  const reopened = unfinalizeReport(db, report.id);
  assert.equal(reopened.finalized_at, null);
  assert.throws(() => unfinalizeReport(db, report.id), /本来就没定稿/);

  const edited = updateReport(db, report.id, { contentMd: '# 我手改过的稿子' });
  assert.equal(edited.content_md, '# 我手改过的稿子');
  assert.notEqual(edited.generated_md, edited.content_md, '机器初稿应保留原样');

  deleteReport(db, report.id);
  assert.equal(getReport(db, report.id), undefined);

  db.close();
});

test('列表：草稿排在定稿前面，且带上可用模板名', () => {
  const db = freshDb();
  const a = generateReport(db, { periodStart: ago(9), periodEnd: ago(8) });
  finalizeReport(db, a.id);
  const b = generateReport(db, { periodStart: ago(2), periodEnd: ago(1) });

  const reports = listReports(db);
  assert.equal(reports[0]!.id, b.id, '未定稿的草稿排前面，提醒你处理');
  assert.equal(reports[1]!.id, a.id);

  assert.ok(listReportTemplates().includes('default'));

  db.close();
});

test('模板缺失或写错时报清楚的错', () => {
  const db = freshDb();

  assert.throws(() => loadReportTemplate('不存在的模板'), /汇报模板不存在/);
  assert.throws(
    () => generateReport(db, { templateKey: '不存在的模板' }),
    /汇报模板不存在/,
  );

  assert.match(loadReportTemplate('default').source, /\{\{period_start\}\}/);

  db.close();
});

test('汇报不会改动任何业务数据（只读事件，不写事件）', () => {
  const db = freshDb();
  const item = scenario(db);
  const before = listTimeline(db, item.item.id, { includeVoided: true }).length;

  generateReport(db, { periodStart: ago(1), periodEnd: justAfterNow() });
  generateReport(db, { periodStart: ago(1), periodEnd: justAfterNow() });

  const after = listTimeline(db, item.item.id, { includeVoided: true }).length;
  assert.equal(after, before, '生成汇报不应往时间线里写东西');

  db.close();
});
