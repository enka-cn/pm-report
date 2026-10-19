import type { DashboardBucketKey, ItemCondition, ProjectKind, Role, StageKind } from '@manager/shared';
import { useMeta } from '../lib/meta';

/**
 * 状态主题：**圆点 + 低饱和胶囊 + 左侧色条**三件套。
 *
 * 原版是「高亮边框 + 高饱和文字」，多个异常并排时非常刺眼，反而看不出哪个更急。
 * 新版统一降饱和：圆点负责「一眼看到」，胶囊负责「读得清」，胶囊底只有 15% 不透明度。
 *
 * 这里有两张表，因为它们是**两个不同的维度**，不能混：
 *   · CONDITION_THEME —— 需求的状况（4 种，item 只有一个）
 *   · BUCKET_THEME    —— 驾驶舱的分桶（7 种，同一条需求可能同时出现在几个桶里）
 * （设计稿把两者合成了一张 8 键的表，那会让人以为一条需求能同时是「已逾期」和「待排期」。）
 */

export interface ConditionStyle {
  badge: string;
  dot: string;
  /** 卡片左侧 3px 语义色条 */
  borderLeft: string;
}

export const CONDITION_THEME: Record<ItemCondition, ConditionStyle> = {
  normal: {
    badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    dot: 'bg-emerald-400',
    borderLeft: 'border-l-[3px] border-l-emerald-500',
  },
  blocked: {
    badge: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
    dot: 'bg-orange-400',
    borderLeft: 'border-l-[3px] border-l-orange-500',
  },
  suspended: {
    badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    dot: 'bg-sky-400',
    borderLeft: 'border-l-[3px] border-l-sky-400',
  },
  closed: {
    badge: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    dot: 'bg-slate-400',
    borderLeft: 'border-l-[3px] border-l-slate-400',
  },
};

export const BUCKET_THEME: Record<DashboardBucketKey, ConditionStyle> = {
  overdue: {
    badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    dot: 'bg-rose-500',
    borderLeft: 'border-l-[3px] border-l-rose-500',
  },
  due_soon: {
    badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    dot: 'bg-amber-400',
    borderLeft: 'border-l-[3px] border-l-amber-400',
  },
  blocking_others: {
    badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    dot: 'bg-violet-400',
    borderLeft: 'border-l-[3px] border-l-violet-500',
  },
  blocked_by_others: {
    badge: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
    dot: 'bg-orange-400',
    borderLeft: 'border-l-[3px] border-l-orange-500',
  },
  stale: {
    badge: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    dot: 'bg-slate-400',
    borderLeft: 'border-l-[3px] border-l-slate-400',
  },
  no_ddl: {
    badge: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    dot: 'bg-slate-500',
    borderLeft: 'border-l-[3px] border-l-slate-500',
  },
  suspended: {
    badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    dot: 'bg-sky-400',
    borderLeft: 'border-l-[3px] border-l-sky-400',
  },
};

/** 甘特条颜色：按分桶取（时间轴上一眼分得出哪条是红的） */
export const BUCKET_BAR: Record<DashboardBucketKey, string> = {
  overdue: 'bg-rose-500/80 border-rose-400',
  due_soon: 'bg-amber-500/80 border-amber-400',
  blocking_others: 'bg-violet-500/80 border-violet-400',
  blocked_by_others: 'bg-orange-500/80 border-orange-400',
  stale: 'bg-slate-500/70 border-slate-400',
  no_ddl: 'bg-slate-500/50 border-slate-400 border-dashed',
  suspended: 'bg-sky-500/60 border-sky-400',
};

/** 需求状况徽章。文案仍取自服务端（`/api/meta`），只换视觉 */
export function ConditionBadge({ condition }: { condition: ItemCondition }) {
  const meta = useMeta();
  const theme = CONDITION_THEME[condition] ?? CONDITION_THEME.normal;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${theme.badge}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${theme.dot}`} />
      <span>{meta.data?.conditions[condition] ?? condition}</span>
    </span>
  );
}

/** 分桶徽章。桶名由调用方给（驾驶舱的桶名在 `DashboardSection.label` 里） */
export function BucketBadge({ bucket, label }: { bucket: DashboardBucketKey; label: string }) {
  const theme = BUCKET_THEME[bucket];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${theme.badge}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${theme.dot}`} />
      <span>{label}</span>
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  const meta = useMeta();
  return (
    <span className="inline-flex items-center rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-slate-300">
      {meta.data?.roles[role] ?? role}
    </span>
  );
}

const STAGE_KIND_TONE: Record<StageKind, string> = {
  work: 'text-slate-400',
  review: 'text-violet-300',
  wait: 'text-amber-300',
  milestone: 'text-emerald-300',
};

export function StageKindLabel({ kind }: { kind: StageKind }) {
  const meta = useMeta();
  return (
    <span className={`text-xs ${STAGE_KIND_TONE[kind]}`}>
      {meta.data?.stageKinds[kind] ?? kind}
    </span>
  );
}

const PROJECT_KIND_TONE: Record<ProjectKind, string> = {
  delivery: 'border-white/[0.08] bg-white/[0.04] text-slate-300',
  caretaking: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
};

export function ProjectKindBadge({ kind }: { kind: ProjectKind }) {
  const meta = useMeta();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${PROJECT_KIND_TONE[kind]}`}
    >
      {meta.data?.projectKinds[kind] ?? kind}
    </span>
  );
}
