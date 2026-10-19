import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@manager/shared';
import { api } from '../api';
import { useMeta } from '../lib/meta';
import { messageOf, useNotice } from '../lib/notice';
import { navigate } from '../lib/router';
import { ConditionBadge, RoleBadge } from './Badges';
import { Button, Field, Hint, Select, inputCls, mono, surface } from './ui';

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
    // 页面标题与四周留白都由壳层的吸顶 header / <main> 提供，这里只负责居中和纵向间距
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 编号"
          className={`${inputCls} w-56 text-sm`}
        />

        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as Role | '')}
          className={`${inputCls} text-sm`}
        >
          <option value="">全部角色</option>
          {Object.entries(meta.data?.roles ?? {}).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>

        <Select
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          className={`${inputCls} text-sm`}
        >
          <option value="">全部状况</option>
          {Object.entries(meta.data?.conditions ?? {}).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-slate-300">
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
            className="accent-indigo-500"
          />
          含已关闭
        </label>

        <Button
          variant={creating ? 'secondary' : 'primary'}
          onClick={() => setCreating((v) => !v)}
          className="ml-auto"
        >
          {creating ? '取消' : '新建需求'}
        </Button>
      </div>

      {creating && <NewItemForm onDone={() => setCreating(false)} />}

      {list.isLoading && <Hint>加载中…</Hint>}
      {list.error && <Hint tone="error">{messageOf(list.error)}</Hint>}

      {!list.isLoading && items.length === 0 && <Hint>没有匹配的需求。</Hint>}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => navigate({ name: 'item', id: item.id, stageId: null })}
                className={`${surface.card} flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors`}
              >
                <span
                  className={`w-24 shrink-0 truncate ${
                    item.code ? mono : 'font-mono text-xs text-slate-600'
                  }`}
                  title={item.code ?? '没有编号'}
                >
                  {item.code ?? '—'}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                  {item.title}
                </span>

                <span className="flex shrink-0 items-center gap-2">
                  <ConditionBadge condition={item.condition} />
                  <RoleBadge role={item.role} />
                  <span className="hidden items-center gap-3 text-xs text-slate-500 sm:flex">
                    <span>关键度 {item.criticality}</span>
                    <span>DDL {item.due_at ?? '未设'}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
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
    <form onSubmit={submit} className={`${surface.inset} flex flex-wrap items-end gap-3 p-4`}>
      <Field label="标题">
        <input
          required
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：接口鉴权改造"
          className={`${inputCls} w-64`}
        />
      </Field>

      <Field label="编号（可留空）">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="例：REQ-1234"
          className={`${inputCls} w-28 font-mono text-xs`}
        />
      </Field>

      <Field label="流水线">
        <Select
          value={chosen?.key ?? ''}
          onChange={(e) => setPipelineKey(e.target.value)}
          disabled={pipelines.length === 0}
          className={`${inputCls} text-sm`}
        >
          {pipelines.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}（{meta.data?.roles[p.role] ?? p.role}）
            </option>
          ))}
        </Select>
      </Field>

      <Field label="整体 DDL">
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className={`${inputCls} text-sm`}
        />
      </Field>

      <Field label="关键度">
        <input
          type="number"
          min={1}
          max={5}
          value={criticality}
          onChange={(e) => setCriticality(Number(e.target.value))}
          className={`${inputCls} w-16 text-center`}
        />
      </Field>

      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? '创建中…' : '创建'}
      </Button>

      {chosen && (
        <p className="w-full text-[11px] leading-relaxed text-slate-500">
          {chosen.stages.map((s) => s.name).join(' → ')}
          <button
            type="button"
            className="ml-2 text-indigo-400 transition-colors hover:text-indigo-300"
            onClick={() => navigate({ name: 'pipelines' })}
          >
            改流水线
          </button>
        </p>
      )}
    </form>
  );
}
