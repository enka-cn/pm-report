import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventRow, ProjectRow } from '@manager/shared';
import { api } from '../api';
import { fmtLocalDay, fmtTime } from '../lib/format';
import { messageOf, useNotice } from '../lib/notice';
import { navigate } from '../lib/router';
import { ConditionBadge, ProjectKindBadge } from './Badges';
import { NewItemForm } from './ItemList';
import { Field, Hint, InlineCode, Panel, btnGhost, btnPrimary, inputCls } from './ui';

export function ProjectDetail({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const notice = useNotice();
  const [creating, setCreating] = useState(false);

  const q = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) });
  const timeline = useQuery({
    queryKey: ['project-timeline', projectId],
    queryFn: () => api.projectTimeline(projectId),
  });

  async function act<T>(fn: () => Promise<T>, ok: string): Promise<void> {
    try {
      await fn();
      await queryClient.invalidateQueries();
      notice.ok(ok);
    } catch (err) {
      notice.fail(messageOf(err));
    }
  }

  if (q.isLoading) return <Hint>加载中…</Hint>;
  if (q.error) return <Hint tone="error">{messageOf(q.error)}</Hint>;

  const detail = q.data;
  if (!detail) return <Hint>项目不存在。</Hint>;

  const p = detail.project;
  const openItems = detail.items.filter((i) => i.closed_at === null);
  const closedItems = detail.items.filter((i) => i.closed_at !== null);

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-5">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => navigate({ name: 'projects', projectId: null })}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          ← 项目
        </button>
        {/* 编号可以没有：看护/预研类项目本来就没有单号。点一下就地改 */}
        <InlineCode
          code={p.code}
          onSave={async (next) => {
            await api.setProjectCode(p.id, next);
            await queryClient.invalidateQueries();
          }}
        />
        <h1 className="text-base text-zinc-100">{p.name}</h1>
        <ProjectKindBadge kind={p.kind} />
        {p.archived_at && <span className="text-xs text-zinc-500">已归档</span>}
        <span className="text-xs text-zinc-500">负责人 {p.owner}</span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {p.owner !== 'me' && p.handoff_accepted_at === null && (
            <button
              className="rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/30"
              title="对方已经接手了。在这一刻之前，这条责任仍然算你的 —— 免得它在交接的缝隙里蒸发"
              onClick={() => void act(() => api.acceptHandoff(p.id), `${p.owner} 已确认接手`)}
            >
              {p.owner} 已接收
            </button>
          )}
          {p.owner !== 'me' && p.handoff_accepted_at !== null && (
            <button
              className={btnGhost}
              title="把这条责任收回我名下"
              onClick={() => void act(() => api.reclaimProject(p.id), '已收回')}
            >
              收回
            </button>
          )}
          <HandoffControls project={p} openItems={openItems.length} act={act} />
          {p.archived_at ? (
            <button
              className={btnGhost}
              onClick={() => void act(() => api.unarchiveProject(p.id), '已取消归档')}
            >
              取消归档
            </button>
          ) : (
            <button
              className={btnGhost}
              onClick={() => void act(() => api.archiveProject(p.id), '已归档')}
            >
              归档
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          {p.owner !== 'me' && p.handoff_accepted_at === null && (
            <div className="rounded border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
              <strong>待接收</strong>：已经交给 {p.owner}，但对方还没确认接手。
              在这之前它仍然算你的责任，所以还留在你的驾驶舱里 —— 免得它在交接的缝隙里蒸发。
            </div>
          )}

          {p.kind === 'caretaking' && (
            <Panel title="看护条件">
              <p className="text-sm text-sky-200">{p.watch_for ?? '（未填写）'}</p>
              <p className="mt-1 text-xs text-zinc-500">
                只有这个条件成立时才需要动手。交接时它会跟着一起转给接手的人。
              </p>
            </Panel>
          )}

          <Panel title="说明">
            {p.description ? (
              <p className="whitespace-pre-wrap text-sm text-zinc-300">{p.description}</p>
            ) : (
              <p className="text-xs text-zinc-500">
                还没写。<strong className="text-zinc-400">接手的人第一眼看的就是这里</strong>
                —— 为什么我们持有它、当前状态如何。
              </p>
            )}
          </Panel>

          <Panel
            title={`子需求（在途 ${openItems.length}，历史 ${closedItems.length}）`}
            extra={
              <button className={btnGhost} onClick={() => setCreating((v) => !v)}>
                {creating ? '取消' : '＋ 新建子需求'}
              </button>
            }
          >
            {creating && <NewItemForm onDone={() => setCreating(false)} projectId={p.id} />}

            {detail.items.length === 0 && !creating && (
              <p className="text-xs text-zinc-500">
                还没有子需求。触发条件成立时（比如新平台要量化），在这里新建一条 ——
                它是普通需求，有 DDL 就照常进逾期提醒。
              </p>
            )}

            <ul className="divide-y divide-zinc-800/70">
              {[...openItems, ...closedItems].map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => navigate({ name: 'item', id: item.id, stageId: null })}
                    className="flex w-full items-center gap-2 px-1 py-1.5 text-left hover:bg-zinc-800/50"
                  >
                    {item.code && <span className="font-mono text-xs text-zinc-500">{item.code}</span>}
                    <span
                      className={`truncate text-sm ${
                        item.closed_at ? 'text-zinc-500' : 'text-zinc-100'
                      }`}
                    >
                      {item.title}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-zinc-500">
                      <span>DDL {item.due_at ?? '未设'}</span>
                      <ConditionBadge condition={item.condition} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="space-y-4">
          {detail.open_blockers.length > 0 && (
            <Panel title={`未解除的阻塞（${detail.open_blockers.length}）`}>
              <ul className="space-y-1.5">
                {detail.open_blockers.map((b) => (
                  <li key={b.id} className="text-xs">
                    <span className="text-zinc-300">{b.counterparty}</span>
                    <span className="text-zinc-500">：{b.need}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="项目时间线">
            {(timeline.data?.events.length ?? 0) === 0 && (
              <p className="text-xs text-zinc-500">还没有项目级事件。</p>
            )}
            <ul className="space-y-1.5">
              {[...(timeline.data?.events ?? [])].reverse().map((e) => (
                <li key={e.id} className="text-xs">
                  <span className="text-zinc-500">{fmtTime(e.occurred_at)}</span>{' '}
                  <span className="text-zinc-300">{describeProjectEvent(e)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function HandoffControls({
  project,
  openItems,
  act,
}: {
  project: ProjectRow;
  openItems: number;
  act: <T>(fn: () => Promise<T>, ok: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [toOwner, setToOwner] = useState('');
  const [note, setNote] = useState('');

  if (!asking) {
    return (
      <button
        className={btnGhost}
        title="把这个项目（连同在途子需求、阻塞和看护条件）交给别人"
        onClick={() => setAsking(true)}
      >
        交接
      </button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded border border-zinc-700 bg-zinc-900 p-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setAsking(false);
        void act(
          () => api.handoffProject(project.id, { toOwner, note: note || undefined }),
          `已交接给 ${toOwner}`,
        );
        setToOwner('');
        setNote('');
      }}
    >
      <Field label="交给谁">
        <input
          required
          autoFocus
          value={toOwner}
          onChange={(e) => setToOwner(e.target.value)}
          placeholder="例如：SE组-张三"
          className={`${inputCls} w-40 text-xs`}
        />
      </Field>
      <Field label="交接说明">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="可选"
          className={`${inputCls} w-52 text-xs`}
        />
      </Field>
      <div className="flex items-center gap-1 pt-4">
        <button type="submit" className={btnPrimary}>
          交出
        </button>
        <button type="button" className={btnGhost} onClick={() => setAsking(false)}>
          取消
        </button>
      </div>
      <p className="w-full text-[11px] text-zinc-500">
        交接会把「{openItems} 条在途子需求 + 未解除的阻塞 + 看护条件」一并记进事件日志，
        接手的人查得到自己接了什么。
      </p>
    </form>
  );
}

function describeProjectEvent(e: EventRow): string {
  let p: Record<string, unknown> = {};
  if (e.payload) {
    try {
      p = JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      p = {};
    }
  }
  const note = e.note ? `：${e.note}` : '';

  switch (e.type) {
    case 'project_created':
      return `创建项目（${p['kind'] === 'caretaking' ? '看护型' : '交付型'}，负责人 ${String(p['owner'] ?? '')}）`;
    case 'project_updated':
      return '修改项目信息';
    case 'project_handoff': {
      const pending = (p['pending_items'] as unknown[] | undefined)?.length ?? 0;
      return `交接：${String(p['from_owner'] ?? '')} → ${String(p['to_owner'] ?? '')}（在途 ${pending} 条，未解除阻塞 ${String(p['open_blockers'] ?? 0)} 条）${note}`;
    }
    case 'project_archived':
      return '归档';
    case 'project_unarchived':
      return '取消归档';
    default:
      return e.type;
  }
}
