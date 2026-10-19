import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  DashboardBucketKey,
  DashboardCard,
  DashboardFocus,
  DashboardSection,
  GanttBar,
  GanttChart,
  ProjectSummary,
} from '@manager/shared';
import { api } from '../api';
import { navigate } from '../lib/router';
import { messageOf } from '../lib/notice';
import {
  BUCKET_BAR,
  BUCKET_THEME,
  CONDITION_THEME,
  ConditionBadge,
  ProjectKindBadge,
  RoleBadge,
} from './Badges';
import { Hint, SurfaceCard, btnGhost, mono, surface } from './ui';

const goItem = (id: number) => navigate({ name: 'item', id, stageId: null });

type View = 'split' | 'kanban' | 'gantt';

/**
 * 一条需求可能同时落在几个桶里（「逾期 + 被阻塞」是常态，不是数据错误）。
 * 看板去重、卡片色条、甘特条取色都要用到「它到底算哪个桶」，
 * 所以这里定一张优先级表：越靠前的桶越该被看见。
 */
const BUCKET_RANK: Record<DashboardBucketKey, number> = {
  overdue: 0,
  due_soon: 1,
  blocking_others: 2,
  blocked_by_others: 3,
  suspended: 4,
  stale: 5,
  no_ddl: 6,
};

const BUCKET_ORDER: readonly DashboardBucketKey[] = [
  'overdue',
  'due_soon',
  'blocking_others',
  'blocked_by_others',
  'suspended',
  'stale',
  'no_ddl',
];

const NO_STAGE = '无进行中阶段';

/** itemId → 它优先级最高的那个桶。同一条需求只在「最先看见」的桶里取色。 */
function bucketMapOf(sections: DashboardSection[]): Map<number, DashboardBucketKey> {
  const map = new Map<number, DashboardBucketKey>();
  for (const section of sections) {
    for (const card of section.cards) {
      const current = map.get(card.itemId);
      if (current === undefined || BUCKET_RANK[section.key] < BUCKET_RANK[current]) {
        map.set(card.itemId, section.key);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 驾驶舱
// ---------------------------------------------------------------------------

export function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard });
  const [selectedBucket, setSelectedBucket] = useState<DashboardBucketKey | null>(null);
  const [view, setView] = useState<View>('split');

  if (q.isLoading) return <Hint>加载中…</Hint>;
  if (q.error) return <Hint tone="error">{messageOf(q.error)}</Hint>;

  const data = q.data;
  if (!data) return null;

  const nonEmpty = data.sections.filter((s) => s.cards.length > 0);
  const bucketMap = bucketMapOf(data.sections);
  const uniqueCount = bucketMap.size;

  const toggleBucket = (key: DashboardBucketKey) =>
    setSelectedBucket((current) => (current === key ? null : key));
  const clearBucket = () => setSelectedBucket(null);

  if (nonEmpty.length === 0 && data.caretaking.length === 0) {
    return (
      <div className="mx-auto max-w-6xl">
        <Hint>没有在途需求。去「需求」页新建一个，或按 Ctrl+K 用命令面板操作。</Hint>
      </div>
    );
  }

  // 手上没有在途需求、只有看护责任时，不摆一排 0 —— 直接给看护清单
  if (nonEmpty.length === 0) {
    return (
      <div className="mx-auto max-w-6xl space-y-5">
        <Hint>当前没有在途需求。</Hint>
        <CaretakingProjects projects={data.caretaking} wide />
      </div>
    );
  }

  const visibleSections = selectedBucket
    ? data.sections.filter((s) => s.key === selectedBucket)
    : nonEmpty;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <RadarBar
        sections={data.sections}
        selected={selectedBucket}
        total={uniqueCount}
        onToggle={toggleBucket}
        onClear={clearBucket}
      />

      <StatsRow sections={data.sections} caretaking={data.caretaking} uniqueCount={uniqueCount} />

      <ViewSwitch view={view} onChange={setView} />

      {view === 'split' && (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
          <div className="xl:col-span-5">
            <CaretakingProjects projects={data.caretaking} />
          </div>
          <div className="xl:col-span-7">
            <GanttView chart={data.gantt} bucketMap={bucketMap} sections={data.sections} />
          </div>
        </div>
      )}

      {view === 'gantt' && (
        <GanttView chart={data.gantt} bucketMap={bucketMap} sections={data.sections} />
      )}

      {view === 'kanban' && <KanbanBoard sections={data.sections} bucketMap={bucketMap} />}

      <FocusRow focus={data.focus} />

      <div className="space-y-5">
        {selectedBucket && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
            <span>分桶列表只显示</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-300">
              <span className={`h-1.5 w-1.5 rounded-full ${BUCKET_THEME[selectedBucket].dot}`} />
              {data.sections.find((s) => s.key === selectedBucket)?.title ?? selectedBucket}
            </span>
            <span>分桶之间会重叠，同一条需求可以出现在多个桶里。</span>
            <button
              type="button"
              onClick={clearBucket}
              className="text-indigo-400 transition-colors hover:text-indigo-300"
            >
              清除筛选
            </button>
          </div>
        )}

        {visibleSections.map((section) => (
          <BucketSection key={section.key} section={section} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 异常状态雷达：一排可点胶囊，既是数字也是筛选器
// ---------------------------------------------------------------------------

function RadarBar({
  sections,
  selected,
  total,
  onToggle,
  onClear,
}: {
  sections: DashboardSection[];
  selected: DashboardBucketKey | null;
  total: number;
  onToggle: (key: DashboardBucketKey) => void;
  onClear: () => void;
}) {
  const allActive = selected === null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-xs font-semibold tracking-tight text-slate-200">异常状态雷达</h2>
        <span className="text-[11px] text-slate-500">
          点一个分桶只看这一类的卡片；再点一次取消。「全部」按需求去重。
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
        <button
          type="button"
          aria-pressed={allActive}
          onClick={onClear}
          title="清空筛选，显示全部在途需求"
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-left transition-colors ${
            allActive
              ? 'border-indigo-500/50 bg-indigo-500/10 ring-2 ring-indigo-500'
              : 'border-white/[0.07] bg-[#161C28]/90 hover:border-white/[0.14] hover:bg-[#1C2333]'
          }`}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
          <span
            className={`line-clamp-2 text-[11px] leading-tight font-medium ${allActive ? 'text-indigo-200' : 'text-slate-300'}`}
          >
            全部
          </span>
          <span
            className={`ml-auto shrink-0 font-mono text-xs tabular-nums ${
              allActive ? 'text-indigo-300' : 'text-indigo-400'
            }`}
          >
            {total}
          </span>
        </button>

        {sections.map((section) => {
          const active = selected === section.key;
          const count = section.cards.length;
          return (
            <button
              key={section.key}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(section.key)}
              title={`${section.title}：${count === 0 ? '暂无' : `${count} 条`} —— 点击筛选，再点取消`}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-left transition-colors ${
                active
                  ? 'border-indigo-500/50 bg-indigo-500/10 ring-2 ring-indigo-500'
                  : 'border-white/[0.07] bg-[#161C28]/90 hover:border-white/[0.14] hover:bg-[#1C2333]'
              } ${count === 0 ? 'opacity-45' : ''}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${BUCKET_THEME[section.key].dot}`} />
              <span
                className={`line-clamp-2 text-[11px] leading-tight font-medium ${
                  active ? 'text-indigo-200' : 'text-slate-300'
                }`}
              >
                {section.title}
              </span>
              <span
                className={`ml-auto shrink-0 font-mono text-xs tabular-nums ${
                  active ? 'text-indigo-300' : 'text-indigo-400'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 统计数字行：五个真实口径的聚合数字。在途数按需求去重；
// 另外四个是「现在压在我身上的量」，跟雷达的七个分桶是两种读法。
// ---------------------------------------------------------------------------

function StatsRow({
  sections,
  caretaking,
  uniqueCount,
}: {
  sections: DashboardSection[];
  caretaking: ProjectSummary[];
  uniqueCount: number;
}) {
  const countOf = (key: DashboardBucketKey) =>
    sections.find((section) => section.key === key)?.cards.length ?? 0;
  const titleOf = (key: DashboardBucketKey) =>
    sections.find((section) => section.key === key)?.title ?? key;

  const stats = [
    {
      key: 'in_flight',
      label: '在途需求',
      value: uniqueCount,
      hint: '按需求去重（同一条可能落在几个桶）',
      bar: 'border-l-[3px] border-l-indigo-500',
    },
    {
      key: 'overdue',
      label: titleOf('overdue'),
      value: countOf('overdue'),
      hint: '超期越久越靠前',
      bar: BUCKET_THEME.overdue.borderLeft,
    },
    {
      key: 'blocking_others',
      label: titleOf('blocking_others'),
      value: countOf('blocking_others'),
      hint: '别人在等我，只有我能单方面解决',
      bar: BUCKET_THEME.blocking_others.borderLeft,
    },
    {
      key: 'blocked_by_others',
      label: titleOf('blocked_by_others'),
      value: countOf('blocked_by_others'),
      hint: '我在等别人，承诺已过的排前面',
      bar: BUCKET_THEME.blocked_by_others.borderLeft,
    },
    {
      key: 'caretaking',
      label: '看护中',
      value: caretaking.length,
      hint: '长期持有、事件驱动的责任',
      bar: 'border-l-[3px] border-l-sky-500',
    },
  ];

  return (
    <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((stat) => (
        <div
          key={stat.key}
          className={`rounded-xl border border-white/[0.07] bg-[#161C28]/90 px-3.5 py-3 shadow-sm transition-colors hover:border-white/[0.14] ${stat.bar}`}
        >
          <div className="text-2xl font-semibold tabular-nums leading-none tracking-tight text-slate-100">
            {stat.value}
          </div>
          <div className="mt-1.5 text-xs text-slate-300">{stat.label}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{stat.hint}</div>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 视图切换：看护 & 排期 / 阶段看板 / 全屏甘特
// ---------------------------------------------------------------------------

function ViewSwitch({ view, onChange }: { view: View; onChange: (next: View) => void }) {
  const items: { key: View; label: string }[] = [
    { key: 'split', label: '看护 & 排期' },
    { key: 'kanban', label: '阶段看板' },
    { key: 'gantt', label: '全屏甘特' },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        className="inline-flex rounded-lg border border-white/[0.08] bg-[#11161F]/80 p-0.5"
        role="tablist"
        aria-label="驾驶舱视图"
      >
        {items.map((item) => {
          const active = view === item.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(item.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition-colors ${
                active
                  ? 'bg-indigo-500/15 font-medium text-indigo-300'
                  : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
              }`}
            >
              <ViewIcon view={item.key} />
              {item.label}
            </button>
          );
        })}
      </div>

      {/* 流水线是配置不是代码，入口放这儿 —— 想改流程时不用去翻仓库 */}
      <button
        type="button"
        className={`${btnGhost} ml-auto`}
        onClick={() => navigate({ name: 'pipelines' })}
        title="改流水线的阶段和待办；改完立刻生效，不用重启"
      >
        流水线定制
      </button>
    </div>
  );
}

function ViewIcon({ view }: { view: View }) {
  const d =
    view === 'split'
      ? 'M3 5h18v14H3zM12 5v14'
      : view === 'kanban'
        ? 'M4 4h4v16H4zM10 4h4v11h-4zM16 4h4v14h-4z'
        : 'M3 7h8M7 12h10M5 17h7';
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 看护中：长期持有、事件驱动的责任
// ---------------------------------------------------------------------------

/**
 * 看护型项目**不进任何时间桶**（它不是一个需求，没有日程），所以必须单独列一块，
 * 否则「我手上还持有哪些长期责任」就完全没有地方能看见。
 */
function CaretakingProjects({
  projects,
  wide = false,
}: {
  projects: ProjectSummary[];
  wide?: boolean;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold tracking-tight text-slate-100">看护中</h2>
        <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 text-[11px] text-slate-300">
          {projects.length}
        </span>
        <span className="text-[11px] text-slate-500">
          长期持有、事件驱动的责任。没有在途子需求是正常状态，不算停滞。
        </span>
      </div>

      {projects.length === 0 ? (
        <Hint>当前没有看护中的项目。看护型项目不进任何时间桶，只在驾驶舱这里单独列着。</Hint>
      ) : (
        <div
          className={
            wide
              ? 'grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3'
              : 'grid grid-cols-1 gap-2.5'
          }
        >
          {projects.map((project) => (
            <CaretakingCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </section>
  );
}

function CaretakingCard({ project: p }: { project: ProjectSummary }) {
  // 进度条口径：还有多少子需求在途（active_items / total_items），不是工期完成度。
  // 没有子需求时老老实实画 0。
  const ratio = p.total_items > 0 ? Math.min(1, p.active_items / p.total_items) : 0;

  return (
    <button
      type="button"
      onClick={() => navigate({ name: 'projects', projectId: p.id })}
      className="w-full rounded-xl border border-white/[0.07] border-l-[3px] border-l-sky-500 bg-[#161C28]/90 p-3 text-left shadow-sm transition-colors hover:border-white/[0.14] hover:border-l-sky-400 hover:bg-[#1C2333]/70"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ProjectKindBadge kind={p.kind} />
        {p.code && <span className={mono}>{p.code}</span>}
        <span className="truncate text-sm text-slate-100">{p.name}</span>

        {p.pending_handoff ? (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
            已交出，等 {p.owner} 接收
          </span>
        ) : p.active_items > 0 ? (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
            {p.active_items} 条在途
          </span>
        ) : (
          <span className="text-[11px] text-slate-500">待命</span>
        )}

        {p.open_blockers > 0 && (
          <span className="text-[11px] text-amber-300">{p.open_blockers} 条未解除阻塞</span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {p.watch_for && (
          <span className="min-w-0 truncate text-slate-400" title={p.watch_for}>
            等：{p.watch_for}
          </span>
        )}
        <span className="shrink-0">负责人 {p.owner}</span>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-indigo-500/80"
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-slate-500">
          在途 {p.active_items} / 共 {p.total_items}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 甘特图
// ---------------------------------------------------------------------------

function GanttView({
  chart,
  bucketMap,
  sections,
}: {
  chart: GanttChart;
  bucketMap: Map<number, DashboardBucketKey>;
  sections: DashboardSection[];
}) {
  const { totalDays, todayDay, ticks, bars, withoutDdl, beyondWindow } = chart;
  const pct = (day: number) => (totalDays === 0 ? 0 : (day / totalDays) * 100);

  const titleOf = (key: DashboardBucketKey) =>
    sections.find((section) => section.key === key)?.title ?? key;
  const presentBuckets = BUCKET_ORDER.filter((bucket) =>
    bars.some((bar) => bucketMap.get(bar.itemId) === bucket),
  );
  const hasUnbucketed = bars.some((bar) => !bucketMap.has(bar.itemId));
  const empty = bars.length === 0 && withoutDdl.length === 0;

  return (
    <SurfaceCard
      title="甘特图 · 即将到期"
      extra={
        <span className="font-mono text-xs text-indigo-400">
          {chart.windowStart} ~ {chart.windowEnd}
        </span>
      }
    >
      {empty ? (
        <div className="px-4">
          <Hint>
            没有带 DDL 的在途需求，时间轴上暂时是空的。给需求或阶段设一个截止日，它就会出现在这里。
          </Hint>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/[0.07] px-4 py-2 text-[11px] text-slate-500">
            {presentBuckets.map((bucket) => (
              <span key={bucket} className="flex items-center gap-1.5">
                <span className={`h-2 w-3 rounded-sm ${BUCKET_THEME[bucket].dot}`} />
                {titleOf(bucket)}
              </span>
            ))}
            {hasUnbucketed && (
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-sm bg-slate-500/70" />
                其他
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="h-[6px] w-[6px] rotate-45 bg-slate-200/80" />
              阶段 DDL
            </span>
            {beyondWindow > 0 && (
              <span className="ml-auto">另有 {beyondWindow} 条 DDL 在窗口之外，未画出</span>
            )}
          </div>

          <div className="overflow-x-auto p-3">
            <div className="min-w-[600px]">
              {/* 今天标签：单独一行，避免和日期刻度挤在一起 */}
              <div className="flex">
                <div className="w-48 shrink-0" />
                <div className="relative h-4 flex-1">
                  <span
                    className="absolute -translate-x-1/2 rounded-full border border-rose-500/40 bg-rose-500/10 px-1.5 text-[10px] font-medium leading-4 text-rose-300"
                    style={{ left: `${pct(todayDay)}%` }}
                  >
                    今天
                  </span>
                </div>
                <div className="w-16 shrink-0" />
              </div>

              {/* 日期刻度 */}
              <div className="flex">
                <div className="w-48 shrink-0" />
                <div className="relative h-4 flex-1">
                  {ticks.map((tick) => (
                    <span
                      key={tick.day}
                      className={`absolute -translate-x-1/2 text-[10px] ${
                        tick.major ? 'text-slate-400' : 'text-slate-600'
                      }`}
                      style={{ left: `${pct(tick.day)}%` }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
                <div className="w-16 shrink-0" />
              </div>

              {/* 条块行 + 贯穿所有行的今天红线 */}
              <div className="relative mt-1">
                {bars.map((bar) => (
                  <GanttRow
                    key={bar.itemId}
                    bar={bar}
                    bucket={bucketMap.get(bar.itemId)}
                    pct={pct}
                    todayDay={todayDay}
                  />
                ))}
                <div className="pointer-events-none absolute inset-y-0 left-48 right-16">
                  <div
                    className="absolute inset-y-0 w-px bg-rose-500/70"
                    style={{ left: `${pct(todayDay)}%` }}
                  />
                </div>
              </div>
            </div>

            {withoutDdl.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/[0.07] pt-2.5 text-[11px] text-slate-500">
                <span>没有 DDL、放不上时间轴：</span>
                {withoutDdl.map((item) => (
                  <button
                    key={item.itemId}
                    type="button"
                    onClick={() => goItem(item.itemId)}
                    title={item.title}
                    className="font-mono text-xs text-indigo-400 transition-colors hover:text-indigo-300"
                  >
                    {item.ref}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </SurfaceCard>
  );
}

function GanttRow({
  bar,
  bucket,
  pct,
  todayDay,
}: {
  bar: GanttBar;
  bucket: DashboardBucketKey | undefined;
  pct: (day: number) => number;
  todayDay: number;
}) {
  const dim = bar.condition === 'suspended';
  const daysLeft = bar.endDay - todayDay;

  // 颜色按分桶取（一眼分得出哪条是红的）；不在任何桶里的条退回中性 slate。
  const barCls = bucket ? BUCKET_BAR[bucket] : 'bg-slate-500/70 border-slate-400';

  // 创建日可能晚于截止日（补录旧数据，或者刚建就发现已经逾期了）。
  // 那种情况不能算出一条负宽度的条 —— 只在截止处画个短标即可。
  const inverted = bar.startDay >= bar.endDay;
  const leftPct = inverted ? pct(bar.endDay) : pct(bar.startDay);
  const widthPct = inverted ? 0.7 : Math.max(0.4, pct(bar.endDay) - pct(bar.startDay));

  return (
    <div
      className={`flex items-center rounded-lg transition-colors hover:bg-white/[0.04] ${
        dim ? 'opacity-50' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => goItem(bar.itemId)}
        title={bar.ref}
        className="w-48 shrink-0 truncate pr-2 text-left text-[11px] text-slate-300 transition-colors hover:text-slate-100"
      >
        {bar.code && <span className="font-mono text-indigo-400/80">{bar.code}</span>} {bar.title}
      </button>

      <div className="relative h-6 flex-1">
        {/* 主条：创建日 → 下一个 DDL */}
        <div
          className={`absolute top-2 h-2 rounded-sm border ${barCls}`}
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        />

        {/* 逾期段：DDL → 今天，一眼看出拖了多久 */}
        {bar.overdueDays > 0 && (
          <div
            className="absolute top-2 h-2 rounded-sm bg-rose-500/30"
            style={{
              left: `${pct(bar.endDay)}%`,
              width: `${Math.max(0.4, pct(todayDay) - pct(bar.endDay))}%`,
            }}
          />
        )}

        {/* 未结束阶段里设了 DDL 的，标成里程碑 */}
        {bar.milestones.map((milestone) => (
          <div
            key={milestone.stageId}
            title={`${milestone.name} 阶段 DDL ${milestone.plannedEnd}`}
            className="absolute top-[7px] h-[6px] w-[6px] rotate-45 bg-slate-200/80"
            style={{ left: `calc(${pct(milestone.day)}% - 3px)` }}
          />
        ))}
      </div>

      <div className="w-16 shrink-0 pl-2 text-right text-[10px] leading-tight">
        <div className="font-mono text-slate-500">{bar.nextDdl.slice(5).replace('-', '/')}</div>
        <div className={bar.overdueDays > 0 ? 'text-rose-300' : 'text-slate-500'}>
          {bar.overdueDays > 0 ? `逾期 ${bar.overdueDays} 天` : `${daysLeft} 天`}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 阶段看板：所有分桶的卡片按当前阶段分组
// ---------------------------------------------------------------------------

function KanbanBoard({
  sections,
  bucketMap,
}: {
  sections: DashboardSection[];
  bucketMap: Map<number, DashboardBucketKey>;
}) {
  // 先按 itemId 去重：同一条需求可能同时出现在几个桶里，
  // 只保留它优先级最高的那个桶里的那张卡（reason/色条都按那个桶算）。
  const byItem = new Map<number, DashboardCard>();
  for (const section of sections) {
    for (const card of section.cards) {
      if (bucketMap.get(card.itemId) === section.key) byItem.set(card.itemId, card);
    }
  }

  const columns = new Map<string, { card: DashboardCard; bucket: DashboardBucketKey }[]>();
  for (const card of byItem.values()) {
    const bucket = bucketMap.get(card.itemId);
    if (bucket === undefined) continue;
    const stage = card.currentStage?.trim() || NO_STAGE;
    const entries = columns.get(stage);
    if (entries) entries.push({ card, bucket });
    else columns.set(stage, [{ card, bucket }]);
  }

  // 「无进行中阶段」永远放最后一列
  const ordered = [...columns.entries()].sort(
    (a, b) => Number(a[0] === NO_STAGE) - Number(b[0] === NO_STAGE),
  );

  if (byItem.size === 0) return <Hint>所有分桶都没有卡片。</Hint>;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold tracking-tight text-slate-100">阶段看板</h2>
        <span className="font-mono text-xs tabular-nums text-slate-500">
          {byItem.size} 条需求
        </span>
        <span className="text-[11px] text-slate-500">
          同一条需求出现在多个分桶时只保留优先级最高的一个；卡片左侧色条就是它所在的分桶。
        </span>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-1">
        {ordered.map(([stage, entries]) => (
          <div key={stage} className={`${surface.inset} w-72 shrink-0 p-3`}>
            <header className="mb-2 flex items-center gap-2">
              <h3 className="truncate text-xs font-semibold tracking-tight text-slate-200">
                {stage}
              </h3>
              <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-slate-500">
                {entries.length}
              </span>
            </header>

            <div className="space-y-2">
              {entries.map(({ card, bucket }) => (
                <KanbanCard key={card.itemId} card={card} bucket={bucket} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function KanbanCard({ card, bucket }: { card: DashboardCard; bucket: DashboardBucketKey }) {
  return (
    <button
      type="button"
      onClick={() => goItem(card.itemId)}
      className={`w-full rounded-xl border border-white/[0.07] bg-[#161C28]/90 p-2.5 text-left shadow-sm transition-colors hover:border-white/[0.14] hover:bg-[#1C2333]/80 ${BUCKET_THEME[bucket].borderLeft}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {card.pinned === 'top' && (
              <span className="shrink-0 text-[10px] text-amber-300">置顶</span>
            )}
            {card.pinned === 'bottom' && (
              <span className="shrink-0 text-[10px] text-slate-500">置底</span>
            )}
            {card.code && (
              <span className="shrink-0 font-mono text-[11px] text-indigo-400">{card.code}</span>
            )}
          </div>
          <div className="mt-0.5 line-clamp-2 text-xs text-slate-100">{card.title}</div>
        </div>
        <span className="shrink-0">
          <ConditionBadge condition={card.condition} />
        </span>
      </div>

      <div className="mt-1.5 truncate text-[11px] text-slate-500">{card.reason}</div>

      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
        <span>
          DDL <span className="font-mono text-indigo-400/90">{card.nextDdl ?? '未设'}</span>
        </span>
        {card.criticality >= 4 && (
          <span className="text-rose-300" title={`关键度 ${card.criticality}`}>
            {'★'.repeat(card.criticality - 3)}
          </span>
        )}
        <span className="ml-auto">
          <RoleBadge role={card.role} />
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 焦点：现在就动手的话，动哪几个
// ---------------------------------------------------------------------------

function FocusRow({ focus }: { focus: DashboardFocus }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <FocusPanel
        title="最紧要"
        hint="按到期紧迫度、关键度、被卡时长综合排序"
        cards={focus.urgent}
        emptyText="暂无需要立刻处理的"
      />
      <FocusPanel
        title="需要我去推动"
        hint="别人在等我 —— 这一类只有我能单方面解决"
        cards={focus.blockingOthers}
        emptyText="没有人在等我"
      />
      <FocusPanel
        title="我被卡住"
        hint="我在等别人 —— 承诺时间已过的排在最前"
        cards={focus.blockedByOthers}
        emptyText="没有被卡住的需求"
      />
    </div>
  );
}

function FocusPanel({
  title,
  hint,
  cards,
  emptyText,
}: {
  title: string;
  hint: string;
  cards: DashboardCard[];
  emptyText?: string;
}) {
  return (
    <SurfaceCard
      title={title}
      extra={<span className="font-mono text-xs tabular-nums text-slate-500">{cards.length}</span>}
    >
      <p className="border-b border-white/[0.07] px-4 py-1.5 text-[11px] leading-relaxed text-slate-500">
        {hint}
      </p>

      {cards.length === 0 ? (
        <div className="px-4">
          <Hint>{emptyText ?? '暂无'}</Hint>
        </div>
      ) : (
        <ul className="divide-y divide-white/[0.07]">
          {cards.map((card) => (
            <li key={card.itemId}>
              <button
                type="button"
                onClick={() => goItem(card.itemId)}
                className={`w-full px-4 py-2.5 text-left transition-colors hover:bg-white/[0.04] ${CONDITION_THEME[card.condition].borderLeft}`}
              >
                <div className="flex items-center gap-2">
                  {card.pinned === 'top' && (
                    <span className="shrink-0 text-[10px] text-amber-300">置顶</span>
                  )}
                  {card.code && <span className={`${mono} shrink-0`}>{card.code}</span>}
                  <span className="truncate text-xs text-slate-100">{card.title}</span>
                  <span className="ml-auto shrink-0">
                    <ConditionBadge condition={card.condition} />
                  </span>
                </div>
                <div className="mt-1 truncate text-[11px] text-slate-400">{card.reason}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-500">
                  <span>{card.currentStage ?? NO_STAGE}</span>
                  <span className="text-slate-600">·</span>
                  <span>
                    DDL <span className="font-mono text-indigo-400/90">{card.nextDdl ?? '未设'}</span>
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SurfaceCard>
  );
}

// ---------------------------------------------------------------------------
// 分桶明细
// ---------------------------------------------------------------------------

function BucketSection({ section }: { section: DashboardSection }) {
  const theme = BUCKET_THEME[section.key];

  return (
    <section id={`bucket-${section.key}`} className="scroll-mt-4 space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold tracking-tight text-slate-100">{section.title}</h2>
        <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 text-[11px] text-slate-300">
          {section.cards.length}
        </span>
        <span className="text-[11px] text-slate-500">{section.sortHint}</span>
      </div>

      {section.cards.length === 0 ? (
        <div className="rounded-xl border border-white/[0.07] bg-[#161C28]/60 px-4">
          <Hint>这个桶里暂时没有需求。</Hint>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {section.cards.map((card) => (
            <li key={card.itemId}>
              <button
                type="button"
                onClick={() => goItem(card.itemId)}
                className={`flex w-full items-center gap-3 rounded-xl border border-white/[0.07] bg-[#161C28]/90 px-3 py-2.5 text-left shadow-sm transition-colors hover:border-white/[0.14] hover:bg-[#1C2333]/80 ${theme.borderLeft}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {card.pinned === 'top' && (
                      <span className="shrink-0 text-[10px] text-amber-300">置顶</span>
                    )}
                    {card.pinned === 'bottom' && (
                      <span className="shrink-0 text-[10px] text-slate-500">置底</span>
                    )}
                    {card.code && <span className={`${mono} shrink-0`}>{card.code}</span>}
                    <span className="truncate text-sm text-slate-100">{card.title}</span>
                  </div>

                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                    <span className="text-slate-300">{card.reason}</span>
                    <span className="text-slate-600">·</span>
                    <span>{card.currentStage ?? NO_STAGE}</span>
                    <span className="text-slate-600">·</span>
                    <span>
                      DDL{' '}
                      <span className="font-mono text-indigo-400/90">{card.nextDdl ?? '未设'}</span>
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {card.criticality >= 4 && (
                    <span
                      className="text-xs text-rose-300"
                      title={`关键度 ${card.criticality}`}
                    >
                      {'★'.repeat(card.criticality - 3)}
                    </span>
                  )}
                  <RoleBadge role={card.role} />
                  <ConditionBadge condition={card.condition} />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
