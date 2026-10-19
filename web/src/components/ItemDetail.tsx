import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeliverableCategory,
  EventRow,
  FolderNode,
  ItemDetail as ItemData,
  StageRow,
} from '@manager/shared';
import { api, newDeliverableForm } from '../api';
import { useMeta } from '../lib/meta';
import { messageOf, useNotice } from '../lib/notice';
import { navigate } from '../lib/router';
import { fmtDay, fmtTime, humanSize, toDateInput } from '../lib/format';
import { summarizeDrop, useFileDrop } from '../lib/drop';
import { ConditionBadge, RoleBadge, StageKindLabel } from './Badges';
import { ItemFileTree } from './ItemFileTree';
import { ItemLinks } from './ItemLinks';
import {
  Button,
  Field,
  Hint,
  InlineCode,
  PromptRow,
  Select,
  SurfaceCard,
  inputCls,
  mono,
  surface,
} from './ui';

export function ItemDetail({ id, stageId }: { id: number; stageId: number | null }) {
  const queryClient = useQueryClient();
  const notice = useNotice();
  // 必须在所有提前 return 之前调用 —— hook 数量每次渲染必须一致（踩过 #310 白屏）
  const meta = useMeta();

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

  const detail = q.data;

  // 拖放。**必须在上面那几个提前 return 之前调用** —— hook 的数量每次渲染必须一致，
  // 放在 `if (!detail) return` 后面就会变成「加载中那次不调用、加载完调用」，
  // React 直接抛 #310 白屏，而 tsc 查不出来。
  // 回调要用的数据放 ref：它在 drop 那一刻才跑，拿不到当次渲染的闭包。
  const dropCtx = useRef({
    stages: [] as StageRow[],
    folders: new Map<number, string>(),
    defaultStageId: null as number | null,
  });
  if (detail) {
    dropCtx.current = {
      stages: detail.stages,
      folders: folderNames(detail.tree),
      defaultStageId: stageId ?? detail.item.active_stage_id,
    };
  }

  const drop = useFileDrop((files, target) => {
    const { stages, folders, defaultStageId } = dropCtx.current;

    // 先按体积挡一道，让人立刻知道原因，而不是等一个失败的请求回来
    const maxMb = meta.data?.limits.maxUploadMb ?? 512;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > maxMb * 1024 * 1024) {
      notice.fail(
        `这批文件共 ${humanSize(totalBytes)}，超过了 ${maxMb} MB 的上传上限。` +
          `大文件放共享盘，然后在需求的「链接」里加个入口。要放宽就改 config/settings.yaml 的 upload.max_request_mb。`,
      );
      return;
    }

    // 落在文件夹上时不改阶段：文件和阶段是两个轴，拖进 assets/ 不该让它脱离当前阶段
    const landingStage = target.stageId ?? defaultStageId;
    const where =
      target.folderId !== null
        ? `文件夹「${folders.get(target.folderId) ?? ''}」`
        : `「${stages.find((s) => s.id === landingStage)?.name ?? '不属于任何阶段'}」`;

    void (async () => {
      try {
        const { results } = await api.dropDeliverables(
          id,
          { stageId: landingStage, folderId: target.folderId },
          files,
        );
        const { ok, failed } = summarizeDrop(results);
        if (failed.length > 0) notice.fail(`加入${where}：${ok}\n${failed.join('\n')}`);
        else notice.ok(`加入${where}：${ok}`);
        await queryClient.invalidateQueries();
      } catch (err) {
        notice.fail(messageOf(err));
      }
    })();
  });

  if (q.isLoading) return <Hint>加载中…</Hint>;
  if (q.error) return <Hint tone="error">{messageOf(q.error)}</Hint>;
  if (!detail) return <Hint>需求不存在。</Hint>;

  const { item } = detail;
  const selected =
    detail.stages.find((s) => s.id === (stageId ?? item.active_stage_id)) ?? detail.stages[0];
  const activeStage = detail.stages.find((s) => s.id === item.active_stage_id) ?? null;

  const hoveredFolder = drop.target.folderId === null ? null : folderNames(detail.tree).get(drop.target.folderId);
  const bannerWhere =
    hoveredFolder != null
      ? `文件夹「${hoveredFolder}」`
      : `「${detail.stages.find((s) => s.id === (drop.target.stageId ?? selected?.id))?.name ?? '不属于任何阶段'}」`;

  return (
    <div className="relative mx-auto max-w-[1400px]" {...drop.handlers}>
      {drop.active && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center pt-4">
          <div className="rounded-full border border-indigo-400/40 bg-[#11161F]/95 px-4 py-2 text-sm text-indigo-200 shadow-xl backdrop-blur-md">
            松手即加入{bannerWhere}
            {drop.count > 1 && ` · ${drop.count} 个文件`}
            <span className="ml-2 text-xs text-slate-500">
              悬到某个阶段上可以指定阶段
            </span>
          </div>
        </div>
      )}

      {/* 壳层 header 只显示「需求详情」，实体标题与编号留在这里 */}
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => navigate({ name: 'dashboard' })}
          className="text-xs text-slate-500 transition-colors hover:text-slate-300"
        >
          ← 驾驶舱
        </button>
        <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight text-slate-100">
          {item.title}
        </h1>
        {/* 编号可以没有；点一下就地改 —— 预研转立项时补上真单号就靠这儿 */}
        <InlineCode
          code={item.code}
          onSave={async (next) => {
            await api.setItemCode(item.id, next);
            await queryClient.invalidateQueries();
          }}
        />

        {/* 默认项目是隐形的；只在归属于某个真实项目时才显示 */}
        {detail.project.is_default === 0 && (
          <button
            onClick={() => navigate({ name: 'projects', projectId: detail.project.id })}
            title={`所属项目：${detail.project.name}`}
            className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[11px] text-indigo-300 transition-colors hover:bg-indigo-500/20"
          >
            {detail.project.ref}
          </button>
        )}
      </header>

      {/* 顶部内联属性区：标签 + 值，编辑控件就地保留原有交互 */}
      <section className={`${surface.inset} mb-4 p-3.5`}>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <PropCell label="当前阶段">
            {activeStage ? (
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm text-slate-300">{activeStage.name}</span>
                <StageKindLabel kind={activeStage.kind} />
                {activeStage.suspended_at && (
                  <span className="text-[11px] text-sky-300">挂起</span>
                )}
              </div>
            ) : (
              <span className="text-sm text-slate-500">—</span>
            )}
          </PropCell>

          <PropCell label="异常状态">
            <ConditionBadge condition={item.condition} />
          </PropCell>

          <PropCell label="整体 DDL">
            <input
              type="date"
              value={toDateInput(item.due_at)}
              onChange={(e) =>
                void act(() => api.setItemDue(item.id, e.target.value || null))
              }
              className={`${inputCls} w-full max-w-[11rem] text-xs`}
            />
          </PropCell>

          <PropCell label="责任人与角色">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-300">{item.owner}</span>
              <RoleBadge role={item.role} />
            </div>
          </PropCell>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.07] pt-3">
          {item.closed_at ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void act(() => api.reopenItem(item.id), () => `${item.ref} 已重开`)}
            >
              重开
            </Button>
          ) : (
            <>
              <SuspendControls detail={detail} act={act} />
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  void act(
                    () => api.closeItem(item.id, 'done', undefined, true),
                    () => `${item.ref} 已完成`,
                  )
                }
              >
                标记完成
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() =>
                  void act(
                    () => api.closeItem(item.id, 'cancelled'),
                    () => `${item.ref} 已取消`,
                  )
                }
              >
                取消需求
              </Button>
            </>
          )}
        </div>
      </section>

      <div className="grid grid-cols-[260px_minmax(0,1fr)_320px] gap-4">
        <SurfaceCard title="流水线" className="h-fit">
          <div className="p-2.5">
            <StagePipeline
              detail={detail}
              selectedId={selected?.id ?? null}
              dropTarget={drop.active ? drop.target.stageId : null}
            />
          </div>
        </SurfaceCard>

        <div className="space-y-4">
          {selected ? (
            <StagePanel
              detail={detail}
              stage={selected}
              act={act}
              dropTarget={drop.active ? drop.target.stageId : null}
            />
          ) : (
            <Hint>这个需求没有阶段。</Hint>
          )}
        </div>

        <div className="space-y-4">
          <BlockersPanel detail={detail} act={act} />
          <NotePanel detail={detail} act={act} />
          <ItemLinks detail={detail} act={act} />
          <TimelinePanel itemId={item.id} stages={detail.stages} />
        </div>
      </div>

      {/* 需求级文件树：横跨整幅，因为树是要「找东西」的，窄栏里展不开 */}
      <div className="mt-4">
        <ItemFileTree detail={detail} act={act} />
      </div>
    </div>
  );
}

/** 属性区的一格：11px 标签 + 值。级别靠留白，不靠边框 */
function PropCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/** Level 3 内嵌块：卡片里再分节用它，别再套一张 Level 2 卡片 */
function InsetSection({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={surface.inset}>
      <header className="flex items-center gap-2 border-b border-white/[0.07] px-3.5 py-2">
        <h4 className="text-xs font-semibold tracking-tight text-slate-200">{title}</h4>
        {extra && <div className="ml-auto flex items-center gap-2">{extra}</div>}
      </header>
      <div className="p-3.5">{children}</div>
    </section>
  );
}

/** 文件树里 id → 文件夹名，给拖放提示条用 */
function folderNames(node: FolderNode, into = new Map<number, string>()): Map<number, string> {
  if (node.folder) into.set(node.folder.id, node.folder.name);
  for (const child of node.children) folderNames(child, into);
  return into;
}

type Act = <T>(fn: () => Promise<T>, success?: (r: T) => string) => Promise<void>;

// ---------------------------------------------------------------------------

function SuspendControls({ detail, act }: { detail: ItemData; act: Act }) {
  const [asking, setAsking] = useState(false);
  const suspended = detail.item.suspended_at !== null;

  if (suspended) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          void act(() => api.resumeItem(detail.item.id), () => `${detail.item.ref} 已恢复`)
        }
      >
        恢复
      </Button>
    );
  }

  if (!asking) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
        挂起
      </Button>
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

function StagePipeline({
  detail,
  selectedId,
  dropTarget,
}: {
  detail: ItemData;
  selectedId: number | null;
  dropTarget: number | null;
}) {
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
            data-drop-stage={s.id}
            onClick={() => navigate({ name: 'item', id: detail.item.id, stageId: s.id })}
            className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
              dropTarget === s.id
                ? 'border-indigo-400/70 bg-indigo-500/10 ring-1 ring-indigo-400/40'
                : chosen
                  ? 'border-indigo-400/30 bg-indigo-500/10'
                  : 'border-transparent hover:border-white/[0.08] hover:bg-white/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`${mono} shrink-0`}>{s.seq}</span>
              <span
                className={`truncate text-[13px] ${
                  isActive
                    ? 'font-medium text-slate-100'
                    : s.actual_end_at
                      ? 'text-slate-500'
                      : 'text-slate-300'
                }`}
              >
                {s.name}
              </span>
              {isActive && (
                <span className="ml-auto shrink-0 text-[11px] text-indigo-300">进行中</span>
              )}
              {s.suspended_at && (
                <span className="ml-auto shrink-0 text-[11px] text-sky-300">挂起</span>
              )}
              {!isActive && s.outcome === 'completed' && (
                <span className="ml-auto shrink-0 text-[11px] text-emerald-400/80">✓</span>
              )}
              {s.outcome === 'skipped' && (
                <span className="ml-auto shrink-0 text-[11px] text-slate-500">跳过</span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
              <StageKindLabel kind={s.kind} />
              <span>
                DDL <span className={mono}>{fmtDay(s.planned_end)}</span>
              </span>
              {todos.length > 0 && (
                <span className="font-mono text-[11px] text-slate-500">
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

function StagePanel({
  detail,
  stage,
  act,
  dropTarget,
}: {
  detail: ItemData;
  stage: StageRow;
  act: Act;
  dropTarget: number | null;
}) {
  const stageTodos = detail.todos.filter((t) => t.stage_id === stage.id);
  const stageDeliverables = detail.deliverables.filter((d) => d.stage_id === stage.id);
  const missingRequired = stageDeliverables.filter(
    (d) => d.required === 1 && d.current_version_id === null,
  );
  const openTodos = stageTodos.filter((t) => t.done === 0);
  const doneTodos = stageTodos.length - openTodos.length;

  // 这两条和服务端 stageAdvanceBlockers 的判断一致：预览和执行必须是同一件事
  const pending: string[] = [];
  if (missingRequired.length > 0) {
    pending.push(`必交交付物未上传：${missingRequired.map((d) => d.name).join('、')}`);
  }
  if (openTodos.length > 0) pending.push(`${openTodos.length} 项待办未完成`);

  const isActive = stage.id === detail.item.active_stage_id;
  const finished = stage.actual_end_at !== null;

  return (
    <div
      data-drop-stage={stage.id}
      className={
        dropTarget === stage.id
          ? 'rounded-xl ring-2 ring-indigo-400/50 ring-offset-4 ring-offset-[#0D1117]'
          : undefined
      }
    >
      <SurfaceCard
        title={`阶段：${stage.name}`}
        extra={
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
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
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-500">
            <StageKindLabel kind={stage.kind} />
            <span>
              开始 <span className={mono}>{fmtTime(stage.actual_start_at)}</span>
            </span>
            <span>
              结束 <span className={mono}>{fmtTime(stage.actual_end_at)}</span>
            </span>
            {stage.outcome && (
              <span className="text-slate-500">
                {stage.outcome === 'completed' ? '已完成' : `已跳过：${stage.skip_reason}`}
              </span>
            )}
            {stage.wait_for && (
              <span className="text-amber-300">
                等 {stage.wait_counterparty} 的「{stage.wait_for}」
              </span>
            )}
          </div>

          <InsetSection
            title="待办（阶段的退出标准）"
            extra={
              stageTodos.length > 0 ? (
                <span className="font-mono text-[10px] text-slate-500">
                  {doneTodos}/{stageTodos.length}
                </span>
              ) : undefined
            }
          >
            <TodoList detail={detail} stage={stage} todos={stageTodos} act={act} />
          </InsetSection>

          <InsetSection title="交付物">
            <DeliverableList detail={detail} stage={stage} items={stageDeliverables} act={act} />
          </InsetSection>

          {!finished && (
            <div className="space-y-2">
              {pending.length > 0 && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
                  {pending.join('；')}
                </div>
              )}
              {isActive ? (
                <AdvanceControls stage={stage} pending={pending} act={act} />
              ) : (
                <div className="text-[11px] leading-relaxed text-slate-500">
                  这个阶段还没轮到你 —— 推进要按顺序来。当前进行中的是「
                  {detail.stages.find((s) => s.id === detail.item.active_stage_id)?.name ?? '无'}
                  」。
                </div>
              )}
            </div>
          )}
        </div>
      </SurfaceCard>
    </div>
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
      {todos.length === 0 && <div className="text-[11px] text-slate-500">这个阶段没有待办。</div>}

      <ul className="space-y-0.5">
        {todos.map((t) => (
          <li
            key={t.id}
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-white/[0.04]"
          >
            <input
              type="checkbox"
              checked={t.done === 1}
              onChange={(e) =>
                void act(() => api.setTodoDone(t.id, e.target.checked).then(() => undefined))
              }
              className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-indigo-500"
            />
            <span
              className={
                t.done === 1
                  ? 'text-[13px] text-slate-500 line-through'
                  : 'text-[13px] text-slate-300'
              }
            >
              {t.text}
            </span>
            {t.due_at && (
              <span className="text-[11px] text-slate-500">
                截止 <span className={mono}>{t.due_at}</span>
              </span>
            )}
            {t.source === 'template' && (
              <span
                className="text-[10px] text-slate-500"
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
              className="ml-auto shrink-0 rounded-lg px-1.5 text-xs leading-none text-slate-500 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={add} className="mt-3 flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="加一条待办"
          className={`${inputCls} flex-1 text-xs`}
        />
        <Button type="submit" variant="secondary" size="sm">
          添加
        </Button>
      </form>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
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

    const maxMb = meta.data?.limits.maxUploadMb ?? 512;
    if (file.size > maxMb * 1024 * 1024) {
      notice.fail(
        `「${file.name}」有 ${humanSize(file.size)}，超过了 ${maxMb} MB 的上传上限。` +
          `大文件放共享盘，然后在需求的「链接」里加个入口。要放宽就改 config/settings.yaml 的 upload.max_request_mb。`,
      );
      return;
    }

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
      {/* 拖进来的入口：不用点、不用填，落到这个阶段上 */}
      <div className="mb-3 rounded-lg border border-dashed border-white/[0.12] bg-white/[0.02] px-3 py-2 text-center text-[11px] text-slate-500">
        把文件拖到页面上即加入这个阶段
        <span className="text-slate-600">（悬到流水线里的某个阶段上可指定阶段）</span>
      </div>

      {items.length === 0 && (
        <div className="text-[11px] text-slate-500">这个阶段还没有交付物。</div>
      )}

      <ul className="space-y-2">
        {items.map((d) => {
          const current = d.versions.find((v) => v.id === d.current_version_id) ?? d.versions[0];
          const missing = d.required === 1 && d.current_version_id === null;
          return (
            <li
              key={d.id}
              className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-slate-300">{d.name}</span>
                {/* 拖进来时按扩展名猜的类别，猜错了在这儿改回来 */}
                <Select
                  value={d.category}
                  title="类别（拖进来的文件按扩展名自动归类）"
                  onChange={(e) =>
                    void act(
                      () =>
                        api
                          .setDeliverableCategory(d.id, e.target.value as DeliverableCategory)
                          .then(() => undefined),
                      () =>
                        `${d.name} 的类别已改为${
                          meta.data?.categories[e.target.value as DeliverableCategory] ?? ''
                        }`,
                    )
                  }
                  className="rounded-lg border border-white/[0.08] bg-[#0D1117]/80 px-1.5 py-0.5 text-[11px] text-slate-300 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
                >
                  {Object.entries(meta.data?.categories ?? {}).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                {d.required === 1 && (
                  <span className={missing ? 'text-[11px] text-amber-300' : 'text-[11px] text-slate-500'}>
                    必交{missing ? '（未上传）' : ''}
                  </span>
                )}
                <span className="ml-auto text-[11px] text-slate-500">
                  {d.versions.length} 个版本
                </span>
              </div>
              {current && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  <span className={mono}>v{current.version_no}</span>
                  <a
                    className="truncate text-indigo-300 transition-colors hover:text-indigo-200"
                    href={`/api/files/${current.sha256}`}
                  >
                    {current.original_filename}
                  </a>
                  <span>{humanSize(current.size_bytes)}</span>
                  <span className={mono}>{fmtTime(current.uploaded_at)}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <form
        onSubmit={upload}
        className="mt-3 space-y-2.5 rounded-lg border border-white/[0.06] bg-white/[0.03] p-3"
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field label="目标">
            <Select
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
            </Select>
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
                <Select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as DeliverableCategory)}
                  className={`${inputCls} text-xs`}
                >
                  {Object.entries(meta.data?.categories ?? {}).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>

              <label className="flex items-center gap-1.5 pb-1.5 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(e) => setRequired(e.target.checked)}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-indigo-500"
                />
                必交项（未上传会卡住阶段推进）
              </label>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="min-w-0 flex-1 text-xs text-slate-500 file:mr-2 file:cursor-pointer file:rounded-lg file:border-0 file:bg-white/[0.06] file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-slate-300 file:transition-colors hover:file:bg-white/[0.10]"
          />
          <Button type="submit" variant="primary" size="sm" disabled={busy || !file}>
            {busy ? '上传中…' : '上传'}
          </Button>
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
    <form onSubmit={submit} className={`${surface.inset} space-y-2.5 p-3.5`}>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex cursor-pointer items-center gap-1.5 text-slate-300">
          <input
            type="radio"
            checked={!skipping}
            onChange={() => setSkipping(false)}
            className="accent-indigo-500"
          />
          标记完成并推进
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-slate-300">
          <input
            type="radio"
            checked={skipping}
            onChange={() => setSkipping(true)}
            className="accent-indigo-500"
          />
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
          <label className="flex items-center gap-1.5 text-[11px] text-amber-300">
            <input
              type="checkbox"
              checked={forced}
              onChange={(e) => setForced(e.target.checked)}
              className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-amber-500"
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

      <Button type="submit" variant="primary" disabled={blocked || skipBlocked}>
        推进
      </Button>

      {/* 上面那条黄框已经列清了「什么没完成」；这里只在还缺输入时补一句 */}
      {blocked && forced && (
        <p className="text-[11px] text-amber-300">强制推进必须写明原因。</p>
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
    <SurfaceCard
      title={`阻塞（${open.length} 条未解除）`}
      extra={
        <Button variant="secondary" size="sm" onClick={() => setAdding((v) => !v)}>
          {adding ? '取消' : '＋ 记录'}
        </Button>
      }
    >
      <div className="space-y-2 p-4">
        {open.length === 0 && (
          <div className="text-[11px] text-slate-500">当前没有未解除的阻塞。</div>
        )}

        <ul className="space-y-2">
          {open.map((b) => (
            <li
              key={b.id}
              className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    b.direction === 'blocked_by_others'
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                      : 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                  }`}
                >
                  {meta.data?.directions[b.direction] ?? b.direction}
                </span>
                <span className="text-[13px] font-medium text-slate-300">{b.counterparty}</span>
                <span className={`ml-auto ${mono}`}>
                  {fmtTime(b.opened_at)}
                </span>
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-slate-300">{b.need}</div>
              {b.promised_at && (
                <div className="mt-0.5 text-[11px] text-slate-500">
                  承诺 <span className={mono}>{b.promised_at}</span>
                </div>
              )}

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
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => setResolving(b.id)}
                >
                  解除
                </Button>
              )}
            </li>
          ))}
        </ul>

        {detail.blockers.some((b) => b.closed_at !== null) && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-slate-500 transition-colors hover:text-slate-300">
              已解除的历史
            </summary>
            <ul className="mt-1.5 space-y-1">
              {detail.blockers
                .filter((b) => b.closed_at !== null)
                .map((b) => (
                  <li key={b.id} className="text-[11px] text-slate-500">
                    {b.counterparty}：{b.need} → {b.resolution}
                  </li>
                ))}
            </ul>
          </details>
        )}

        {adding && <NewBlockerForm detail={detail} act={act} onDone={() => setAdding(false)} />}
      </div>
    </SurfaceCard>
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
      className="mt-1 space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.03] p-3"
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
      <Select
        value={direction}
        onChange={(e) => setDirection(e.target.value as typeof direction)}
        className={`${inputCls} w-full text-xs`}
      >
        {Object.entries(meta.data?.directions ?? {}).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </Select>

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

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as typeof severity)}
          className={`${inputCls} text-xs`}
        >
          {Object.entries(meta.data?.severities ?? {}).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <input
          type="date"
          value={promisedAt}
          onChange={(e) => setPromisedAt(e.target.value)}
          className={`${inputCls} text-xs`}
          title="对方承诺的时间"
        />
        <Button type="submit" variant="secondary" size="sm">
          记录
        </Button>
      </div>
    </form>
  );
}

/**
 * 页内「记一条进展」。**不要删。**
 *
 * 这里绑定的是**当前需求**；壳层那条常驻「记一笔」带一个需求下拉，
 * 之前选过别的条目后很容易记错地方。详情页上补进展是主操作，必须有一个
 * 指向明确的入口 —— 壳层那条在需求详情路由下会被隐藏，全程只有一处输入，
 * 所以这里不算重复。
 *
 * 视觉上新版把它做成内嵌块：textarea 直接用 Level 3 表面（#1C2333），
 * 让「写一句」这件事从卡片背景里浮出来。行为与接口调用保持原样。
 */
function NotePanel({ detail, act }: { detail: ItemData; act: Act }) {
  const [text, setText] = useState('');

  return (
    <SurfaceCard title="记一条进展">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          const value = text;
          setText('');
          void act(() => api.note(detail.item.id, value), () => `已记录：${value}`);
        }}
        className="space-y-2 p-4"
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="例如：与架构师对齐了鉴权协议"
          className="w-full resize-y rounded-lg border border-white/[0.08] bg-[#1C2333] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
        />
        <Button type="submit" variant="primary" size="sm">
          记录
        </Button>
      </form>
      <p className="px-4 pb-3.5 text-[11px] leading-relaxed text-slate-500">
        这些内容会直接出现在汇报草稿的「本区间进展」里。
      </p>
    </SurfaceCard>
  );
}

function TimelinePanel({ itemId, stages }: { itemId: number; stages: StageRow[] }) {
  const q = useQuery({ queryKey: ['timeline', itemId], queryFn: () => api.timeline(itemId) });
  const events = q.data?.events ?? [];

  return (
    <SurfaceCard title="时间线">
      <div className="p-4">
        {q.isLoading && <div className="text-[11px] text-slate-500">加载中…</div>}
        <ol>
          {[...events].reverse().map((e) => (
            <li
              key={e.id}
              className="relative border-l border-white/[0.07] py-1.5 pl-4 last:pb-0"
            >
              <span className="absolute -left-[3px] top-[9px] h-1.5 w-1.5 rounded-full bg-indigo-400/80" />
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] text-indigo-400">
                  {fmtTime(e.occurred_at)}
                </span>
                <span className="text-xs leading-relaxed text-slate-300">
                  {describeEvent(e, stages)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </SurfaceCard>
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