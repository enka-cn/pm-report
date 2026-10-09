import type {
  BlockerRow,
  DashboardBucketKey,
  DashboardCard,
  DashboardFocus,
  DashboardPayload,
  DashboardSection,
  GanttBar,
  GanttChart,
  GanttMilestone,
  ItemViewRow,
  ProjectSummary,
  StageRow,
} from '@manager/shared';
import { all, type Db } from '../db/index.ts';
import { loadSettings, type Settings } from '../config.ts';
import { nextDdl } from './items.ts';
import { listProjects, CURRENT_OWNER } from './projects.ts';
import { daysBetween, localDate, shiftDays, todayIso } from './dates.ts';

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ---------------------------------------------------------------------------
// 桶定义
//
// 「先分桶，再打分」：分桶才是主要价值，分数只决定桶内顺序（设计文档 §6）。
// 各桶独立判定，同一个需求可以同时出现在多个桶里 —— 一个逾期且被阻塞的需求
// 理应两处都看得到，塞进单一枚举只会逼你二选一。
//
// metricDir / metric 决定桶内主排序，score 只在主排序并列时起作用。
// ---------------------------------------------------------------------------

interface BucketDef {
  key: DashboardBucketKey;
  title: string;
  sortHint: string;
  metricDir: 'asc' | 'desc';
}

const BUCKETS: readonly BucketDef[] = [
  { key: 'overdue', title: '逾期', sortHint: '超期越久越靠前', metricDir: 'desc' },
  { key: 'due_soon', title: '3 日内到期', sortHint: '越接近到期越靠前', metricDir: 'asc' },
  {
    key: 'blocked_by_others',
    title: '我被阻塞（等别人）',
    sortHint: '承诺时间已过的排在前面，再按等待天数',
    metricDir: 'desc',
  },
  {
    key: 'blocking_others',
    title: '我阻塞别人（需我推动）',
    sortHint: '对方等得越久越靠前',
    metricDir: 'desc',
  },
  { key: 'stale', title: '停滞', sortHint: '越久没动静越靠前', metricDir: 'desc' },
  { key: 'no_ddl', title: '无 DDL', sortHint: '建得越早越靠前', metricDir: 'desc' },
  { key: 'suspended', title: '挂起', sortHint: '挂得越久越靠前', metricDir: 'desc' },
];

// ---------------------------------------------------------------------------

interface Facts {
  item: ItemViewRow;
  stages: StageRow[];
  activeStage: StageRow | null;
  openBlockers: BlockerRow[];
  lastEventAt: string | null;
  nextDdl: string | null;
  /** 距下一个 DDL 的天数，负数=已逾期；没有 DDL 时为 null */
  daysLeft: number | null;
  /** 距最近一次事件的天数；从未有事件时为 null */
  staleDays: number | null;
  score: number;
}

/** 排序需要但不必暴露给前端的字段 */
type ScoredCard = DashboardCard & {
  priorityOverride: number | null;
  deadlinePassed: boolean;
};

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function openBlockersOf(f: Facts, direction: BlockerRow['direction']): BlockerRow[] {
  return f.openBlockers.filter((b) => b.direction === direction);
}

function daysSince(ts: string, today: string): number {
  return daysBetween(localDate(ts), today);
}

/** 承诺时间已过 = 有一条「我被阻塞」的承诺时间早于今天 */
function hasMissedPromise(f: Facts, today: string): boolean {
  return openBlockersOf(f, 'blocked_by_others').some(
    (b) => b.promised_at !== null && daysBetween(b.promised_at, today) > 0,
  );
}

function scoreOf(f: Facts, settings: Settings, today: string): number {
  const w = settings.scoring.weights;
  const horizon = settings.scoring.horizon_days;

  const urgency = f.daysLeft === null ? 0 : clamp01(1 - f.daysLeft / horizon);
  const crit = (f.item.criticality - 1) / 4;
  const longestBlock = openBlockersOf(f, 'blocked_by_others').reduce(
    (max, b) => Math.max(max, daysSince(b.opened_at, today)),
    0,
  );
  const blockerAge = clamp01(longestBlock / 14);
  const stale = clamp01((f.staleDays ?? 0) / 30);
  // downstream（下游依赖数）要等 P3 的需求依赖边启用后才有值，现在恒为 0
  const downstream = 0;

  return (
    w.urgency * urgency +
    w.criticality * crit +
    w.blocker_age * blockerAge +
    w.downstream * downstream +
    w.stale * stale
  );
}

/** 手动置顶/置底的档位：正数=置顶，null=正常，负数=置底 */
function overrideRank(p: number | null): number {
  if (p === null) return 0;
  return p > 0 ? 1 : -1;
}

function compareCards(a: ScoredCard, b: ScoredCard, dir: 'asc' | 'desc'): number {
  // 手动覆盖永远优先于自动排序 —— 自动排序偶尔会气人，必须留手动出口
  const ra = overrideRank(a.priorityOverride);
  const rb = overrideRank(b.priorityOverride);
  if (ra !== rb) return rb - ra;
  if (ra !== 0) {
    const pa = a.priorityOverride ?? 0;
    const pb = b.priorityOverride ?? 0;
    if (pa !== pb) return Math.abs(pb) - Math.abs(pa);
  }

  // 承诺时间已过的阻塞，优先于纯粹等得久的
  if (a.deadlinePassed !== b.deadlinePassed) return a.deadlinePassed ? -1 : 1;

  if (a.metric !== b.metric) return dir === 'desc' ? b.metric - a.metric : a.metric - b.metric;
  if (a.score !== b.score) return b.score - a.score;
  return a.itemId - b.itemId; // 稳定兜底
}

function pinnedOf(p: number | null): DashboardCard['pinned'] {
  if (p === null) return null;
  return p > 0 ? 'top' : 'bottom';
}

export interface DashboardOptions {
  /** 便于测试注入「今天」 */
  today?: string;
  settings?: Settings;
}

/**
 * 一次把库读全、把每个需求的事实算清。
 *
 * 分桶、焦点列表、甘特图都基于同一份 Facts —— 分开各查一遍的话，
 * 三处对「逾期几天」「等了多少天」的口径迟早会不一致。
 */
function buildFacts(db: Db, settings: Settings, today: string): Facts[] {
  const live = all<ItemViewRow>(db, 'SELECT * FROM v_item WHERE closed_at IS NULL');
  if (live.length === 0) return [];

  const ids = live.map((i) => i.id);
  const ph = ids.map(() => '?').join(',');

  const stages = all<StageRow>(
    db,
    `SELECT * FROM stage WHERE item_id IN (${ph}) ORDER BY item_id, seq`,
    ...ids,
  );
  const blockers = all<BlockerRow>(
    db,
    `SELECT * FROM blocker WHERE item_id IN (${ph}) AND closed_at IS NULL`,
    ...ids,
  );
  const lastEvents = all<{ item_id: number; last: string }>(
    db,
    `SELECT item_id, MAX(occurred_at) AS last
       FROM event
      WHERE item_id IN (${ph}) AND voided_at IS NULL
      GROUP BY item_id`,
    ...ids,
  );

  const stagesByItem = groupBy(stages, (s) => s.item_id);
  const blockersByItem = groupBy(blockers, (b) => b.item_id);
  const lastByItem = new Map(lastEvents.map((r) => [r.item_id, r.last]));

  return live.map((item) => {
    const itemStages = stagesByItem.get(item.id) ?? [];
    const lastEventAt = lastByItem.get(item.id) ?? null;
    const ddl = nextDdl(item, itemStages);

    const f: Facts = {
      item,
      stages: itemStages,
      activeStage: itemStages.find((s) => s.id === item.active_stage_id) ?? null,
      openBlockers: blockersByItem.get(item.id) ?? [],
      lastEventAt,
      nextDdl: ddl,
      daysLeft: ddl === null ? null : daysBetween(today, ddl),
      staleDays: lastEventAt === null ? null : daysSince(lastEventAt, today),
      score: 0,
    };
    f.score = scoreOf(f, settings, today);
    return f;
  });
}

function isSuspended(f: Facts): boolean {
  return f.item.condition === 'suspended';
}

function buildSections(facts: Facts[], settings: Settings, today: string): DashboardSection[] {
  const byKey = new Map<DashboardBucketKey, Facts[]>(BUCKETS.map((b) => [b.key, []]));

  for (const f of facts) {
    // 挂起就是「别催我」开关：它只进挂起桶，不进逾期/临期/停滞桶。
    // 但必须单独列出来并显示挂了多久，否则会挂到天荒地老。
    if (isSuspended(f)) {
      byKey.get('suspended')!.push(f);
      continue;
    }

    if (f.daysLeft !== null && f.daysLeft < 0) {
      byKey.get('overdue')!.push(f);
    } else if (f.daysLeft !== null && f.daysLeft <= settings.dashboard.due_soon_days) {
      byKey.get('due_soon')!.push(f);
    }

    if (openBlockersOf(f, 'blocked_by_others').length > 0) byKey.get('blocked_by_others')!.push(f);
    if (openBlockersOf(f, 'blocking_others').length > 0) byKey.get('blocking_others')!.push(f);

    if (f.staleDays !== null && f.staleDays > settings.dashboard.stale_days) {
      byKey.get('stale')!.push(f);
    }
    if (f.nextDdl === null) byKey.get('no_ddl')!.push(f);
  }

  return BUCKETS.map((def) => {
    const cards = byKey.get(def.key)!.map((f) => buildCard(f, def.key, today));
    cards.sort((a, b) => compareCards(a, b, def.metricDir));
    return { key: def.key, title: def.title, sortHint: def.sortHint, cards };
  });
}

export interface DashboardOptions {
  /** 便于测试注入「今天」 */
  today?: string;
  settings?: Settings;
}

/** 只要分桶结果（老接口，测试与汇报都用它） */
export function computeDashboard(db: Db, opts: DashboardOptions = {}): DashboardSection[] {
  const settings = opts.settings ?? loadSettings();
  const today = opts.today ?? todayIso();
  return buildSections(buildFacts(db, settings, today), settings, today);
}

/** 仪表盘要的全部：分桶 + 焦点列表 + 甘特图 */
export function computeDashboardPayload(
  db: Db,
  opts: DashboardOptions = {},
): DashboardPayload {
  const settings = opts.settings ?? loadSettings();
  const today = opts.today ?? todayIso();
  const facts = buildFacts(db, settings, today);
  const sections = buildSections(facts, settings, today);

  return {
    summary: dashboardSummary(sections) as Record<DashboardBucketKey, number>,
    sections,
    focus: buildFocus(facts, today),
    gantt: buildGantt(facts, today),
    caretaking: buildCaretaking(db),
  };
}

/**
 * 看护中的项目。
 *
 * 看护型容器**不进任何时间桶**（它压根不是 item），所以必须单独列一块 ——
 * 否则「我手上还持有哪些长期责任」就完全没有地方能看见。
 *
 * 只看**我负责的**：交接出去的责任不该继续占我的驾驶舱（但项目页里还查得到）。
 * 有在途子需求的排前面：那才是现在要动手的。
 */
function buildCaretaking(db: Db): ProjectSummary[] {
  return listProjects(db, { kind: 'caretaking' })
    // 我的责任：本来就归我的，加上**已交出但对方还没接收**的（那段真空期我还在兜底）
    .filter((p) => p.owner === CURRENT_OWNER || p.pending_handoff)
    .sort((a, b) => b.active_items - a.active_items || a.id - b.id);
}

function buildCard(f: Facts, bucket: DashboardBucketKey, today: string): ScoredCard {
  let metric = 0;
  let reason = '';

  switch (bucket) {
    case 'overdue': {
      metric = Math.abs(f.daysLeft ?? 0);
      reason = `已逾期 ${metric} 天`;
      break;
    }
    case 'due_soon': {
      metric = f.daysLeft ?? 0;
      reason = metric === 0 ? '今天到期' : `还有 ${metric} 天到期`;
      break;
    }
    case 'blocked_by_others': {
      const behind = openBlockersOf(f, 'blocked_by_others').sort(
        (a, b) => daysSince(b.opened_at, today) - daysSince(a.opened_at, today),
      )[0]!;
      metric = daysSince(behind.opened_at, today);
      reason = `等 ${behind.counterparty} 的「${behind.need}」已 ${metric} 天`;
      if (behind.promised_at !== null && daysBetween(behind.promised_at, today) > 0) {
        reason += `（承诺时间 ${behind.promised_at} 已过）`;
      }
      break;
    }
    case 'blocking_others': {
      const front = openBlockersOf(f, 'blocking_others').sort(
        (a, b) => daysSince(b.opened_at, today) - daysSince(a.opened_at, today),
      )[0]!;
      metric = daysSince(front.opened_at, today);
      reason = `${front.counterparty} 在等我：${front.need}，已 ${metric} 天`;
      break;
    }
    case 'stale': {
      metric = f.staleDays ?? 0;
      reason = `${metric} 天没有任何进展记录`;
      break;
    }
    case 'no_ddl': {
      metric = daysSince(f.item.created_at, today);
      reason = '没有设置任何 DDL';
      break;
    }
    case 'suspended': {
      const since = f.item.suspended_at ?? f.activeStage?.suspended_at ?? f.item.created_at;
      metric = daysSince(since, today);
      reason = `已挂起 ${metric} 天`;
      const why = f.item.suspended_reason ?? f.activeStage?.suspended_reason;
      if (why) reason += `：${why}`;
      // 挂起不能变成藏逾期的地方
      if (f.nextDdl !== null) {
        const overdueAtSuspend = daysBetween(f.nextDdl, localDate(since));
        if (overdueAtSuspend > 0) reason += `，挂起时已逾期 ${overdueAtSuspend} 天`;
      }
      break;
    }
  }

  return makeCard(f, metric, reason, today);
}

/** 所有卡片（分桶的、焦点列表的）都从这里出，保证字段齐全且口径一致 */
function makeCard(f: Facts, metric: number, reason: string, today: string): ScoredCard {
  return {
    itemId: f.item.id,
    code: f.item.code,
    ref: f.item.ref,
    title: f.item.title,
    role: f.item.role,
    condition: f.item.condition,
    criticality: f.item.criticality,
    currentStage: f.activeStage?.name ?? null,
    nextDdl: f.nextDdl,
    score: Number(f.score.toFixed(4)),
    reason,
    metric,
    pinned: pinnedOf(f.item.priority_override),
    priorityOverride: f.item.priority_override,
    deadlinePassed: hasMissedPromise(f, today),
  };
}

/** 焦点列表的一句话理由：把几条信号拼起来，而不是只说一个维度 */
function focusReason(f: Facts, today: string): string {
  const parts: string[] = [];

  if (f.daysLeft === null) {
    parts.push('没有设置 DDL');
  } else if (f.daysLeft < 0) {
    parts.push(`已逾期 ${-f.daysLeft} 天`);
  } else if (f.daysLeft === 0) {
    parts.push('今天到期');
  } else if (f.daysLeft <= 3) {
    parts.push(`还有 ${f.daysLeft} 天到期`);
  }

  const behind = openBlockersOf(f, 'blocked_by_others');
  if (behind.length > 0) {
    const b = [...behind].sort(
      (x, y) => daysSince(y.opened_at, today) - daysSince(x.opened_at, today),
    )[0]!;
    parts.push(`等 ${b.counterparty} 的「${b.need}」${daysSince(b.opened_at, today)} 天`);
    if (b.promised_at !== null && daysBetween(b.promised_at, today) > 0) parts.push('承诺已过期');
  }

  const front = openBlockersOf(f, 'blocking_others');
  if (front.length > 0) {
    const b = front[0]!;
    parts.push(`${b.counterparty} 在等我：${b.need}`);
  }

  if (f.staleDays !== null && f.staleDays > 7) parts.push(`${f.staleDays} 天无进展`);
  if (f.item.criticality >= 4) parts.push(`关键度 ${f.item.criticality}`);

  return parts.join(' · ');
}

const FOCUS_LIMIT = 3;

/**
 * 三条焦点列表。和分桶的区别是：分桶回答「都有哪些」，
 * 焦点回答「现在就动手的话动哪几个」—— 所以各截前 N 条。
 */
function buildFocus(facts: Facts[], today: string): DashboardFocus {
  const pick = (source: Facts[], limit = FOCUS_LIMIT): DashboardCard[] => {
    const cards = source.map((f) => makeCard(f, f.score, focusReason(f, today), today));
    cards.sort((a, b) => compareCards(a, b, 'desc'));
    return cards.slice(0, limit);
  };

  const active = facts.filter((f) => !isSuspended(f));

  return {
    // 最紧要：所有在途需求按综合分排
    urgent: pick(active),
    // 需要我去推动：别人在等我，这是我唯一能单方面解决的一类
    blockingOthers: pick(active.filter((f) => openBlockersOf(f, 'blocking_others').length > 0)),
    // 我被卡住：我在等别人，承诺时间已过的会被 compareCards 顶到最前
    blockedByOthers: pick(active.filter((f) => openBlockersOf(f, 'blocked_by_others').length > 0)),
  };
}

// 甘特图窗口：默认回看一周、前看三周，数据撑得开就撑开，但不超过这两个硬边界，
// 否则一条「明年 3 月到期」的需求会把整张图压成一根线。
const HARD_LOOKBACK_DAYS = 45;
const HARD_LOOKAHEAD_DAYS = 90;
const MIN_AHEAD_DAYS = 21;

function buildGantt(facts: Facts[], today: string): GanttChart {
  const withDdl = facts.filter((f): f is Facts & { nextDdl: string } => f.nextDdl !== null);
  const withoutDdl = facts
    .filter((f) => f.nextDdl === null)
    .map((f) => ({
      itemId: f.item.id,
      code: f.item.code,
      ref: f.item.ref,
      title: f.item.title,
    }));

  const lookbackFloor = shiftDays(today, -HARD_LOOKBACK_DAYS);
  const lookaheadCap = shiftDays(today, HARD_LOOKAHEAD_DAYS);

  const beyondWindow = withDdl.filter((f) => f.nextDdl > lookaheadCap).length;
  const plotted = withDdl.filter((f) => f.nextDdl <= lookaheadCap);

  let windowStart = shiftDays(today, -7);
  let windowEnd = shiftDays(today, MIN_AHEAD_DAYS);
  for (const f of plotted) {
    if (f.nextDdl < windowStart) windowStart = f.nextDdl;
    if (f.nextDdl > windowEnd) windowEnd = f.nextDdl;
  }
  if (windowStart < lookbackFloor) windowStart = lookbackFloor;
  if (windowEnd > lookaheadCap) windowEnd = lookaheadCap;

  const totalDays = daysBetween(windowStart, windowEnd);
  const clampDay = (d: number) => Math.min(totalDays, Math.max(0, d));

  const bars: GanttBar[] = plotted.map((f) => {
    const milestones: GanttMilestone[] = f.stages
      .filter((s) => s.actual_end_at === null && s.planned_end !== null)
      .map((s) => ({
        stageId: s.id,
        name: s.name,
        day: clampDay(daysBetween(windowStart, s.planned_end!)),
        plannedEnd: s.planned_end!,
      }));

    return {
      itemId: f.item.id,
      code: f.item.code,
      ref: f.item.ref,
      title: f.item.title,
      role: f.item.role,
      condition: f.item.condition,
      startDay: clampDay(daysBetween(windowStart, localDate(f.item.created_at))),
      endDay: clampDay(daysBetween(windowStart, f.nextDdl)),
      overdueDays: Math.max(0, daysBetween(f.nextDdl, today)),
      nextDdl: f.nextDdl,
      currentStage: f.activeStage?.name ?? null,
      score: Number(f.score.toFixed(4)),
      milestones,
    };
  });

  // 最紧急的在最上面：结束得越早越靠前，同一天按分数。
  // 挂起的一律排到最后 —— 这张图是给你决定「先动哪个」用的，
  // 而挂起的语义是「别催我」，让它占头几行就自相矛盾了。
  bars.sort((a, b) => {
    const sa = a.condition === 'suspended' ? 1 : 0;
    const sb = b.condition === 'suspended' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return a.endDay - b.endDay || b.score - a.score;
  });

  const step = totalDays <= 35 ? 7 : totalDays <= 70 ? 14 : 21;
  const ticks: GanttChart['ticks'] = [];
  for (let d = 0; d <= totalDays; d += step) {
    const date = shiftDays(windowStart, d);
    ticks.push({ day: d, label: date.slice(5).replace('-', '/'), major: date.endsWith('-01') });
  }

  return {
    windowStart,
    windowEnd,
    totalDays,
    todayDay: daysBetween(windowStart, today),
    ticks,
    bars,
    withoutDdl,
    beyondWindow,
  };
}

/** 各桶数量，给 UI 顶部和汇报用 */
export function dashboardSummary(sections: DashboardSection[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sections) out[s.key] = s.cards.length;
  return out;
}
