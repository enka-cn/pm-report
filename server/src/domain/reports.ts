import fs from 'node:fs';
import path from 'node:path';
import type {
  BlockerRow,
  EventRow,
  ItemViewRow,
  ReportRow,
  StageRow,
} from '@manager/shared';
import { all, lastId, nowIso, one, run, transaction, type Db } from '../db/index.ts';
import { REPORT_TEMPLATES_DIR, loadSettings } from '../config.ts';
import { daysBetween, localDate, todayIso } from './dates.ts';
import { listEventsInRange } from './events.ts';
import { nextDdl } from './items.ts';
import { DIRECTION_LABELS, ROLE_LABELS } from './labels.ts';
import { renderTemplate, type TemplateContext } from './template.ts';

/**
 * 汇报草稿生成。
 *
 * 整个设计里 D1（事件日志是唯一真相源）就是为了这一刻：草稿不是让你重新回忆，
 * 而是**按区间查一遍事件**再套模板。所以这里几乎不「计算」什么，
 * 主要是把事件翻译成人话。
 */

// ---------------------------------------------------------------------------
// 数据形状（键名即模板变量名）
// ---------------------------------------------------------------------------

export interface ReportBlockerLine {
  item_code: string | null;
  item_title: string;
  /** item_code + item_title 的显示形态，没编号时就是标题 */
  item_ref: string;
  direction: string;
  direction_label: string;
  counterparty: string;
  need: string;
  severity: string;
  age_days: number;
  promised_at: string;
  promise_note: string;
}

export interface ReportRiskItem {
  code: string | null;
  /** 显示用标识，没编号时就是标题 */
  ref: string;
  title: string;
  days: number;
  next_ddl: string;
}

export interface ReportProgress {
  code: string | null;
  ref: string;
  title: string;
  role: string;
  role_label: string;
  current_stage: string;
  transitions: string[];
  deliverables: string[];
  closed_blockers: string[];
  notes: string[];
  extra: string[];
  done_todos: number;
  removed_todos: number;
}

export interface ReportPlanLine {
  code: string | null;
  ref: string;
  title: string;
  current_stage: string;
  next_stage: string;
  next_ddl: string;
}

export interface ReportAgeLine {
  code: string | null;
  ref: string;
  title: string;
  days: number;
  reason: string;
}

export interface ReportData {
  period_start: string;
  period_end: string;
  period_start_at: string;
  period_end_at: string;
  generated_at: string;
  lookahead_days: number;
  blockers: ReportBlockerLine[];
  overdue_items: ReportRiskItem[];
  upcoming_items: ReportRiskItem[];
  items_with_events: ReportProgress[];
  active_items: ReportPlanLine[];
  silent_items: ReportAgeLine[];
  suspended_items: ReportAgeLine[];
  /** 静默与挂起都为空 —— 模板里用它显示「无」，省掉嵌套的 unless */
  no_quiet_items: boolean;
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface BuildReportOptions {
  /** ISO 时刻；不传则接着上一次定稿的 period_end */
  periodStart?: string;
  periodEnd?: string;
  /** 便于测试注入「今天」 */
  today?: string;
}

/** 区间起点：上一次定稿的终点；没有历史就往前推 default_days 天 */
function resolvePeriodStart(db: Db, periodEnd: string, defaultDays: number): string {
  const last = one<{ period_end: string }>(
    db,
    'SELECT period_end FROM report WHERE finalized_at IS NOT NULL ORDER BY period_end DESC LIMIT 1',
  );
  if (last) return last.period_end;

  const d = new Date(periodEnd);
  d.setUTCDate(d.getUTCDate() - defaultDays);
  return d.toISOString();
}

function stageNameMap(stages: StageRow[]): Map<string, string> {
  return new Map(stages.map((s) => [s.key, s.name]));
}

/** 阶段描述：进行中 / 已关闭 / 卡在哪个阶段 */
function currentStageLabel(item: ItemViewRow, stages: StageRow[]): string {
  if (item.closed_at) return '已关闭';
  const active = stages.find((s) => s.id === item.active_stage_id);
  if (active) return active.name;
  const done = stages.filter((s) => s.actual_end_at !== null);
  return done.length > 0 ? `${done[done.length - 1]!.name}（已完成）` : '未开始';
}

function nextStageName(stages: StageRow[], activeStageId: number | null): string {
  const active = stages.find((s) => s.id === activeStageId);
  const seq = active?.seq ?? 0;
  const next = stages.find((s) => s.seq > seq && s.actual_end_at === null);
  return next?.name ?? '—';
}

export function buildReportData(db: Db, opts: BuildReportOptions = {}): ReportData {
  const settings = loadSettings();
  const today = opts.today ?? todayIso();
  const periodEndAt = opts.periodEnd ?? nowIso();
  const periodStartAt =
    opts.periodStart ?? resolvePeriodStart(db, periodEndAt, settings.report.default_days);

  const events = listEventsInRange(db, periodStartAt, periodEndAt);
  const items = all<ItemViewRow>(db, 'SELECT * FROM v_item');
  const stages = all<StageRow>(db, 'SELECT * FROM stage ORDER BY item_id, seq');
  const openBlockers = all<BlockerRow>(db, 'SELECT * FROM blocker WHERE closed_at IS NULL');

  const itemById = new Map(items.map((i) => [i.id, i]));
  const stagesByItem = new Map<number, StageRow[]>();
  for (const s of stages) {
    const list = stagesByItem.get(s.item_id);
    if (list) list.push(s);
    else stagesByItem.set(s.item_id, [s]);
  }

  // 挂起 = 「别催我」，不进风险段（和驾驶舱同一条规则）
  const isLive = (i: ItemViewRow) => i.closed_at === null;
  const isQuiet = (i: ItemViewRow) => i.closed_at !== null || i.condition === 'suspended';
  const stagesOf = (id: number) => stagesByItem.get(id) ?? [];

  // ---- 一、需要支援 / 风险 ----
  const blockers: ReportBlockerLine[] = openBlockers
    .filter((b) => {
      const item = itemById.get(b.item_id);
      return item !== undefined && !isQuiet(item);
    })
    .map((b) => {
      const item = itemById.get(b.item_id)!;
      const age = daysBetween(localDate(b.opened_at), today);
      const late =
        b.promised_at !== null && daysBetween(b.promised_at, today) > 0
          ? `承诺时间 ${b.promised_at} 已过`
          : b.promised_at !== null
            ? `承诺 ${b.promised_at}`
            : '';
      return {
        item_code: item.code,
        item_title: item.title,
        item_ref: item.ref,
        direction: b.direction,
        direction_label: DIRECTION_LABELS[b.direction],
        counterparty: b.counterparty,
        need: b.need,
        severity: b.severity,
        age_days: age,
        promised_at: b.promised_at ?? '',
        promise_note: late,
      };
    })
    .sort((a, b) => {
      const lateA = a.promise_note.includes('已过') ? 0 : 1;
      const lateB = b.promise_note.includes('已过') ? 0 : 1;
      return lateA - lateB || b.age_days - a.age_days;
    });

  const liveItems = items.filter(isLive);
  const quietItems = liveItems.filter((i) => i.condition !== 'suspended');

  const ddls = quietItems
    .map((i) => ({ item: i, ddl: nextDdl(i, stagesOf(i.id)) }))
    .filter((x): x is { item: ItemViewRow; ddl: string } => x.ddl !== null);

  const overdue_items: ReportRiskItem[] = ddls
    .filter((x) => daysBetween(today, x.ddl) < 0)
    .map((x) => ({
      code: x.item.code,
      ref: x.item.ref,
      title: x.item.title,
      days: -daysBetween(today, x.ddl),
      next_ddl: x.ddl,
    }))
    .sort((a, b) => b.days - a.days);

  const upcoming_items: ReportRiskItem[] = ddls
    .filter((x) => {
      const left = daysBetween(today, x.ddl);
      return left >= 0 && left <= settings.dashboard.lookahead_days;
    })
    .map((x) => ({
      code: x.item.code,
      ref: x.item.ref,
      title: x.item.title,
      days: daysBetween(today, x.ddl),
      next_ddl: x.ddl,
    }))
    .sort((a, b) => a.days - b.days);

  // ---- 二、本区间进展 ----
  const eventsByItem = new Map<number, EventRow[]>();
  for (const e of events) {
    if (e.item_id === null) continue;
    const list = eventsByItem.get(e.item_id);
    if (list) list.push(e);
    else eventsByItem.set(e.item_id, [e]);
  }

  const items_with_events: ReportProgress[] = [...eventsByItem.entries()]
    .map(([itemId, list]) => {
      const item = itemById.get(itemId);
      const itemStages = stagesOf(itemId);
      const names = stageNameMap(itemStages);

      const transitions: string[] = [];
      const deliverables: string[] = [];
      const closed_blockers: string[] = [];
      const notes: string[] = [];
      const extra: string[] = [];
      let done_todos = 0;
      let removed_todos = 0;

      for (const e of list) {
        const p = parsePayload(e);
        switch (e.type) {
          case 'item_created':
            extra.push(`新建需求（${String(p['pipeline_key'] ?? '')}）`);
            break;
          case 'stage_exit': {
            const from = names.get(String(p['stage_key'])) ?? String(p['stage_key'] ?? '?');
            const to = p['to_stage_key'] ? (names.get(String(p['to_stage_key'])) ?? String(p['to_stage_key'])) : null;
            transitions.push(`${from} → ${to ?? '收尾'}${p['forced'] ? '（强制推进）' : ''}`);
            break;
          }
          case 'deliverable_added':
            deliverables.push(`${String(p['name'] ?? '交付物')} v${String(p['version_no'] ?? 1)}`);
            break;
          case 'blocker_close':
            closed_blockers.push(
              `${String(p['counterparty'] ?? '')}：${String(p['need'] ?? '')}（${String(p['resolution'] ?? '已解除')}）`,
            );
            break;
          case 'todo_done':
            done_todos += 1;
            break;
          case 'todo_removed':
            removed_todos += 1;
            break;
          case 'note':
            if (e.note) notes.push(e.note);
            break;
          case 'item_close':
            extra.push(`关闭需求（${p['close_reason'] === 'done' ? '完成' : '取消'}）`);
            break;
          case 'item_reopen':
            extra.push('重开需求');
            break;
          case 'suspend':
            extra.push(`挂起${p['scope'] === 'stage' ? `阶段「${names.get(String(p['stage_key'])) ?? ''}」` : ''}${e.note ? `：${e.note}` : ''}`);
            break;
          case 'resume':
            extra.push(`恢复${p['scope'] === 'stage' ? `阶段「${names.get(String(p['stage_key'])) ?? ''}」` : ''}`);
            break;
          case 'ddl_change':
            extra.push(p['scope'] === 'stage' ? `调整阶段「${names.get(String(p['stage_key'])) ?? ''}」DDL` : '调整整体 DDL');
            break;
          case 'role_change':
            extra.push(`角色 ${String(p['old_role'] ?? '')} → ${String(p['new_role'] ?? '')}`);
            break;
          default:
            break;
        }
      }

      return {
        code: item?.code ?? null,
        ref: item?.ref ?? '（已删除的需求）',
        title: item?.title ?? '（已不存在）',
        role: item?.role ?? '',
        role_label: item ? ROLE_LABELS[item.role] : '',
        current_stage: item ? currentStageLabel(item, itemStages) : '—',
        transitions,
        deliverables,
        closed_blockers,
        notes,
        extra,
        done_todos,
        removed_todos,
      };
    })
    // 事件全部落在「没有渲染分支」的类型上时，会得到一条有标题没内容的条目。
    // 宁可整条不出现，也不要汇报里冒出空壳 —— 那是给主管看的东西。
    // 同时这也是唯一兜底：以后加了新事件类型却忘了在这里加分支，不会渲染出空标题。
    .filter(
      (p) =>
        p.transitions.length > 0 ||
        p.deliverables.length > 0 ||
        p.closed_blockers.length > 0 ||
        p.notes.length > 0 ||
        p.extra.length > 0 ||
        p.done_todos > 0 ||
        p.removed_todos > 0,
    )
    // 按显示标识排 —— 没编号的排它自己的标题，而不是排到一个空的 code 上
    .sort((a, b) => a.ref.localeCompare(b.ref, 'zh'));

  // ---- 三、下区间计划 ----
  const active_items: ReportPlanLine[] = quietItems
    .map((item) => {
      const itemStages = stagesOf(item.id);
      return {
        item,
        stages: itemStages,
        ddl: nextDdl(item, itemStages),
      };
    })
    .sort((a, b) => {
      if (a.ddl === null) return b.ddl === null ? a.item.ref.localeCompare(b.item.ref, 'zh') : 1;
      if (b.ddl === null) return -1;
      return a.ddl.localeCompare(b.ddl);
    })
    .map(({ item, stages: itemStages, ddl }) => ({
      code: item.code,
      ref: item.ref,
      title: item.title,
      current_stage: currentStageLabel(item, itemStages),
      next_stage: nextStageName(itemStages, item.active_stage_id),
      next_ddl: ddl ?? '未设',
    }));

  // ---- 四、静默与挂起 ----
  const silent_items: ReportAgeLine[] = quietItems
    .filter((i) => !eventsByItem.has(i.id))
    .map((item) => {
      const last = one<{ last: string | null }>(
        db,
        'SELECT MAX(occurred_at) AS last FROM event WHERE item_id = ? AND voided_at IS NULL',
        item.id,
      );
      const days = last?.last ? daysBetween(localDate(last.last), today) : 0;
      // 区间只有几秒时 days 会是 0，写成「0 天无更新」很傻。
      // 语义其实统一：这个区间里它一条进展都没有。
      return {
        code: item.code,
        ref: item.ref,
        title: item.title,
        days,
        reason: days >= 1 ? `${days} 天无更新` : '本区间无进展',
      };
    })
    .sort((a, b) => b.days - a.days);

  const suspended_items: ReportAgeLine[] = liveItems
    .filter((i) => i.condition === 'suspended')
    .map((item) => {
      const itemStages = stagesOf(item.id);
      const active = itemStages.find((s) => s.id === item.active_stage_id);
      const since = item.suspended_at ?? active?.suspended_at;
      const days = since ? daysBetween(localDate(since), today) : 0;
      const why = item.suspended_reason ?? active?.suspended_reason ?? '';
      return { code: item.code, ref: item.ref, title: item.title, days, reason: why };
    })
    .sort((a, b) => b.days - a.days);

  return {
    period_start: localDate(periodStartAt),
    period_end: localDate(periodEndAt),
    period_start_at: periodStartAt,
    period_end_at: periodEndAt,
    generated_at: periodEndAt,
    lookahead_days: settings.dashboard.lookahead_days,
    blockers,
    overdue_items,
    upcoming_items,
    items_with_events,
    active_items,
    silent_items,
    suspended_items,
    no_quiet_items: silent_items.length === 0 && suspended_items.length === 0,
  };
}

function parsePayload(event: EventRow): Record<string, unknown> {
  if (!event.payload) return {};
  try {
    const parsed: unknown = JSON.parse(event.payload);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

export function listReportTemplates(): string[] {
  if (!fs.existsSync(REPORT_TEMPLATES_DIR)) return [];
  return fs
    .readdirSync(REPORT_TEMPLATES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function loadReportTemplate(key = 'default'): { key: string; source: string } {
  const file = path.join(REPORT_TEMPLATES_DIR, `${key}.md`);
  if (!fs.existsSync(file)) {
    const available = listReportTemplates();
    throw new Error(
      `汇报模板不存在: ${file}${available.length > 0 ? `。目录里现有：${available.join('、')}` : ''}`,
    );
  }
  return { key, source: fs.readFileSync(file, 'utf8') };
}

// ---------------------------------------------------------------------------
// 汇报记录
// ---------------------------------------------------------------------------

export interface GenerateReportOptions extends BuildReportOptions {
  templateKey?: string;
}

export function generateReport(db: Db, opts: GenerateReportOptions = {}): ReportRow {
  const template = loadReportTemplate(opts.templateKey ?? 'default');
  const data = buildReportData(db, opts);
  const markdown = renderTemplate(template.source, data as unknown as TemplateContext, `${template.key}.md`);
  const when = nowIso();

  return transaction(db, () => {
    const info = run(
      db,
      `INSERT INTO report
         (title, period_start, period_end, generated_md, content_md, template_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      `汇报（${data.period_start} ~ ${data.period_end}）`,
      data.period_start_at,
      data.period_end_at,
      markdown,
      markdown,
      template.key,
      when,
      when,
    );
    return one<ReportRow>(db, 'SELECT * FROM report WHERE id = ?', lastId(info))!;
  });
}

export function getReport(db: Db, id: number): ReportRow | undefined {
  return one<ReportRow>(db, 'SELECT * FROM report WHERE id = ?', id);
}

export function listReports(db: Db, limit = 50): ReportRow[] {
  return all<ReportRow>(
    db,
    // 未定稿的草稿排在前面 —— 那是还没处理完的事。
    // 写成 (finalized_at IS NOT NULL)：草稿得 0 排前，定稿得 1 排后。
    `SELECT * FROM report ORDER BY (finalized_at IS NOT NULL), period_end DESC LIMIT ?`,
    limit,
  );
}

export function updateReport(
  db: Db,
  id: number,
  patch: { contentMd?: string; title?: string },
): ReportRow {
  return transaction(db, () => {
    const report = getReport(db, id);
    if (!report) throw new Error(`汇报不存在: ${id}`);
    if (report.finalized_at) throw new Error('已定稿的汇报不能再改；先「取消定稿」再编辑');

    run(
      db,
      'UPDATE report SET content_md = ?, title = ?, updated_at = ? WHERE id = ?',
      patch.contentMd ?? report.content_md,
      patch.title ?? report.title,
      nowIso(),
      id,
    );
    return getReport(db, id)!;
  });
}

/**
 * 定稿。它的 period_end 从此成为下一次生成的区间起点 ——
 * 这就是「两次汇报之间发生了什么」能自动成立的原因。
 */
export function finalizeReport(db: Db, id: number): ReportRow {
  return transaction(db, () => {
    const report = getReport(db, id);
    if (!report) throw new Error(`汇报不存在: ${id}`);
    if (report.finalized_at) throw new Error('这条汇报已经定稿了');

    const when = nowIso();
    run(db, 'UPDATE report SET finalized_at = ?, updated_at = ? WHERE id = ?', when, when, id);
    return getReport(db, id)!;
  });
}

export function unfinalizeReport(db: Db, id: number): ReportRow {
  return transaction(db, () => {
    const report = getReport(db, id);
    if (!report) throw new Error(`汇报不存在: ${id}`);
    if (!report.finalized_at) throw new Error('这条汇报本来就没定稿');

    run(db, 'UPDATE report SET finalized_at = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
    return getReport(db, id)!;
  });
}

/** 只允许删未定稿的草稿；定稿是历史记录，不能删 */
export function deleteReport(db: Db, id: number): void {
  transaction(db, () => {
    const report = getReport(db, id);
    if (!report) throw new Error(`汇报不存在: ${id}`);
    if (report.finalized_at) throw new Error('已定稿的汇报不能删除（它是下次区间的起点）');
    run(db, 'DELETE FROM report WHERE id = ?', id);
  });
}
