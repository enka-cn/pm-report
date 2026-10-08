import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeliverableCategory,
  EventRow,
  ItemDetail as ItemData,
  StageRow,
} from '@manager/shared';
import { api, newDeliverableForm } from '../api';
import { useMeta } from '../lib/meta';
import { messageOf, useNotice } from '../lib/notice';
import { navigate } from '../lib/router';
import { fmtDay, fmtTime, toDateInput } from '../lib/format';
import { ConditionBadge, RoleBadge, StageKindLabel } from './Badges';
import { Field, Hint, Panel, PromptRow, btnDanger, btnGhost, btnPrimary, inputCls } from './ui';

export function ItemDetail({ id, stageId }: { id: number; stageId: number | null }) {
  const queryClient = useQueryClient();
  const notice = useNotice();

  const q = useQuery({ queryKey: ['item', id], queryFn: () => api.item(id) });

  async function act<T>(fn: () => Promise<T>, success?: (r: T) => string): Promise<void> {
    try {
      const r = await fn();
      // 任何变更都可能影响驾驶舱与列表，统一失效；本地库很小，重取代价可忽略
      await queryClient.invalidateQueries();
      if (success) notice.ok(success(r));
    } catch (err) {
      notice.fail(messageOf(err));
    }
  }

  if (q.isLoading) return <Hint>加载中…</Hint>;
  if (q.error) return <Hint tone="error">{messageOf(q.error)}</Hint>;

  const detail = q.data;
  if (!detail) return <Hint>需求不存在。</Hint>;

  const { item } = detail;
  const selected =
    detail.stages.find((s) => s.id === (stageId ?? item.active_stage_id)) ?? detail.stages[0];

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-5">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => navigate({ name: 'dashboard' })}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          ← 驾驶舱
        </button>
        <span className="font-mono text-sm text-zinc-500">{item.code}</span>
        <h1 className="text-base text-zinc-100">{item.title}</h1>
        <RoleBadge role={item.role} />
        <ConditionBadge condition={item.condition} />

        {/* 默认项目是隐形的；只在归属于某个真实项目时才显示 */}
        {detail.project.is_default === 0 && (
          <button
            onClick={() => navigate({ name: 'projects', projectId: detail.project.id })}
            title={`所属项目：${detail.project.name}`}
            className="rounded bg-sky-500/10 px-1.5 py-0.5 text-xs text-sky-300 hover:bg-sky-500/20"
          >
            {detail.project.code} {detail.project.name}
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            整体 DDL
            <input
              type="date"
              value={toDateInput(item.due_at)}
              onChange={(e) =>
                void act(() => api.setItemDue(item.id, e.target.value || null))
              }
              className={`${inputCls} text-xs`}
            />
          </label>

          {item.closed_at ? (
            <button
              className={btnGhost}
              onClick={() => void act(() => api.reopenItem(item.id), () => `${item.code} 已重开`)}
            >
              重开
            </button>
          ) : (
            <>
              <SuspendControls detail={detail} act={act} />
              <button
                className={btnDanger}
                onClick={() =>
                  void act(
                    () => api.closeItem(item.id, 'cancelled'),
                    () => `${item.code} 已取消`,
                  )
                }
              >
                取消需求
              </button>
              <button
                className={btnGhost}
                onClick={() =>
                  void act(
                    () => api.closeItem(item.id, 'done', undefined, true),
                    () => `${item.code} 已完成`,
                  )
                }
              >
                标记完成
              </button>
            </>
          )}
        </div>
      </header>

      <div className="grid grid-cols-[260px_minmax(0,1fr)_320px] gap-4">
        <div>
          <Panel title="流水线">
            <StagePipeline detail={detail} selectedId={selected?.id ?? null} />
          </Panel>
        </div>

        <div className="space-y-4">
          {selected ? (
            <StagePanel detail={detail} stage={selected} act={act} />
          ) : (
            <Hint>这个需求没有阶段。</Hint>
          )}
        </div>

        <div className="space-y-4">
          <BlockersPanel detail={detail} act={act} />
          <NotePanel detail={detail} act={act} />
          <TimelinePanel itemId={item.id} stages={detail.stages} />
        </div>
      </div>
    </div>
  );
}

type Act = <T>(fn: () => Promise<T>, success?: (r: T) => string) => Promise<void>;

// ---------------------------------------------------------------------------

function SuspendControls({ detail, act }: { detail: ItemData; act: Act }) {
  const [asking, setAsking] = useState(false);
  const suspended = detail.item.suspended_at !== null;

  if (suspended) {
    return (
      <button
        className={btnGhost}
        onClick={() =>
          void act(() => api.resumeItem(detail.item.id), () => `${detail.item.code} 已恢复`)
        }
      >
        恢复
      </button>
    );
  }

  if (!asking) {
    return (
      <button className={btnGhost} onClick={() => setAsking(true)}>
        挂起
      </button>
    );
  }

  return (
    <PromptRow
      placeholder="挂起原因（会写进事件日志）"
      onCancel={() => setAsking(false)}
      onConfirm={(reason) => {
        setAsking(false);
        void act(() => api.suspendItem(detail.item.id, reason), () => `已挂起：${reason}`);
      }}
    />
  );
}

function StagePipeline({ detail, selectedId }: { detail: ItemData; selectedId: number | null }) {
  return (
    <div className="space-y-1">
      {detail.stages.map((s) => {
        const isActive = s.id === detail.item.active_stage_id;
        const chosen = s.id === selectedId;
        const todos = detail.todos.filter((t) => t.stage_id === s.id);
        const done = todos.filter((t) => t.done === 1).length;

        return (
          <button
            key={s.id}
            onClick={() => navigate({ name: 'item', id: detail.item.id, stageId: s.id })}
            className={`w-full rounded border px-2 py-1.5 text-left ${
              chosen ? 'border-zinc-500 bg-zinc-800' : 'border-zinc-800 hover:border-zinc-600'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-zinc-600">{s.seq}</span>
              <span
                className={`truncate text-sm ${
                  isActive ? 'text-zinc-100' : s.actual_end_at ? 'text-zinc-500' : 'text-zinc-400'
                }`}
              >
                {s.name}
              </span>
              {isActive && <span className="ml-auto shrink-0 text-xs text-emerald-300">进行中</span>}
              {s.suspended_at && <span className="ml-auto shrink-0 text-xs text-sky-300">挂起</span>}
              {!isActive && s.outcome === 'completed' && (
                <span className="ml-auto shrink-0 text-xs text-zinc-600">✓</span>
              )}
              {s.outcome === 'skipped' && (
                <span className="ml-auto shrink-0 text-xs text-zinc-600">跳过</span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
              <StageKindLabel kind={s.kind} />
              <span>DDL {fmtDay(s.planned_end)}</span>
              {todos.length > 0 && (
                <span>
                  {done}/{todos.length}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

function StagePanel({ detail, stage, act }: { detail: ItemData; stage: StageRow; act: Act }) {
  const stageTodos = detail.todos.filter((t) => t.stage_id === stage.id);
  const stageDeliverables = detail.deliverables.filter((d) => d.stage_id === stage.id);
  const missingRequired = stageDeliverables.filter(
    (d) => d.required === 1 && d.current_version_id === null,
  );
  const openTodos = stageTodos.filter((t) => t.done === 0);

  // 这两条和服务端 stageAdvanceBlockers 的判断一致：预览和执行必须是同一件事
  const pending: string[] = [];
  if (missingRequired.length > 0) {
    pending.push(`必交交付物未上传：${missingRequired.map((d) => d.name).join('、')}`);
  }
  if (openTodos.length > 0) pending.push(`${openTodos.length} 项待办未完成`);

  const isActive = stage.id === detail.item.active_stage_id;
  const finished = stage.actual_end_at !== null;

  return (
    <>
      <Panel
        title={`阶段：${stage.name}`}
        extra={
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            阶段 DDL
            <input
              type="date"
              value={toDateInput(stage.planned_end)}
              onChange={(e) =>
                void act(() =>
                  api.setStageDue(stage.id, e.target.value || null).then(() => undefined),
                )
              }
              className={`${inputCls} text-xs`}
            />
          </label>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
          <StageKindLabel kind={stage.kind} />
          <span>开始 {fmtTime(stage.actual_start_at)}</span>
          <span>结束 {fmtTime(stage.actual_end_at)}</span>
          {stage.outcome && (
            <span className="text-zinc-400">
              {stage.outcome === 'completed' ? '已完成' : `已跳过：${stage.skip_reason}`}
            </span>
          )}
          {stage.wait_for && (
            <span className="text-amber-300">
              等 {stage.wait_counterparty} 的「{stage.wait_for}」
            </span>
          )}
        </div>

        <Panel title="待办（阶段的退出标准）">
          <TodoList detail={detail} stage={stage} todos={stageTodos} act={act} />
        </Panel>

        <div className="mt-3">
          <Panel title="交付物">
            <DeliverableList detail={detail} stage={stage} items={stageDeliverables} act={act} />
          </Panel>
        </div>

        {!finished && (
          <div className="mt-3">
            {pending.length > 0 && (
              <div className="mb-2 rounded border border-amber-800/60 bg-amber-900/10 px-2 py-1.5 text-xs text-amber-300">
                {pending.join('；')}
              </div>
            )}
            {isActive ? (
              <AdvanceControls stage={stage} pending={pending} act={act} />
            ) : (
              <div className="text-xs text-zinc-500">
                这个阶段还没轮到你 —— 推进要按顺序来。当前进行中的是「
                {detail.stages.find((s) => s.id === detail.item.active_stage_id)?.name ?? '无'}
                」。
              </div>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}

function TodoList({
  detail,
  stage,
  todos,
  act,
}: {
  detail: ItemData;
  stage: StageRow;
  todos: ItemData['todos'];
  act: Act;
}) {
  const [text, setText] = useState('');

  async function add(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!text.trim()) return;
    const value = text;
    setText('');
    await act(
      () => api.addTodo({ itemId: detail.item.id, stageId: stage.id, text: value }),
      () => `已加待办：${value}`,
    );
  }

  return (
    <div>
      {todos.length === 0 && <div className="text-xs text-zinc-500">这个阶段没有待办。</div>}

      <ul className="space-y-1">
        {todos.map((t) => (
          <li key={t.id} className="group flex items-center gap-2">
            <input
              type="checkbox"
              checked={t.done === 1}
              onChange={(e) =>
                void act(() => api.setTodoDone(t.id, e.target.checked).then(() => undefined))
              }
            />
            <span className={t.done === 1 ? 'text-sm text-zinc-500 line-through' : 'text-sm text-zinc-200'}>
              {t.text}
            </span>
            {t.due_at && <span className="text-xs text-zinc-500">截止 {t.due_at}</span>}
            {t.source === 'template' && (
              <span
                className="text-[10px] text-zinc-600"
                title="模板带来的待办。如果一直用不上，改 config/pipelines/*.yaml 里的 todos 就不会再生成"
              >
                模板
              </span>
            )}
            <button
              type="button"
              title="删除这条待办（会在时间线留痕）"
              onClick={() =>
                void act(
                  () => api.removeTodo(t.id).then(() => undefined),
                  () => `已删除待办：${t.text}`,
                )
              }
              className="ml-auto rounded px-1.5 text-xs leading-none text-zinc-600 transition hover:bg-rose-900/40 hover:text-rose-300"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={add} className="mt-2 flex items-center gap-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="加一条待办"
          className={`${inputCls} flex-1 text-xs`}
        />
        <button type="submit" className={btnGhost}>
          添加
        </button>
      </form>

      <p className="mt-2 text-xs text-zinc-600">
        勾完待办不等于阶段完成 —— 阶段要靠下面的「推进」显式确认。
      </p>
    </div>
  );
}

function DeliverableList({
  detail,
  stage,
  items,
  act,
}: {
  detail: ItemData;
  stage: StageRow;
  items: ItemData['deliverables'];
  act: Act;
}) {
  const meta = useMeta();
  const notice = useNotice();
  const [target, setTarget] = useState<string>('new'); // 'new' 或交付物 id
  const [name, setName] = useState('');
  const [category, setCategory] = useState<DeliverableCategory>('doc');
  const [required, setRequired] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const result =
        target === 'new'
          ? await api.uploadDeliverable(
              newDeliverableForm({
                itemId: detail.item.id,
                stageId: stage.id,
                name: name.trim() || file.name,
                category,
                required,
                file,
              }),
            )
          : await api.addDeliverableVersion(
              Number(target),
              (() => {
                const fd = new FormData();
                fd.set('file', file);
                return fd;
              })(),
            );

      setFile(null);
      setName('');
      await act(
        async () => result,
        (r) =>
          `${r.name} v${r.versions[0]?.version_no ?? 1}${
            r.deduplicated ? '（内容已存在，复用同一份文件）' : ''
          }`,
      );
    } catch (err) {
      notice.fail(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {items.length === 0 && <div className="text-xs text-zinc-500">这个阶段还没有交付物。</div>}

      <ul className="space-y-2">
        {items.map((d) => {
          const current = d.versions.find((v) => v.id === d.current_version_id) ?? d.versions[0];
          const missing = d.required === 1 && d.current_version_id === null;
          return (
            <li key={d.id} className="rounded border border-zinc-800 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-200">{d.name}</span>
                <span className="text-xs text-zinc-500">
                  {meta.data?.categories[d.category] ?? d.category}
                </span>
                {d.required === 1 && (
                  <span className={missing ? 'text-xs text-amber-300' : 'text-xs text-zinc-500'}>
                    必交{missing ? '（未上传）' : ''}
                  </span>
                )}
                <span className="ml-auto text-xs text-zinc-500">
                  {d.versions.length} 个版本
                </span>
              </div>
              {current && (
                <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                  <span>v{current.version_no}</span>
                  <a
                    className="text-sky-400 hover:text-sky-300"
                    href={`/api/files/${current.sha256}`}
                  >
                    {current.original_filename}
                  </a>
                  <span>{(current.size_bytes / 1024).toFixed(1)} KB</span>
                  <span>{fmtTime(current.uploaded_at)}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <form onSubmit={upload} className="mt-3 space-y-2 rounded border border-zinc-800 p-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="目标">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={`${inputCls} text-xs`}
            >
              <option value="new">＋ 新建交付物</option>
              {items.map((d) => (
                <option key={d.id} value={d.id}>
                  给「{d.name}」加版本
                </option>
              ))}
            </select>
          </Field>

          {target === 'new' && (
            <>
              <Field label="名称">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="留空用文件名"
                  className={`${inputCls} w-40 text-xs`}
                />
              </Field>

              <Field label="分类">
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as DeliverableCategory)}
                  className={`${inputCls} text-xs`}
                >
                  {Object.entries(meta.data?.categories ?? {}).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>

              <label className="flex items-center gap-1 pb-1 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(e) => setRequired(e.target.checked)}
                />
                必交项（未上传会卡住阶段推进）
              </label>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="file"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-xs text-zinc-400"
          />
          <button type="submit" disabled={busy || !file} className={btnGhost}>
            {busy ? '上传中…' : '上传'}
          </button>
        </div>
      </form>
    </div>
  );
}

function AdvanceControls({
  stage,
  pending,
  act,
}: {
  stage: StageRow;
  pending: string[];
  act: Act;
}) {
  const [skipping, setSkipping] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const [forced, setForced] = useState(false);
  const [forceReason, setForceReason] = useState('');

  const blocked = pending.length > 0 && (!forced || !forceReason.trim());
  const skipBlocked = skipping && !skipReason.trim();

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const outcome = skipping ? 'skipped' : 'completed';
    await act(
      () =>
        api.advanceStage(stage.id, {
          outcome,
          skipReason: skipping ? skipReason : undefined,
          forced: forced || undefined,
          reason: forceReason.trim() || undefined,
        }),
      (r) =>
        `${r.result.fromStageName} → ${r.result.toStageName ?? '（已是最后一个阶段）'}${
          r.result.closedBlockerIds.length > 0
            ? `，顺带解除 ${r.result.closedBlockerIds.length} 条阻塞`
            : ''
        }`,
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-zinc-800 p-2">
      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1 text-zinc-300">
          <input type="radio" checked={!skipping} onChange={() => setSkipping(false)} />
          标记完成并推进
        </label>
        <label className="flex items-center gap-1 text-zinc-300">
          <input type="radio" checked={skipping} onChange={() => setSkipping(true)} />
          跳过这个阶段
        </label>
      </div>

      {skipping && (
        <input
          value={skipReason}
          onChange={(e) => setSkipReason(e.target.value)}
          placeholder="跳过原因（必填）"
          className={`${inputCls} w-full text-xs`}
        />
      )}

      {pending.length > 0 && (
        <div className="space-y-1">
          <label className="flex items-center gap-1 text-xs text-amber-300">
            <input
              type="checkbox"
              checked={forced}
              onChange={(e) => setForced(e.target.checked)}
            />
            强制推进（会记进事件日志）
          </label>
          {forced && (
            <input
              value={forceReason}
              onChange={(e) => setForceReason(e.target.value)}
              placeholder="强制推进的原因（必填）"
              className={`${inputCls} w-full text-xs`}
            />
          )}
        </div>
      )}

      <button type="submit" disabled={blocked || skipBlocked} className={btnPrimary}>
        推进
      </button>

      {/* 上面那条黄框已经列清了「什么没完成」；这里只在还缺输入时补一句 */}
      {blocked && forced && (
        <p className="text-xs text-amber-300">强制推进必须写明原因。</p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------

function BlockersPanel({ detail, act }: { detail: ItemData; act: Act }) {
  const meta = useMeta();
  const [adding, setAdding] = useState(false);
  const [resolving, setResolving] = useState<number | null>(null);
  const open = detail.blockers.filter((b) => b.closed_at === null);

  return (
    <Panel
      title={`阻塞（${open.length} 条未解除）`}
      extra={
        <button className={btnGhost} onClick={() => setAdding((v) => !v)}>
          {adding ? '取消' : '＋ 记录'}
        </button>
      }
    >
      {open.length === 0 && <div className="text-xs text-zinc-500">当前没有未解除的阻塞。</div>}

      <ul className="space-y-2">
        {open.map((b) => (
          <li key={b.id} className="rounded border border-zinc-800 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span
                className={`text-xs ${
                  b.direction === 'blocked_by_others' ? 'text-amber-300' : 'text-violet-300'
                }`}
              >
                {meta.data?.directions[b.direction] ?? b.direction}
              </span>
              <span className="text-sm text-zinc-200">{b.counterparty}</span>
              <span className="text-xs text-zinc-500">{fmtTime(b.opened_at)}</span>
            </div>
            <div className="mt-0.5 text-xs text-zinc-400">{b.need}</div>
            {b.promised_at && <div className="text-xs text-zinc-500">承诺 {b.promised_at}</div>}

            {resolving === b.id ? (
              <PromptRow
                placeholder="解除说明"
                confirmText="解除"
                onCancel={() => setResolving(null)}
                onConfirm={(resolution) => {
                  setResolving(null);
                  void act(
                    () => api.closeBlocker(b.id, resolution).then(() => undefined),
                    () => `阻塞已解除：${resolution}`,
                  );
                }}
              />
            ) : (
              <button className={`${btnGhost} mt-1`} onClick={() => setResolving(b.id)}>
                解除
              </button>
            )}
          </li>
        ))}
      </ul>

      {detail.blockers.some((b) => b.closed_at !== null) && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-zinc-500">已解除的历史</summary>
          <ul className="mt-1 space-y-1">
            {detail.blockers
              .filter((b) => b.closed_at !== null)
              .map((b) => (
                <li key={b.id} className="text-xs text-zinc-500">
                  {b.counterparty}：{b.need} → {b.resolution}
                </li>
              ))}
          </ul>
        </details>
      )}

      {adding && <NewBlockerForm detail={detail} act={act} onDone={() => setAdding(false)} />}
    </Panel>
  );
}

function NewBlockerForm({
  detail,
  act,
  onDone,
}: {
  detail: ItemData;
  act: Act;
  onDone: () => void;
}) {
  const meta = useMeta();
  const [direction, setDirection] = useState<'blocked_by_others' | 'blocking_others'>(
    'blocked_by_others',
  );
  const [counterparty, setCounterparty] = useState('');
  const [need, setNeed] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high'>('medium');
  const [promisedAt, setPromisedAt] = useState('');

  return (
    <form
      className="mt-2 space-y-1 rounded border border-zinc-800 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        onDone();
        void act(
          () =>
            api.openBlocker({
              itemId: detail.item.id,
              stageId: detail.item.active_stage_id,
              direction,
              counterparty,
              need,
              severity,
              promisedAt: promisedAt || null,
            }),
          () => `已记录阻塞：${counterparty} — ${need}`,
        );
      }}
    >
      <select
        value={direction}
        onChange={(e) => setDirection(e.target.value as typeof direction)}
        className={`${inputCls} w-full text-xs`}
      >
        {Object.entries(meta.data?.directions ?? {}).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>

      <input
        required
        value={counterparty}
        onChange={(e) => setCounterparty(e.target.value)}
        placeholder="对方（人 / 团队 / 模块）"
        className={`${inputCls} w-full text-xs`}
      />
      <input
        required
        value={need}
        onChange={(e) => setNeed(e.target.value)}
        placeholder="需要什么"
        className={`${inputCls} w-full text-xs`}
      />

      <div className="flex items-center gap-2">
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as typeof severity)}
          className={`${inputCls} text-xs`}
        >
          {Object.entries(meta.data?.severities ?? {}).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={promisedAt}
          onChange={(e) => setPromisedAt(e.target.value)}
          className={`${inputCls} text-xs`}
          title="对方承诺的时间"
        />
        <button type="submit" className={btnGhost}>
          记录
        </button>
      </div>
    </form>
  );
}

function NotePanel({ detail, act }: { detail: ItemData; act: Act }) {
  const [text, setText] = useState('');

  return (
    <Panel title="记一条进展">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          const value = text;
          setText('');
          void act(() => api.note(detail.item.id, value), () => `已记录：${value}`);
        }}
        className="space-y-1"
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="例如：与架构师对齐了鉴权协议"
          className={`${inputCls} w-full resize-y text-xs`}
        />
        <button type="submit" className={btnGhost}>
          记录
        </button>
      </form>
      <p className="mt-1 text-xs text-zinc-600">这些内容会直接出现在汇报草稿的「本区间进展」里。</p>
    </Panel>
  );
}

function TimelinePanel({ itemId, stages }: { itemId: number; stages: StageRow[] }) {
  const q = useQuery({ queryKey: ['timeline', itemId], queryFn: () => api.timeline(itemId) });
  const events = q.data?.events ?? [];

  return (
    <Panel title="时间线">
      {q.isLoading && <div className="text-xs text-zinc-500">加载中…</div>}
      <ul className="space-y-1.5">
        {[...events].reverse().map((e) => (
          <li key={e.id} className="text-xs">
            <span className="text-zinc-500">{fmtTime(e.occurred_at)}</span>{' '}
            <span className="text-zinc-300">{describeEvent(e, stages)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** 把事件翻译成一句人话。汇报将来读的是同一批事件，这里能读通，汇报就能读通。 */
function describeEvent(e: EventRow, stages: StageRow[]): string {
  let p: Record<string, unknown> = {};
  if (e.payload) {
    try {
      p = JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      p = {};
    }
  }
  const stageName = (key: unknown): string => {
    if (typeof key !== 'string') return '?';
    return stages.find((s) => s.key === key)?.name ?? key;
  };
  const note = e.note ? `：${e.note}` : '';

  switch (e.type) {
    case 'item_created':
      return `创建需求（${String(p['pipeline_key'] ?? '')}）`;
    case 'stage_enter':
      return `进入阶段「${stageName(p['stage_key'])}」`;
    case 'stage_exit':
      return `完成阶段「${stageName(p['stage_key'])}」${
        p['to_stage_key'] ? ` → 「${stageName(p['to_stage_key'])}」` : ''
      }${p['forced'] ? '（强制推进）' : ''}${note}`;
    case 'todo_added':
      return `加待办：${String(p['text'] ?? '')}`;
    case 'todo_done':
      return `完成待办：${String(p['text'] ?? '')}`;
    case 'todo_reopened':
      return `重开待办：${String(p['text'] ?? '')}`;
    case 'deliverable_added':
      return `上传交付物「${String(p['name'] ?? '')}」v${String(p['version_no'] ?? 1)}`;
    case 'blocker_open':
      return `记下阻塞：${String(p['counterparty'] ?? '')} — ${String(p['need'] ?? '')}`;
    case 'blocker_close':
      return `解除阻塞：${String(p['counterparty'] ?? '')}（${String(p['resolution'] ?? '')}）`;
    case 'suspend':
      return `挂起${p['scope'] === 'stage' ? `阶段「${stageName(p['stage_key'])}」` : '需求'}${note}`;
    case 'resume':
      return `恢复${p['scope'] === 'stage' ? `阶段「${stageName(p['stage_key'])}」` : '需求'}`;
    case 'item_close':
      return `关闭需求（${p['close_reason'] === 'done' ? '完成' : '取消'}）${note}`;
    case 'item_reopen':
      return '重开需求';
    case 'ddl_change':
      return p['scope'] === 'stage'
        ? `改阶段「${stageName(p['stage_key'])}」DDL`
        : `改整体 DDL`;
    case 'role_change':
      return `角色变更 ${String(p['old_role'] ?? '')} → ${String(p['new_role'] ?? '')}`;
    case 'note':
      return e.note ?? '备注';
    default:
      return e.type;
  }
}
