import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SearchHit, SearchKind } from '@manager/shared';
import { api } from '../api';
import { fmtTime } from '../lib/format';
import { messageOf } from '../lib/notice';
import { navigate } from '../lib/router';
import { useMeta } from '../lib/meta';
import { Hint, btnGhost } from './ui';

const KIND_TONE: Record<SearchKind, string> = {
  item: 'bg-zinc-700/60 text-zinc-200',
  note: 'bg-sky-500/15 text-sky-300',
  todo: 'bg-emerald-500/15 text-emerald-300',
  blocker: 'bg-amber-500/15 text-amber-300',
  deliverable: 'bg-violet-500/15 text-violet-300',
  project: 'bg-cyan-500/15 text-cyan-300',
  link: 'bg-rose-500/15 text-rose-300',
};

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

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-6">
      <input
        autoFocus
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="全文检索：备注、待办、交付物、阻塞、项目说明……"
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-500"
      />

      {!q && (
        <Hint>
          搜的是<strong className="text-zinc-400">正文</strong>，不只是标题：你写在备注里的
          「等测试组排期」、随手加的待办、交付物文件名、阻塞里等谁等什么、项目的看护条件，
          都在里面。
        </Hint>
      )}

      {result.error && <Hint tone="error">{messageOf(result.error)}</Hint>}

      {data && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">
              「{data.q}」共 {Object.values(data.counts).reduce((a, b) => a + b, 0)} 条
            </span>
            <FilterChip
              label="全部"
              count={Object.values(data.counts).reduce((a, b) => a + b, 0)}
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

          <ul className="mt-3 space-y-1">
            {hits.map((hit) => (
              <li key={`${hit.kind}-${hit.refId}`}>
                <Hit hit={hit} />
              </li>
            ))}
          </ul>

          {data.total < Object.values(data.counts).reduce((a, b) => a + b, 0) && (
            <p className="mt-3 text-xs text-zinc-500">
              只显示了前 {data.total} 条，缩小范围可以看得更全。
            </p>
          )}
        </>
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
      className={`rounded px-2 py-0.5 transition ${
        active
          ? 'bg-zinc-100 text-zinc-900'
          : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
      }`}
    >
      {label} {count}
    </button>
  );
}

function Hit({ hit }: { hit: SearchHit }) {
  const meta = useMeta();

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
      className="w-full rounded border border-transparent px-3 py-2 text-left hover:border-zinc-700 hover:bg-zinc-900"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${KIND_TONE[hit.kind]}`}>
          {meta.data?.searchKinds[hit.kind] ?? hit.kind}
        </span>
        {target && <span className="text-xs text-zinc-300">{target}</span>}
        {hit.projectName && hit.kind !== 'project' && (
          <span className="text-[10px] text-zinc-600">· {hit.projectName}</span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
          {fmtTime(hit.occurredAt)}
        </span>
      </div>

      <p className="mt-1 text-sm text-zinc-400">
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
          <mark key={i} className="rounded bg-amber-500/25 px-0.5 text-amber-100">
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
    <div className="mt-6 border-t border-zinc-800 pt-3">
      <button
        type="button"
        className={btnGhost}
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
      </button>
      {done !== null && (
        <span className="ml-2 text-xs text-zinc-500">已重建，共 {done} 条。</span>
      )}
    </div>
  );
}
