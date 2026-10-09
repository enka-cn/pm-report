import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectKind } from '@manager/shared';
import { api } from '../api';
import { useMeta } from '../lib/meta';
import { messageOf, useNotice } from '../lib/notice';
import { navigate } from '../lib/router';
import { fmtTime } from '../lib/format';
import { ProjectKindBadge } from './Badges';
import { Field, Hint, btnGhost, btnPrimary, inputCls } from './ui';

export function Projects() {
  const [kind, setKind] = useState<ProjectKind | ''>('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ['projects', kind, includeArchived],
    queryFn: () => api.listProjects({ kind: kind || undefined, includeArchived }),
  });

  const projects = list.data?.projects ?? [];

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ProjectKind | '')}
          className={`${inputCls} text-sm`}
        >
          <option value="">全部类型</option>
          <option value="delivery">交付型</option>
          <option value="caretaking">看护型</option>
        </select>

        <label className="flex items-center gap-1 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          含已归档
        </label>

        <button
          onClick={() => setCreating((v) => !v)}
          className="ml-auto rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-900 hover:bg-white"
        >
          {creating ? '取消' : '新建项目'}
        </button>
      </div>

      {creating && <NewProjectForm onDone={() => setCreating(false)} />}

      {list.isLoading && <Hint>加载中…</Hint>}
      {list.error && <Hint tone="error">{messageOf(list.error)}</Hint>}

      {!list.isLoading && projects.length === 0 && (
        <Hint>
          还没有项目。个人需求默认放在隐式的「默认项目」里，不用管；只有需要长期持有、
          或者要交接出去的（比如看护型）才值得单独立一个项目。
        </Hint>
      )}

      <ul className="space-y-2">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              onClick={() => navigate({ name: 'projects', projectId: p.id })}
              className="w-full rounded border border-zinc-800 px-3 py-2 text-left hover:border-zinc-600 hover:bg-zinc-900"
            >
              <div className="flex flex-wrap items-center gap-2">
                {p.code && <span className="font-mono text-xs text-zinc-500">{p.code}</span>}
                <span className="text-sm text-zinc-100">{p.name}</span>
                <ProjectKindBadge kind={p.kind} />
                {p.archived_at && <span className="text-xs text-zinc-500">已归档</span>}
                <span className="ml-auto text-xs text-zinc-500">负责人 {p.owner}</span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                <span>
                  子需求 <b className={p.active_items > 0 ? 'text-zinc-300' : ''}>{p.active_items}</b>
                  {p.total_items > p.active_items && ` / 共 ${p.total_items}`}
                </span>
                {p.open_blockers > 0 && (
                  <span className="text-amber-300">{p.open_blockers} 条未解除阻塞</span>
                )}
                <span>最近活动 {p.last_activity_at ? fmtTime(p.last_activity_at) : '—'}</span>
                {p.kind === 'caretaking' && p.watch_for && (
                  <span className="text-sky-300/80">等：{p.watch_for}</span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const meta = useMeta();
  const notice = useNotice();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<ProjectKind>('caretaking');
  const [description, setDescription] = useState('');
  const [watchFor, setWatchFor] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api.createProject({
        name,
        code: code.trim() || null,
        kind,
        description: description || null,
        watchFor: kind === 'caretaking' ? watchFor : null,
        dueAt: kind === 'delivery' ? dueAt || null : null,
      });
      await queryClient.invalidateQueries();
      notice.ok(`已创建项目 ${created.ref}`);
      onDone();
      navigate({ name: 'projects', projectId: created.id });
    } catch (err) {
      notice.fail(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mb-4 space-y-3 rounded border border-zinc-800 bg-zinc-900/60 p-3"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="名称">
          <input
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：模型量化看护"
            className={`${inputCls} w-56`}
          />
        </Field>

        <Field label="编号（可留空）">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="看护类通常没有"
            className={`${inputCls} w-32 font-mono text-sm`}
          />
        </Field>

        <Field label="类型">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ProjectKind)}
            className={`${inputCls} text-sm`}
          >
            {Object.entries(meta.data?.projectKinds ?? {}).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>

        {kind === 'delivery' ? (
          <Field label="截止日期">
            <input
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className={`${inputCls} text-sm`}
            />
          </Field>
        ) : (
          <div className="min-w-[18rem] flex-1">
            <Field label="看护条件（必填：等什么会触发下一次动作）">
              <input
                required
                value={watchFor}
                onChange={(e) => setWatchFor(e.target.value)}
                placeholder="例如：新平台需要量化时"
                className={`${inputCls} w-full`}
              />
            </Field>
          </div>
        )}
      </div>

      <Field label="说明">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder={
            kind === 'caretaking'
              ? '为什么我们持有它、当前状态如何、接手的人需要知道什么'
              : '这个容器里装的是什么'
          }
          className={`${inputCls} w-full resize-y text-sm`}
        />
      </Field>

      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className={btnPrimary}>
          {busy ? '创建中…' : '创建'}
        </button>
        <button type="button" className={btnGhost} onClick={onDone}>
          取消
        </button>
      </div>

      {kind === 'caretaking' && (
        <p className="text-[11px] leading-relaxed text-zinc-500">
          看护型项目<strong className="text-zinc-400">不进任何时间桶</strong>
          （它不是一个需求，没有日程），只在驾驶舱的「看护中」里安静地列着。
          触发时，在它下面新建一条子需求 —— 那条子需求是普通需求，有 DDL 就照常提醒。
        </p>
      )}
    </form>
  );
}
