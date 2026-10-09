import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PipelineStageDef, PipelineTemplate, Role, StageKind } from '@manager/shared';
import { api } from '../api';
import { messageOf, useNotice } from '../lib/notice';
import { useMeta } from '../lib/meta';
import { Field, Hint, Panel, btnDanger, btnGhost, btnPrimary, inputCls } from './ui';

/**
 * 流水线定制。
 *
 * 流水线是**配置**不是代码，所以「加一条流程」「把某个阶段拆开」不该需要改仓库。
 * 页面写回的就是 `config/pipelines/*.yaml` —— 那个文件始终是真相源，
 * 界面只是它的一个编辑器；你也可以直接改文件，刷新一下就看到了。
 */
export function Pipelines() {
  const queryClient = useQueryClient();
  const meta = useMeta();
  const notice = useNotice();

  const list = useQuery({ queryKey: ['pipelines'], queryFn: api.pipelines });
  const templates = list.data?.pipelines ?? [];

  /** 编辑中的草稿。它是**副本** —— 没点保存之前不动文件 */
  const [draft, setDraft] = useState<PipelineTemplate | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const roleLabel = (r: Role): string => meta.data?.roles[r] ?? r;

  function select(t: PipelineTemplate): void {
    setDraft({ ...t, stages: t.stages.map((s) => ({ ...s, todos: [...(s.todos ?? [])] })) });
    setIsNew(false);
    setError(null);
  }

  function startNew(): void {
    setDraft({
      key: '',
      name: '',
      role: (Object.keys(meta.data?.roles ?? {})[0] as Role) ?? 'dev',
      stages: [{ key: 'step1', name: '第一步', kind: 'work', todos: [] }],
    });
    setIsNew(true);
    setError(null);
  }

  /** 改草稿的某个阶段 */
  function patchStage(index: number, patch: Partial<PipelineStageDef>): void {
    setDraft((d) => {
      if (!d) return d;
      const stages = d.stages.map((s, i) => (i === index ? { ...s, ...patch } : s));
      return { ...d, stages };
    });
  }

  function moveStage(index: number, delta: number): void {
    setDraft((d) => {
      if (!d) return d;
      const to = index + delta;
      if (to < 0 || to >= d.stages.length) return d;
      const stages = [...d.stages];
      const [moved] = stages.splice(index, 1);
      stages.splice(to, 0, moved!);
      return { ...d, stages };
    });
  }

  async function save(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const { pipelines } = await api.savePipeline(draft.key, {
        name: draft.name,
        role: draft.role,
        stages: draft.stages,
      });
      await queryClient.invalidateQueries();
      setIsNew(false);
      const saved = pipelines.find((t) => t.key === draft.key);
      if (saved) select(saved);
      notice.ok(`已保存「${draft.name}」—— 新建需求时立刻就能选到它`);
    } catch (err) {
      // 就地显示，不弹 toast：这是表单，错误该长在表单上
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!draft || isNew) return;
    const sameRole = templates.filter((t) => t.role === draft.role && t.key !== draft.key);
    const ok = window.confirm(
      `删掉「${draft.name}」？\n\n` +
        `已经用这条流水线建过的需求不受影响 —— 它们的阶段在建的时候就实例化好了，\n` +
        `改模板不会回头改历史。\n\n` +
        (sameRole.length === 0
          ? `注意：它是「${roleLabel(draft.role)}」角色唯一的一条，删掉之后新建需求时\n就没有这个角色可选了。`
          : `「${roleLabel(draft.role)}」角色还剩 ${sameRole.length} 条，不受影响。`),
    );
    if (!ok) return;

    setBusy(true);
    try {
      await api.deletePipeline(draft.key);
      await queryClient.invalidateQueries();
      setDraft(null);
      notice.ok(`已删除「${draft.name}」`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-base text-zinc-100">流水线定制</h1>
        <Hint>
          改的是 <code className="text-zinc-400">config/pipelines/*.yaml</code> ——
          那个文件始终是真相源，直接改它也行。改完**立刻生效**，不用重启
        </Hint>
        <button className={`${btnPrimary} ml-auto`} onClick={startNew}>
          ＋ 新建流水线
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
        {/* 左：现有流水线 */}
        <div className="space-y-2">
          {templates.map((t) => (
            <button
              key={t.key}
              onClick={() => select(t)}
              className={`w-full rounded border px-3 py-2 text-left ${
                draft?.key === t.key && !isNew
                  ? 'border-sky-500/60 bg-sky-950/30'
                  : 'border-zinc-800 hover:border-zinc-600'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-100">{t.name}</span>
                <span className="ml-auto rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400">
                  {roleLabel(t.role)}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-zinc-600">{t.key}</div>
              <div className="mt-1 text-[11px] text-zinc-500">
                {t.stages.map((s) => s.name).join(' → ')}
              </div>
            </button>
          ))}
        </div>

        {/* 右：编辑器 */}
        {!draft ? (
          <Panel title="选一条流水线">
            <Hint>左边点一条来改，或者新建一条。</Hint>
            <p className="mt-2 text-xs text-zinc-500">
              已经用某条流水线建过的需求**不受改动影响** —— 阶段在建立那一刻就实例化好了，
              改模板不会回头改历史。所以你可以放心改。
            </p>
          </Panel>
        ) : (
          <Panel
            title={isNew ? '新建流水线' : `编辑「${draft.name || draft.key}」`}
            extra={
              <div className="flex items-center gap-2">
                <button className={btnPrimary} disabled={busy} onClick={() => void save()}>
                  {busy ? '保存中…' : '保存'}
                </button>
                {!isNew && (
                  <button className={btnDanger} disabled={busy} onClick={() => void remove()}>
                    删除
                  </button>
                )}
                <button
                  className={btnGhost}
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                >
                  关闭
                </button>
              </div>
            }
          >
            {error && (
              <div className="mb-3 rounded border border-rose-800 bg-rose-950/40 px-2 py-1.5 text-xs text-rose-300">
                {error}
              </div>
            )}

            <div className="flex flex-wrap items-end gap-3">
              <Field label="名称">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="例如：开发热修"
                  className={`${inputCls} w-52 text-sm`}
                />
              </Field>

              <Field label="角色">
                <select
                  value={draft.role}
                  onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}
                  className={`${inputCls} text-sm`}
                >
                  {Object.entries(meta.data?.roles ?? {}).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="key（就是文件名，建了之后不能改）">
                <input
                  value={draft.key}
                  disabled={!isNew}
                  onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                  placeholder="例如：dev_hotfix"
                  className={`${inputCls} w-40 font-mono text-sm disabled:opacity-60`}
                />
              </Field>
            </div>

            <p className="mt-2 text-[11px] text-zinc-500">
              角色目前只有这几种（它同时是数据库里的约束）。要加第四种得改代码，
              见设计文档 §5.0 —— 只加流水线不用。
            </p>

            <div className="mt-4 space-y-2">
              {draft.stages.map((stage, i) => (
                <StageRow
                  key={i}
                  index={i}
                  total={draft.stages.length}
                  stage={stage}
                  kindLabels={meta.data?.stageKinds ?? {}}
                  onPatch={(patch) => patchStage(i, patch)}
                  onMove={(d) => moveStage(i, d)}
                  onRemove={() =>
                    setDraft({ ...draft, stages: draft.stages.filter((_, j) => j !== i) })
                  }
                />
              ))}
            </div>

            <button
              className={`${btnGhost} mt-2`}
              onClick={() =>
                setDraft({
                  ...draft,
                  stages: [
                    ...draft.stages,
                    { key: `step${draft.stages.length + 1}`, name: '', kind: 'work', todos: [] },
                  ],
                })
              }
            >
              ＋ 加一个阶段
            </button>

            <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-500">
              保存后的链路：
              <span className="ml-1 text-zinc-300">
                {draft.stages.map((s) => s.name || '(未命名)').join(' → ') || '(还没有阶段)'}
              </span>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

/** 一个阶段的编辑行 */
function StageRow({
  index,
  total,
  stage,
  kindLabels,
  onPatch,
  onMove,
  onRemove,
}: {
  index: number;
  total: number;
  stage: PipelineStageDef;
  kindLabels: Record<string, string>;
  onPatch: (patch: Partial<PipelineStageDef>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-right font-mono text-xs text-zinc-600">{index + 1}</span>

        <input
          value={stage.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="阶段名（会显示在需求上）"
          className={`${inputCls} w-40 py-0.5 text-sm`}
        />

        <select
          value={stage.kind}
          onChange={(e) => onPatch({ kind: e.target.value as StageKind })}
          className={`${inputCls} py-0.5 text-xs`}
        >
          {Object.entries(kindLabels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>

        <input
          value={stage.key}
          onChange={(e) => onPatch({ key: e.target.value })}
          placeholder="key"
          title="阶段 key：出现在事件记录里。改名可以，改 key 要慎重"
          className={`${inputCls} w-32 py-0.5 font-mono text-[11px]`}
        />

        <span className="ml-auto flex items-center gap-1">
          <button
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-30"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            title="上移"
          >
            ↑
          </button>
          <button
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-30"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            title="下移"
          >
            ↓
          </button>
          <button
            className="text-xs text-zinc-600 hover:text-rose-400"
            onClick={onRemove}
            title="删掉这个阶段"
          >
            ✕
          </button>
        </span>
      </div>

      {stage.kind === 'wait' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-7">
          <span className="text-[11px] text-amber-300">
            等待阶段：进入时会自动建一条「我被阻塞」的阻塞
          </span>
          <input
            value={stage.wait_counterparty ?? ''}
            onChange={(e) => onPatch({ wait_counterparty: e.target.value })}
            placeholder="在等谁（必填）"
            className={`${inputCls} w-36 py-0.5 text-xs`}
          />
          <input
            value={stage.wait_for ?? ''}
            onChange={(e) => onPatch({ wait_for: e.target.value })}
            placeholder="等什么（必填）"
            className={`${inputCls} w-36 py-0.5 text-xs`}
          />
        </div>
      )}

      {/* 待办：一行一条。用 textarea 而不是一堆输入框 —— 阶段待办通常是三五条，
          一次看完比一条一个框好改 */}
      <div className="mt-1.5 flex items-start gap-2 pl-7">
        <span className="pt-1 text-[11px] text-zinc-600">待办</span>
        <textarea
          value={(stage.todos ?? []).join('\n')}
          onChange={(e) =>
            onPatch({ todos: e.target.value.split('\n').filter((line) => line.trim() !== '') })
          }
          rows={Math.max(1, (stage.todos ?? []).length)}
          placeholder="一行一条；留空就是不带模板待办"
          className={`${inputCls} min-h-[1.75rem] flex-1 py-0.5 text-xs leading-6`}
        />
      </div>
    </div>
  );
}
