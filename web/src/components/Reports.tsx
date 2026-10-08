import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { fmtLocalDay, fmtTime } from '../lib/format';
import { messageOf, useNotice } from '../lib/notice';
import { navigate } from '../lib/router';
import { Hint, btnGhost, btnPrimary, inputCls } from './ui';

export function Reports({ reportId }: { reportId: number | null }) {
  const queryClient = useQueryClient();
  const notice = useNotice();

  const [draft, setDraft] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState('default');
  const [busy, setBusy] = useState(false);

  const list = useQuery({ queryKey: ['reports'], queryFn: api.listReports });
  const reports = list.data?.reports ?? [];
  const templates = list.data?.templates ?? [];
  const selected = reports.find((r) => r.id === reportId) ?? reports[0] ?? null;

  // 切换选中的汇报时丢掉未保存的编辑内容（避免把 A 的修改写进 B）
  useEffect(() => {
    setDraft(null);
  }, [selected?.id]);

  async function run(fn: () => Promise<unknown>, ok: string): Promise<void> {
    setBusy(true);
    try {
      await fn();
      await queryClient.invalidateQueries();
      notice.ok(ok);
    } catch (err) {
      notice.fail(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function generate(): Promise<void> {
    setBusy(true);
    try {
      const created = await api.generateReport({ templateKey });
      await queryClient.invalidateQueries();
      navigate({ name: 'reports', reportId: created.id });
      notice.ok(`已生成 ${created.title}`);
    } catch (err) {
      notice.fail(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const text = draft ?? selected?.content_md ?? '';
  const dirty = selected !== null && draft !== null && draft !== selected.content_md;

  return (
    <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 px-6 py-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-3">
        <div className="rounded border border-zinc-800 p-3">
          <button onClick={() => void generate()} disabled={busy} className={`${btnPrimary} w-full`}>
            {busy ? '生成中…' : '生成汇报草稿'}
          </button>

          {templates.length > 1 && (
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
              模板
              <select
                value={templateKey}
                onChange={(e) => setTemplateKey(e.target.value)}
                className={`${inputCls} flex-1 text-xs`}
              >
                {templates.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            区间从<strong className="text-zinc-500">上一次定稿</strong>的结束时间开始，到现在。
            <strong className="text-zinc-500">定稿</strong>之后，它的结束时间就成为下一次的起点 ——
            这就是「两次汇报之间发生了什么」能自动成立的原因。
          </p>
        </div>

        {list.isLoading && <Hint>加载中…</Hint>}
        {list.error && <Hint tone="error">{messageOf(list.error)}</Hint>}

        {reports.length === 0 && !list.isLoading && (
          <Hint>还没有汇报。点上面生成第一份草稿。</Hint>
        )}

        <ul className="space-y-1">
          {reports.map((r) => {
            const active = r.id === selected?.id;
            return (
              <li key={r.id}>
                <button
                  onClick={() => navigate({ name: 'reports', reportId: r.id })}
                  className={`w-full rounded border px-2 py-1.5 text-left ${
                    active ? 'border-zinc-500 bg-zinc-800' : 'border-zinc-800 hover:border-zinc-600'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs text-zinc-200">
                      {fmtLocalDay(r.period_start)} ~ {fmtLocalDay(r.period_end)}
                    </span>
                    <span
                      className={`ml-auto shrink-0 text-[10px] ${
                        r.finalized_at ? 'text-emerald-300' : 'text-amber-300'
                      }`}
                    >
                      {r.finalized_at ? '已定稿' : '草稿'}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-zinc-600">
                    生成于 {fmtTime(r.created_at)}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="min-w-0">
        {!selected ? (
          <div className="rounded border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
            左边点「生成汇报草稿」开始。
          </div>
        ) : (
          <div className="rounded border border-zinc-800">
            <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
              <h2 className="text-sm text-zinc-100">{selected.title}</h2>
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  selected.finalized_at
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                {selected.finalized_at ? `已定稿 ${fmtTime(selected.finalized_at)}` : '草稿'}
              </span>

              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button
                  className={btnGhost}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(text)
                      .then(() => notice.ok('已复制 Markdown 到剪贴板'))
                      .catch((err: unknown) => notice.fail(messageOf(err)));
                  }}
                >
                  复制
                </button>

                {selected.finalized_at ? (
                  <button
                    className={btnGhost}
                    onClick={() =>
                      void run(
                        () => api.unfinalizeReport(selected.id),
                        '已取消定稿，可以继续编辑',
                      )
                    }
                  >
                    取消定稿
                  </button>
                ) : (
                  <>
                    <button
                      className={btnGhost}
                      disabled={!dirty || busy}
                      onClick={() =>
                        void run(
                          () => api.updateReport(selected.id, { contentMd: text }),
                          '草稿已保存',
                        )
                      }
                    >
                      {dirty ? '保存' : '已保存'}
                    </button>
                    <button
                      className={btnGhost}
                      onClick={() =>
                        void run(
                          () => api.deleteReport(selected.id),
                          '草稿已删除',
                        ).then(() => navigate({ name: 'reports', reportId: null }))
                      }
                    >
                      删除草稿
                    </button>
                    <button
                      className={btnPrimary}
                      onClick={() =>
                        void run(
                          () => api.finalizeReport(selected.id),
                          '已定稿 —— 下次生成会从这里接着算',
                        )
                      }
                    >
                      定稿
                    </button>
                  </>
                )}
              </div>
            </header>

            <div className="p-3">
              {!selected.finalized_at && (
                <p className="mb-2 text-[11px] text-zinc-500">
                  下面是可以直接改的草稿。改完点「定稿」，它的结束时间会成为下一次的起点。
                </p>
              )}

              <textarea
                value={text}
                readOnly={selected.finalized_at !== null}
                onChange={(e) => setDraft(e.target.value)}
                rows={30}
                spellCheck={false}
                className={`w-full resize-y rounded border border-zinc-800 bg-zinc-950 p-3 font-mono text-[12.5px] leading-relaxed text-zinc-200 outline-none focus:border-zinc-600 ${
                  selected.finalized_at ? 'opacity-80' : ''
                }`}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
