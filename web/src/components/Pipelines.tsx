import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PipelineStageDef, PipelineTemplate, Role, StageKind } from '@manager/shared';
import { api } from '../api';
import { messageOf, useNotice } from '../lib/notice';
import { useMeta } from '../lib/meta';
import { Button, Field, Select, SurfaceCard, inputCls, mono, surface } from './ui';

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
    <div className="mx-auto max-w-[1400px] space-y-4">
      {/* ---- 选择 / 新建 ---- */}
      <div className="flex flex-wrap items-center gap-2">
        {templates.map((t) => {
          const active = draft?.key === t.key && !isNew;
          return (
            <button
              key={t.key}
              onClick={() => select(t)}
              className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                active
                  ? 'border-indigo-500/40 bg-indigo-500/10'
                  : 'border-white/[0.07] bg-[#161C28]/70 hover:border-white/[0.14]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-100">{t.name}</span>
                <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 text-[10px] text-slate-400">
                  {roleLabel(t.role)}
                </span>
              </div>
              <div className="mt-0.5 text-[10px] text-slate-600">
                <span className={mono}>{t.key}</span>
                <span className="ml-2 text-slate-500">
                  {t.stages.map((s) => s.name).join(' → ')}
                </span>
              </div>
            </button>
          );
        })}
        <Button variant="primary" className="ml-auto" onClick={startNew}>
          ＋ 新建流水线
        </Button>
      </div>

      {!draft ? (
        <SurfaceCard>
          <div className="px-4 py-12 text-center text-sm text-slate-500">
            上面点一条流水线来改，或者新建一条。
            <div className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-slate-600">
              已经用某条流水线建过的需求<strong className="text-slate-400">不受改动影响</strong> ——
              阶段在建立那一刻就实例化好了，改模板不会回头改历史。所以你可以放心改。
            </div>
          </div>
        </SurfaceCard>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* ---- 左：基本信息 + 阶段卡片流 ---- */}
          <div className="space-y-3 lg:col-span-7">
            <SurfaceCard
              title={isNew ? '新建流水线' : `编辑「${draft.name || draft.key}」`}
              extra={
                <>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
                    {busy ? '保存中…' : '保存'}
                  </Button>
                  {!isNew && (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => void remove()}
                    >
                      删除
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(null);
                      setError(null);
                    }}
                  >
                    关闭
                  </Button>
                </>
              }
            >
              <div className="space-y-3 p-4">
                {error && (
                  <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
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
                    <Select
                      value={draft.role}
                      onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}
                      className="text-sm"
                    >
                      {Object.entries(meta.data?.roles ?? {}).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
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

                <p className="text-[11px] leading-relaxed text-slate-500">
                  角色目前只有这几种（它同时是数据库里的约束）。要加第四种得改代码，
                  见设计文档 §5.0 —— 只加流水线不用。
                </p>
              </div>
            </SurfaceCard>

            <div className="space-y-2">
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

            <Button
              variant="ghost"
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
            </Button>

            <div className={`${surface.inset} px-3 py-2 text-[11px] text-slate-500`}>
              保存后的链路：
              <span className="ml-1 text-slate-300">
                {draft.stages.map((s) => s.name || '(未命名)').join(' → ') || '(还没有阶段)'}
              </span>
            </div>
          </div>

          {/* ---- 右：将写入的 YAML ---- */}
          <div className="lg:col-span-5">
            <div className="sticky top-2">
              <SurfaceCard
                title="将写入的 YAML"
                extra={
                  <span className="text-[10px] text-slate-600">
                    注释由服务端保留，这里只显示字段
                  </span>
                }
              >
                <pre className="max-h-[calc(100vh-240px)] overflow-auto p-4 font-mono text-[11.5px] leading-relaxed text-slate-300">
                  {toYaml(draft)}
                </pre>
              </SurfaceCard>
            </div>
          </div>
        </div>
      )}
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
    <div className={`${surface.card} p-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 font-mono text-[10px] font-semibold text-indigo-300">
          {index + 1}
        </span>

        <input
          value={stage.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="阶段名（会显示在需求上）"
          className={`${inputCls} w-40 py-1 text-sm`}
        />

        <Select
          value={stage.kind}
          onChange={(e) => onPatch({ kind: e.target.value as StageKind })}
          className="py-1 text-xs"
        >
          {Object.entries(kindLabels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>

        <input
          value={stage.key}
          onChange={(e) => onPatch({ key: e.target.value })}
          placeholder="key"
          title="阶段 key：出现在事件记录里。改名可以，改 key 要慎重"
          className={`${inputCls} w-32 py-1 font-mono text-[11px]`}
        />

        <span className="ml-auto flex items-center gap-1">
          <button
            className="rounded p-1 text-xs text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            title="上移"
          >
            ↑
          </button>
          <button
            className="rounded p-1 text-xs text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            title="下移"
          >
            ↓
          </button>
          <button
            className="rounded p-1 text-xs text-slate-600 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
            onClick={onRemove}
            title="删掉这个阶段"
          >
            ✕
          </button>
        </span>
      </div>

      {stage.kind === 'wait' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
          <span className="text-[11px] text-amber-300">
            等待阶段：进入时会自动建一条「我被阻塞」的阻塞
          </span>
          <input
            value={stage.wait_counterparty ?? ''}
            onChange={(e) => onPatch({ wait_counterparty: e.target.value })}
            placeholder="在等谁（必填）"
            className={`${inputCls} w-36 py-1 text-xs`}
          />
          <input
            value={stage.wait_for ?? ''}
            onChange={(e) => onPatch({ wait_for: e.target.value })}
            placeholder="等什么（必填）"
            className={`${inputCls} w-36 py-1 text-xs`}
          />
        </div>
      )}

      {/* 待办：一行一条。用 textarea 而不是一堆输入框 —— 阶段待办通常是三五条，
          一次看完比一条一个框好改 */}
      <div className="mt-2 flex items-start gap-2 pl-7">
        <span className="pt-1.5 text-[11px] text-slate-600">待办</span>
        <textarea
          value={(stage.todos ?? []).join('\n')}
          onChange={(e) =>
            onPatch({ todos: e.target.value.split('\n').filter((line) => line.trim() !== '') })
          }
          rows={Math.max(1, (stage.todos ?? []).length)}
          placeholder="一行一条；留空就是不带模板待办"
          className={`${inputCls} min-h-[1.75rem] flex-1 py-1 text-xs leading-6`}
        />
      </div>
    </div>
  );
}

/**
 * 把草稿渲染成「将要写入的字段」。
 *
 * 只是**预览** —— 真正的写盘由服务端用 yaml 库做，那边会保住文件里的注释。
 * 所以这里不需要（也不该）追求和文件逐字节一致，只要让人看清字段结构。
 * 值里有特殊字符时加引号，否则预览会显示成坏的 YAML，反而误导。
 */
function toYaml(t: PipelineTemplate): string {
  const q = (v: string): string =>
    v === '' || /[:#{}[\],&*?|>'"%@`]/.test(v) || /^[-?\s]/.test(v)
      ? JSON.stringify(v)
      : v;

  const lines = [`key: ${q(t.key)}`, `name: ${q(t.name)}`, `role: ${q(t.role)}`, 'stages:'];

  for (const s of t.stages) {
    lines.push(`  - key: ${q(s.key)}`, `    name: ${q(s.name)}`, `    kind: ${s.kind}`);
    if (s.kind === 'wait') {
      lines.push(`    wait_counterparty: ${q(String(s.wait_counterparty ?? ''))}`);
      lines.push(`    wait_for: ${q(String(s.wait_for ?? ''))}`);
    }
    if (s.todos && s.todos.length > 0) {
      lines.push('    todos:');
      for (const td of s.todos) lines.push(`      - ${q(td)}`);
    }
  }
  return lines.join('\n');
}
