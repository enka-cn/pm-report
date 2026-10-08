import type { ItemCondition, ProjectKind, Role, StageKind } from '@manager/shared';
import { useMeta } from '../lib/meta';

const CONDITION_TONE: Record<ItemCondition, string> = {
  normal: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  blocked: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  suspended: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  closed: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/30',
};

const STAGE_KIND_TONE: Record<StageKind, string> = {
  work: 'text-zinc-400',
  review: 'text-violet-300',
  wait: 'text-amber-300',
  milestone: 'text-emerald-300',
};

export function ConditionBadge({ condition }: { condition: ItemCondition }) {
  const meta = useMeta();
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ring-1 ring-inset ${CONDITION_TONE[condition]}`}
    >
      {meta.data?.conditions[condition] ?? condition}
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  const meta = useMeta();
  return (
    <span className="inline-flex items-center rounded bg-zinc-700/50 px-1.5 py-0.5 text-xs text-zinc-300">
      {meta.data?.roles[role] ?? role}
    </span>
  );
}

export function StageKindLabel({ kind }: { kind: StageKind }) {
  const meta = useMeta();
  return (
    <span className={`text-xs ${STAGE_KIND_TONE[kind]}`}>
      {meta.data?.stageKinds[kind] ?? kind}
    </span>
  );
}

const PROJECT_KIND_TONE: Record<ProjectKind, string> = {
  delivery: 'bg-zinc-700/50 text-zinc-300',
  caretaking: 'bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-500/30',
};

export function ProjectKindBadge({ kind }: { kind: ProjectKind }) {
  const meta = useMeta();
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${PROJECT_KIND_TONE[kind]}`}>
      {meta.data?.projectKinds[kind] ?? kind}
    </span>
  );
}
