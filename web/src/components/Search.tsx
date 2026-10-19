import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SearchHit, SearchKind } from '@manager/shared';
import { api } from '../api';
import { fmtTime } from '../lib/format';
import { messageOf } from '../lib/notice';
import { navigate } from '../lib/router';
import { useMeta } from '../lib/meta';
import { Button, Hint, Input, surface } from './ui';

export function Search({ q }: { q: string | null }) {
  const meta = useMeta();
  const [input, setInput] = useState(q ?? '');
  const [kind, setKind] = useState<SearchKind | null>(null);
  /** 我们自己推到 URL 上的最后一次输入 —— 用来区分「用户敲的」和「从别处跳来的」 */
  const pushed = useRef<string | null>(null);

  useEffect(() => {
    if (q !== pushed.current) setInput(q ?? '');
  }, [q]);

  // 防抖后写回 URL。用 replace 而不是赋值 hash，免得每敲一个字就多一条历史记录。
  useEffect(() => {
    const timer = setTimeout(() => {
      pushed.current = input;
      const next = input ? `#/search/${encodeURIComponent(input)}` : '#/search';
      if (location.hash !== next) location.replace(next);
    }, 250);
    return () => clearTimeout(timer);
  }, [input]);

  const result = useQuery({
    queryKey: ['search', q, kind],
    queryFn: () => api.search(q ?? '', kind),
    enabled: Boolean(q),
    placeholderData: (prev) => prev,
  });

  const data = result.data;
  const hits = data?.hits ?? [];
  const totalHits = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;

  // 按 kind 分组。服务端已经按「标题命中优先、时间倒序」排好，分组只是换一种阅读方式，
  // 组内顺序保持服务端给的顺序（不重排，免得丢信息）。
  const groups = data
    ? (Object.keys(data.counts) as SearchKind[])
        .map((k) => ({ kind: k, hits: hits.filter((h) => h.kind === k) }))
        .filter((g) => g.hits.length > 0)
    : [];

  return (
    // 页面标题与四周留白都由壳层的吸顶 header / <main> 提供，这里只负责居中和纵向间距
    <div className="mx-auto max-w-[1000px] space-y-4">
      <Input
        autoFocus
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="全文检索：备注、待办、交付物、阻塞、项目说明……"
        className="py-2 text-sm"
      />

      {!q && (
        <Hint>
          搜的是<strong className="font-medium text-slate-300">正文</strong>，不只是标题：你写在备注里的
          「等测试组排期」、随手加的待办、交付物文件名、阻塞里等谁等什么、项目的看护条件，
          都在里面。
        </Hint>
      )}

      {result.error && <Hint tone="error">{messageOf(result.error)}</Hint>}

      {data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">
              「{data.q}」共 {totalHits} 条
            </span>
            <FilterChip
              label="全部"
              count={totalHits}
              active={kind === null}
              onClick={() => setKind(null)}
            />
            {(Object.keys(data.counts) as SearchKind[])
              .filter((k) => data.counts[k] > 0)
              .map((k) => (
                <FilterChip
                  key={k}
                  label={meta.data?.searchKinds[k] ?? k}
                  count={data.counts[k]}
                  active={kind === k}
                  onClick={() => setKind(kind === k ? null : k)}
                />
              ))}
          </div>

          {hits.length === 0 && <Hint>没找到。换个词试试，或者去掉上面的类别筛选。</Hint>}

          {groups.map((g) => (
            <section key={g.kind}>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-500">
                {meta.data?.searchKinds[g.kind] ?? g.kind}
                <span className="text-slate-600">({g.hits.length})</span>
              </h3>
              <ul className="space-y-2">
                {g.hits.map((hit) => (
                  <li key={`${hit.kind}-${hit.refId}`}>
                    <Hit hit={hit} />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {data.total < totalHits && (
            <p className="text-xs text-slate-500">
              只显示了前 {data.total} 条，缩小范围可以看得更全。
            </p>
          )}
        </div>
      )}

      <ReindexButton />
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 transition-colors ${
        active
          ? 'border-indigo-500/30 bg-indigo-500/15 text-indigo-300'
          : 'border-white/[0.08] bg-white/[0.04] text-slate-400 hover:bg-white/[0.07] hover:text-slate-200'
      }`}
    >
      {label} {count}
    </button>
  );
}

function Hit({ hit }: { hit: SearchHit }) {
  // 子条目（备注/待办/阻塞/交付物）跳到它所属的需求；项目跳到项目页
  const go = (): void => {
    if (hit.kind === 'project' && hit.projectId !== null) {
      navigate({ name: 'projects', projectId: hit.projectId });
    } else if (hit.itemId !== null) {
      navigate({ name: 'item', id: hit.itemId, stageId: null });
    }
  };

  const target =
    hit.kind === 'project'
      ? (hit.projectName ?? '项目')
      : hit.itemCode
        ? `${hit.itemCode} ${hit.itemTitle ?? ''}`
        : null;

  return (
    <button
      type="button"
      onClick={go}
      className={`${surface.card} w-full px-3 py-2 text-left transition-colors`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {target && <span className="text-xs text-slate-200">{target}</span>}
        {hit.projectName && hit.kind !== 'project' && (
          <span className="text-[10px] text-slate-500">· {hit.projectName}</span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-indigo-400">
          {fmtTime(hit.occurredAt)}
        </span>
      </div>

      <p className="mt-1 text-xs leading-relaxed text-slate-300">
        <Snippet text={hit.snippet} />
      </p>
    </button>
  );
}

/** 把服务端标好的 [命中词] 渲染成高亮 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('[') && part.endsWith(']') ? (
          <mark key={i} className="rounded bg-indigo-500/20 px-0.5 text-indigo-200">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function ReindexButton() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  return (
    <div className="border-t border-white/[0.07] pt-3">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        title="正常情况下用不上（触发器保证同步），是索引漂了时的对账手段"
        onClick={() => {
          setBusy(true);
          void api
            .reindexSearch()
            .then((r) => setDone(r.indexed))
            .catch(() => setDone(null))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? '重建中…' : '重建搜索索引'}
      </Button>
      {done !== null && (
        <span className="ml-2 text-xs text-slate-500">已重建，共 {done} 条。</span>
      )}
    </div>
  );
}
