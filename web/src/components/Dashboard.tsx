import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type {
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
import { ConditionBadge, RoleBadge } from './Badges';

const ACCENT: Record<string, string> = {
  overdue: 'text-rose-300',
  due_soon: 'text-amber-300',
  blocked_by_others: 'text-orange-300',
  blocking_others: 'text-violet-300',
  stale: 'text-zinc-300',
  no_ddl: 'text-zinc-400',
  suspended: 'text-sky-300',
};

const goItem = (id: number) => navigate({ name: 'item', id, stageId: null });

export function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard });

  if (q.isLoading) return <Hint>加载中…</Hint>;
  if (q.error) return <Hint tone="error">{messageOf(q.error)}</Hint>;

  const data = q.data;
  if (!data) return null;

  const nonEmpty = data.sections.filter((s) => s.cards.length > 0);

  if (nonEmpty.length === 0 && data.caretaking.length === 0) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="rounded border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          没有在途需求。去「需求」页新建一个，或按 Ctrl+K 用命令面板操作。
        </div>
      </div>
    );
  }

  // 手上没有在途需求、只有看护责任时，不摆一排 0 —— 直接给看护清单
  if (nonEmpty.length === 0) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <div className="rounded border border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
          当前没有在途需求。
        </div>
        <CaretakingBlock projects={data.caretaking} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <StatsRow sections={data.sections} />
      <FocusRow focus={data.focus} />
      {data.caretaking.length > 0 && <CaretakingBlock projects={data.caretaking} />}
      <GanttView chart={data.gantt} />
      <div className="space-y-6">
        {nonEmpty.map((section) => (
          <Section key={section.key} section={section} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 看护中：长期持有、事件驱动的责任
// ---------------------------------------------------------------------------

/**
 * 看护型项目**不进任何时间桶**（它不是一个需求，没有日程），所以必须单独列一块，
 * 否则「我手上还持有哪些长期责任」就完全没有地方能看见。
 */
function CaretakingBlock({ projects }: { projects: ProjectSummary[] }) {
  return (
    <section className="rounded border border-sky-900/60">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-sky-900/40 px-3 py-2">
        <h2 className="text-xs font-medium text-sky-300">看护中</h2>
        <span className="text-[11px] text-zinc-600">
          长期持有、事件驱动的责任。没有在途子需求是正常状态，不算停滞。
        </span>
      </header>

      <ul className="divide-y divide-zinc-800/70">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => navigate({ name: 'projects', projectId: p.id })}
              className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800/50"
            >
              <span className="font-mono text-[11px] text-zinc-500">{p.code}</span>
              <span className="text-sm text-zinc-100">{p.name}</span>

              {p.pending_handoff ? (
                <span className="rounded bg-amber-500/15 px-1.5 text-[11px] text-amber-300">
                  已交出，等 {p.owner} 接收
                </span>
              ) : p.active_items > 0 ? (
                <span className="rounded bg-amber-500/15 px-1.5 text-[11px] text-amber-300">
                  {p.active_items} 条在途
                </span>
              ) : (
                <span className="text-[11px] text-zinc-600">待命</span>
              )}

              {p.open_blockers > 0 && (
                <span className="text-[11px] text-amber-300">{p.open_blockers} 条阻塞</span>
              )}

              <span className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
                {p.watch_for && <span className="max-w-[28rem] truncate">等：{p.watch_for}</span>}
                <span className="shrink-0">负责人 {p.owner}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 统计卡片：既是数字，也是跳转链接
// ---------------------------------------------------------------------------

function StatsRow({ sections }: { sections: DashboardSection[] }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {sections.map((s) => {
        const n = s.cards.length;
        const targetId = `bucket-${s.key}`;
        return (
          <button
            key={s.key}
            type="button"
            disabled={n === 0}
            title={n === 0 ? `${s.title}：暂无` : `${s.sortHint} —— 点击跳到明细`}
            onClick={() =>
              document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            className={`rounded border px-3 py-2 text-left transition ${
              n === 0
                ? 'cursor-default border-zinc-800/60 opacity-45'
                : `cursor-pointer border-zinc-700 hover:border-zinc-500 hover:bg-zinc-900 ${ACCENT[s.key]}`
            }`}
          >
            <div className="text-xl font-medium tabular-nums leading-tight">{n}</div>
            <div className="truncate text-[11px] text-zinc-400">{s.title}</div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 焦点：现在就动手的话，动哪几个
// ---------------------------------------------------------------------------

function FocusRow({ focus }: { focus: DashboardFocus }) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <FocusPanel
        title="最紧要"
        hint="按到期紧迫度、关键度、被卡时长综合排序"
        cards={focus.urgent}
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
    <section className="rounded border border-zinc-800">
      <header className="border-b border-zinc-800 px-3 py-2">
        <h2 className="text-xs font-medium text-zinc-300">{title}</h2>
        <p className="mt-0.5 text-[11px] text-zinc-600">{hint}</p>
      </header>

      {cards.length === 0 ? (
        <div className="px-3 py-4 text-xs text-zinc-500">{emptyText ?? '暂无'}</div>
      ) : (
        <ul className="divide-y divide-zinc-800/70">
          {cards.map((c) => (
            <li key={c.itemId}>
              <button
                type="button"
                onClick={() => goItem(c.itemId)}
                className="w-full px-3 py-2 text-left hover:bg-zinc-800/50"
              >
                <div className="flex items-center gap-2">
                  {c.pinned === 'top' && <span className="text-[10px] text-amber-300">置顶</span>}
                  <span className="font-mono text-[11px] text-zinc-500">{c.code}</span>
                  <span className="truncate text-xs text-zinc-100">{c.title}</span>
                  <span className="ml-auto shrink-0">
                    <ConditionBadge condition={c.condition} />
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-400">{c.reason}</div>
                <div className="mt-0.5 text-[11px] text-zinc-600">
                  {c.currentStage ?? '无进行中阶段'} · DDL {c.nextDdl ?? '未设'}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 甘特图
// ---------------------------------------------------------------------------

function GanttView({ chart }: { chart: GanttChart }) {
  const { totalDays, todayDay, ticks, bars, withoutDdl, beyondWindow } = chart;
  if (bars.length === 0 && withoutDdl.length === 0) return null;

  const pct = (day: number) => (totalDays === 0 ? 0 : (day / totalDays) * 100);

  return (
    <section className="rounded border border-zinc-800">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-800 px-3 py-2">
        <h2 className="text-xs font-medium text-zinc-300">甘特图 · 即将到期</h2>
        <span className="text-[11px] text-zinc-600">
          {chart.windowStart} ~ {chart.windowEnd} · 横条从创建日到下一个 DDL
        </span>
        <span className="flex items-center gap-2 text-[11px] text-zinc-500">
          <span className="inline-block h-2 w-3 rounded-sm bg-rose-500/70" />
          逾期
          <span className="inline-block h-2 w-3 rounded-sm bg-amber-500/70" />
          3 日内
          <span className="inline-block h-2 w-3 rounded-sm bg-sky-600/60" />
          其他
          <span className="inline-block h-[6px] w-[6px] rotate-45 bg-zinc-200/80" />
          阶段 DDL
        </span>
        {beyondWindow > 0 && (
          <span className="ml-auto text-[11px] text-zinc-500">
            另有 {beyondWindow} 条 DDL 在窗口之外，未画出
          </span>
        )}
      </header>

      <div className="overflow-x-auto p-3">
        <div className="min-w-[660px]">
          <div className="flex">
            <div className="w-56 shrink-0" />
            <div className="relative h-4 flex-1">
              {ticks.map((t) => (
                <span
                  key={t.day}
                  className={`absolute -translate-x-1/2 text-[10px] ${
                    t.major ? 'text-zinc-400' : 'text-zinc-600'
                  }`}
                  style={{ left: `${pct(t.day)}%` }}
                >
                  {t.label}
                </span>
              ))}
            </div>
            <div className="w-20 shrink-0" />
          </div>

          <div className="mt-1 space-y-0.5">
            {bars.map((bar) => (
              <GanttRow key={bar.itemId} bar={bar} pct={pct} todayDay={todayDay} />
            ))}
          </div>
        </div>

        {withoutDdl.length > 0 && (
          <div className="mt-3 border-t border-zinc-800 pt-2 text-[11px] text-zinc-500">
            没有 DDL、放不上时间轴：
            {withoutDdl.map((w) => (
              <button
                key={w.itemId}
                type="button"
                onClick={() => goItem(w.itemId)}
                className="ml-2 text-sky-400 hover:text-sky-300"
              >
                {w.code} {w.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function GanttRow({
  bar,
  pct,
  todayDay,
}: {
  bar: GanttBar;
  pct: (day: number) => number;
  todayDay: number;
}) {
  const dim = bar.condition === 'suspended';
  const daysLeft = bar.endDay - todayDay;

  const barColor =
    bar.overdueDays > 0 ? 'bg-rose-500/70' : daysLeft <= 3 ? 'bg-amber-500/70' : 'bg-sky-600/60';

  // 创建日可能晚于截止日（补录旧数据，或者刚建就发现已经逾期了）。
  // 那种情况不能算出一条负宽度的条 —— 只在截止处画个短标即可。
  const inverted = bar.startDay >= bar.endDay;
  const leftPct = inverted ? pct(bar.endDay) : pct(bar.startDay);
  const widthPct = inverted ? 0.7 : Math.max(0.4, pct(bar.endDay) - pct(bar.startDay));

  return (
    <div className={`flex items-center rounded hover:bg-zinc-800/40 ${dim ? 'opacity-50' : ''}`}>
      <button
        type="button"
        onClick={() => goItem(bar.itemId)}
        title={`${bar.code} ${bar.title}`}
        className="w-56 shrink-0 truncate pr-2 text-left text-[11px] text-zinc-300 hover:text-zinc-100"
      >
        <span className="font-mono text-zinc-500">{bar.code}</span> {bar.title}
      </button>

      <div className="relative h-6 flex-1">
        {/* 今天这条竖线：每行画一段，视觉上连成一条 */}
        <div
          className="absolute inset-y-0 w-px bg-zinc-400/60"
          style={{ left: `${pct(todayDay)}%` }}
        />

        {/* 主条：创建日 → 下一个 DDL */}
        <div
          className={`absolute top-2 h-2 rounded-sm ${barColor}`}
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
        {bar.milestones.map((m) => (
          <div
            key={m.stageId}
            title={`${m.name} 阶段 DDL ${m.plannedEnd}`}
            className="absolute top-[7px] h-[6px] w-[6px] rotate-45 bg-zinc-200/80"
            style={{ left: `calc(${pct(m.day)}% - 3px)` }}
          />
        ))}
      </div>

      <div className="w-20 shrink-0 pl-2 text-right text-[10px] leading-tight">
        <div className="text-zinc-500">{bar.nextDdl.slice(5).replace('-', '/')}</div>
        <div className={bar.overdueDays > 0 ? 'text-rose-300' : 'text-zinc-500'}>
          {bar.overdueDays > 0 ? `逾期 ${bar.overdueDays} 天` : `${daysLeft} 天`}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分桶明细
// ---------------------------------------------------------------------------

function Section({ section }: { section: DashboardSection }) {
  return (
    <section id={`bucket-${section.key}`} className="scroll-mt-4">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className={`text-sm font-medium ${ACCENT[section.key] ?? 'text-zinc-200'}`}>
          {section.title}
        </h2>
        <span className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-400">
          {section.cards.length}
        </span>
        <span className="text-xs text-zinc-600">{section.sortHint}</span>
      </div>

      <ul className="divide-y divide-zinc-800/70 rounded border border-zinc-800">
        {section.cards.map((card) => (
          <li
            key={card.itemId}
            onClick={() => goItem(card.itemId)}
            className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-zinc-800/50"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {card.pinned === 'top' && <span className="text-xs text-amber-300">置顶</span>}
                {card.pinned === 'bottom' && <span className="text-xs text-zinc-500">置底</span>}
                <span className="font-mono text-xs text-zinc-500">{card.code}</span>
                <span className="truncate text-zinc-100">{card.title}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-400">
                <span className="text-zinc-300">{card.reason}</span>
                <span className="text-zinc-600">·</span>
                <span>{card.currentStage ?? '无进行中阶段'}</span>
                <span className="text-zinc-600">·</span>
                <span>DDL {card.nextDdl ?? '未设'}</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {card.criticality >= 4 && (
                <span className="text-xs text-rose-300" title={`关键度 ${card.criticality}`}>
                  {'★'.repeat(card.criticality - 3)}
                </span>
              )}
              <RoleBadge role={card.role} />
              <ConditionBadge condition={card.condition} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Hint({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return (
    <div className={`px-6 py-8 text-sm ${tone === 'error' ? 'text-amber-300' : 'text-zinc-500'}`}>
      {children}
    </div>
  );
}
