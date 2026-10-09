import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@manager/shared';
import { api } from '../api';
import { useMeta } from '../lib/meta';
import { messageOf, useNotice } from '../lib/notice';
import { navigate } from '../lib/router';
import { ConditionBadge, RoleBadge } from './Badges';
import { Field, Hint, inputCls } from './ui';

export function ItemList() {
  const [q, setQ] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [condition, setCondition] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [creating, setCreating] = useState(false);

  const meta = useMeta();
  const list = useQuery({
    queryKey: ['items', q, role, condition, includeClosed],
    queryFn: () => api.listItems({ q, role, condition, includeClosed }),
  });

  const items = list.data?.items ?? [];

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 编号"
          className="w-56 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 outline-none focus:border-zinc-500"
        />

        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role | '')}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200"
        >
          <option value="">全部角色</option>
          {Object.entries(meta.data?.roles ?? {}).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>

        <select
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200"
        >
          <option value="">全部状况</option>
          {Object.entries(meta.data?.conditions ?? {}).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
          />
          含已关闭
        </label>

        <button
          onClick={() => setCreating((v) => !v)}
          className="ml-auto rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-900 hover:bg-white"
        >
          {creating ? '取消' : '新建需求'}
        </button>
      </div>

      {creating && <NewItemForm onDone={() => setCreating(false)} />}

      {list.isLoading && <Hint>加载中…</Hint>}
      {list.error && <Hint tone="error">{messageOf(list.error)}</Hint>}

      {!list.isLoading && items.length === 0 && <Hint>没有匹配的需求。</Hint>}

      {items.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="px-2 py-1 font-normal">编号</th>
              <th className="px-2 py-1 font-normal">标题</th>
              <th className="px-2 py-1 font-normal">角色</th>
              <th className="px-2 py-1 font-normal">状况</th>
              <th className="px-2 py-1 font-normal">整体 DDL</th>
              <th className="px-2 py-1 font-normal">关键度</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                onClick={() => navigate({ name: 'item', id: item.id, stageId: null })}
                className="cursor-pointer border-b border-zinc-800/60 hover:bg-zinc-800/40"
              >
                <td className="px-2 py-1.5 font-mono text-xs text-zinc-500">{item.code ?? '—'}</td>
                <td className="px-2 py-1.5 text-zinc-100">{item.title}</td>
                <td className="px-2 py-1.5">
                  <RoleBadge role={item.role} />
                </td>
                <td className="px-2 py-1.5">
                  <ConditionBadge condition={item.condition} />
                </td>
                <td className="px-2 py-1.5 text-zinc-400">{item.due_at ?? '—'}</td>
                <td className="px-2 py-1.5 text-zinc-400">{item.criticality}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 项目详情页也复用它（带上 projectId 就把需求建到那个项目下） */
export function NewItemForm({
  onDone,
  projectId,
}: {
  onDone: () => void;
  projectId?: number;
}) {
  const meta = useMeta();
  const notice = useNotice();
  const queryClient = useQueryClient();

  // 让用户选**流水线**而不是选角色。
  // 之前这里列的是 meta.roles（写死的枚举），于是「测试」「维护」也在下拉里 ——
  // 但它们没有对应的流水线模板，选中点创建必然报「角色 X 没有对应的流水线模板」。
  // 现在列的是真实加载到的模板，选什么都不可能失败；以后一个角色有多条流水线也能选。
  const templates = useQuery({ queryKey: ['pipelines'], queryFn: api.pipelines });
  const pipelines = templates.data?.pipelines ?? [];

  const [title, setTitle] = useState('');
  const [pipelineKey, setPipelineKey] = useState('');
  const [code, setCode] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [criticality, setCriticality] = useState(3);
  const [busy, setBusy] = useState(false);

  // 模板是异步来的，到了之后默认选第一条
  const chosen = pipelines.find((p) => p.key === pipelineKey) ?? pipelines[0];

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    try {
      const created = await api.createItem({
        title,
        role: chosen.role,
        pipelineKey: chosen.key,
        code: code.trim() || null,
        dueAt: dueAt || null,
        criticality,
        projectId: projectId ?? null,
      });
      await queryClient.invalidateQueries();
      notice.ok(
        `已创建 ${created.item.ref}，按「${chosen.name}」生成了 ${created.stages.length} 个阶段`,
      );
      onDone();
      navigate({ name: 'item', id: created.item.id, stageId: null });
    } catch (err) {
      notice.fail(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mb-4 flex flex-wrap items-end gap-3 rounded border border-zinc-800 bg-zinc-900/60 p-3"
    >
      <Field label="标题">
        <input
          required
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：接口鉴权改造"
          className="w-64 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 outline-none focus:border-zinc-500"
        />
      </Field>

      <Field label="编号（可留空）">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="例：REQ-1234"
          className="w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-zinc-100 outline-none focus:border-zinc-500"
        />
      </Field>

      <Field label="流水线">
        <select
          value={chosen?.key ?? ''}
          onChange={(e) => setPipelineKey(e.target.value)}
          disabled={pipelines.length === 0}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200"
        >
          {pipelines.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}（{meta.data?.roles[p.role] ?? p.role}）
            </option>
          ))}
        </select>
      </Field>
      {chosen && (
        <p className="w-full text-[11px] text-zinc-500">
          {chosen.stages.map((s) => s.name).join(' → ')}
          <button
            type="button"
            className="ml-2 text-sky-400 hover:text-sky-300"
            onClick={() => navigate({ name: 'pipelines' })}
          >
            改流水线
          </button>
        </p>
      )}

      <Field label="整体 DDL">
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200"
        />
      </Field>

      <Field label="关键度">
        <input
          type="number"
          min={1}
          max={5}
          value={criticality}
          onChange={(e) => setCriticality(Number(e.target.value))}
          className="w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200"
        />
      </Field>

      <button
        type="submit"
        disabled={busy}
        className="rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? '创建中…' : '创建'}
      </button>
    </form>
  );
}
