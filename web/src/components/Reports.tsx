import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { fmtLocalDay, fmtTime } from '../lib/format';
import { messageOf, useNotice } from '../lib/notice';
import { navigate } from '../lib/router';
import { Button, Hint, Select, SurfaceCard } from './ui';

/**
 * 汇报工作台。
 *
 * 左边的顺序是「先生成、再从历史里挑」，右边是编辑区。
 * 阅读视图不是花架子：草稿本身是 Markdown，直接读 `| 需求 | 当前阶段 |` 那种源码很费神，
 * 而这份东西是要发给主管的 —— 发之前总得通读一遍。
 */
export function Reports({ reportId }: { reportId: number | null }) {
  const queryClient = useQueryClient();
  const notice = useNotice();

  const [draft, setDraft] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState('default');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'read' | 'source'>('read');
  const [copied, setCopied] = useState(false);

  const list = useQuery({ queryKey: ['reports'], queryFn: api.listReports });
  const reports = list.data?.reports ?? [];
  const templates = list.data?.templates ?? [];
  const selected = reports.find((r) => r.id === reportId) ?? reports[0] ?? null;

  // 切换选中的汇报时丢掉未保存的编辑内容（避免把 A 的修改写进 B）
  useEffect(() => {
    setDraft(null);
  }, [selected?.id]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

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
    <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-5 lg:grid-cols-12">
      {/* ---------- 左：生成 + 历史 ---------- */}
      <aside className="space-y-3 lg:col-span-4">
        <SurfaceCard title="生成新草稿">
          <div className="space-y-2.5 p-4">
            <Button
              variant="primary"
              className="w-full"
              disabled={busy}
              onClick={() => void generate()}
            >
              {busy ? '生成中…' : '生成汇报草稿'}
            </Button>

            {templates.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-slate-500">
                模板
                <Select
                  value={templateKey}
                  onChange={(e) => setTemplateKey(e.target.value)}
                  className="flex-1 text-xs"
                >
                  {templates.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </label>
            )}

            <p className="text-[11px] leading-relaxed text-slate-500">
              区间从<strong className="text-slate-400">上一次定稿</strong>的结束时间开始，到现在。
              <strong className="text-slate-400">定稿</strong>
              之后，它的结束时间就成为下一次的起点 ——
              这就是「两次汇报之间发生了什么」能自动成立的原因。
            </p>
          </div>
        </SurfaceCard>

        {list.isLoading && <Hint>加载中…</Hint>}
        {list.error && <Hint tone="error">{messageOf(list.error)}</Hint>}
        {reports.length === 0 && !list.isLoading && (
          <Hint>还没有汇报。点上面生成第一份草稿。</Hint>
        )}

        {reports.length > 0 && (
          <div className="space-y-1.5">
            {reports.map((r) => {
              const active = r.id === selected?.id;
              return (
                <button
                  key={r.id}
                  onClick={() => navigate({ name: 'reports', reportId: r.id })}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                    active
                      ? 'border-indigo-500/40 bg-indigo-500/10'
                      : 'border-white/[0.07] bg-[#161C28]/70 hover:border-white/[0.14]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs text-slate-200">
                      {fmtLocalDay(r.period_start)} ~ {fmtLocalDay(r.period_end)}
                    </span>
                    <span
                      className={`ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
                        r.finalized_at
                          ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                          : 'border-amber-500/30 bg-amber-500/15 text-amber-300'
                      }`}
                    >
                      {r.finalized_at ? '已定稿' : '草稿'}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-slate-600">
                    生成于 {fmtTime(r.created_at)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </aside>

      {/* ---------- 右：预览 / 编辑 ---------- */}
      <section className="min-w-0 lg:col-span-8">
        {!selected ? (
          <SurfaceCard>
            <div className="px-4 py-12 text-center text-sm text-slate-500">
              左边点「生成汇报草稿」开始。
            </div>
          </SurfaceCard>
        ) : (
          <SurfaceCard
            title={
              <span className="flex items-center gap-2">
                <span className="text-sm text-slate-100">{selected.title}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    selected.finalized_at
                      ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                      : 'border-amber-500/30 bg-amber-500/15 text-amber-300'
                  }`}
                >
                  {selected.finalized_at ? `已定稿 ${fmtTime(selected.finalized_at)}` : '草稿'}
                </span>
              </span>
            }
            extra={
              <>
                <button
                  className="rounded-lg border border-white/[0.08] px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.06]"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(text)
                      .then(() => setCopied(true))
                      .catch((err: unknown) => notice.fail(messageOf(err)));
                  }}
                >
                  {copied ? '已复制 Markdown ✓' : '复制 Markdown'}
                </button>

                {selected.finalized_at ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api.unfinalizeReport(selected.id),
                        '已取消定稿，可以继续编辑',
                      )
                    }
                  >
                    取消定稿
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!dirty || busy}
                      onClick={() =>
                        void run(
                          () => api.updateReport(selected.id, { contentMd: text }),
                          '草稿已保存',
                        )
                      }
                    >
                      {dirty ? '保存' : '已保存'}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(() => api.deleteReport(selected.id), '草稿已删除').then(() =>
                          navigate({ name: 'reports', reportId: null }),
                        )
                      }
                    >
                      删除
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api.finalizeReport(selected.id),
                          '已定稿 —— 下次生成会从这里接着算',
                        )
                      }
                    >
                      定稿
                    </Button>
                  </>
                )}
              </>
            }
          >
            <div className="p-3">
              <div className="mb-2.5 flex items-center gap-2">
                <div className="flex rounded-lg border border-white/[0.08] p-0.5">
                  <ModeButton active={mode === 'read'} onClick={() => setMode('read')}>
                    阅读视图
                  </ModeButton>
                  <ModeButton active={mode === 'source'} onClick={() => setMode('source')}>
                    Markdown 源码
                  </ModeButton>
                </div>
                {!selected.finalized_at && (
                  <p className="text-[11px] text-slate-500">
                    改完点「定稿」，它的结束时间会成为下一次的起点
                  </p>
                )}
              </div>

              {mode === 'read' ? (
                <div className="max-h-[calc(100vh-260px)] overflow-y-auto rounded-xl border border-white/[0.07] bg-[#1C2333] p-5">
                  <MarkdownView md={text} />
                </div>
              ) : (
                <textarea
                  value={text}
                  readOnly={selected.finalized_at !== null}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={30}
                  spellCheck={false}
                  className={`max-h-[calc(100vh-260px)] w-full resize-y rounded-xl border border-white/[0.07] bg-[#1C2333] p-4 font-mono text-[12.5px] leading-relaxed text-slate-200 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 ${
                    selected.finalized_at ? 'opacity-70' : ''
                  }`}
                />
              )}
            </div>
          </SurfaceCard>
        )}
      </section>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
        active ? 'bg-indigo-500/15 text-indigo-300' : 'text-slate-500 hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 极简 Markdown 阅读视图。
 *
 * 只覆盖报告模板真正用到的那几种语法：标题、无序/有序列表、粗体、行内代码、
 * 引用、分割线、表格。**故意不引 Markdown 库** —— 内网装包是不可控风险，
 * 而这里要的只是「读得下去」，不是通用渲染。遇到不认识的块就原样输出，
 * 不会把内容吃掉（读不懂就切到源码视图，那份才是权威）。
 */
function MarkdownView({ md }: { md: string }) {
  const blocks = parseBlocks(md);
  return (
    <div className="space-y-3 text-[13px] leading-relaxed text-slate-300">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h1':
            return (
              <h1 key={i} className="text-base font-semibold tracking-tight text-slate-100">
                {inline(b.text)}
              </h1>
            );
          case 'h2':
            return (
              <h2
                key={i}
                className="mt-5 border-b border-white/[0.07] pb-1 text-sm font-semibold tracking-tight text-slate-100"
              >
                {inline(b.text)}
              </h2>
            );
          case 'h3':
            return (
              <h3 key={i} className="mt-3 text-[13px] font-semibold text-slate-200">
                {inline(b.text)}
              </h3>
            );
          case 'hr':
            return <hr key={i} className="border-white/[0.07]" />;
          case 'quote':
            return (
              <blockquote
                key={i}
                className="border-l-2 border-indigo-500/40 pl-3 text-slate-400"
              >
                {inline(b.text)}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={i} className="space-y-1 pl-4">
                {b.items.map((it, j) => (
                  <li key={j} className="list-disc marker:text-slate-600">
                    {inline(it)}
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={j} className="list-decimal text-slate-300 marker:text-slate-600">
                    {inline(it)}
                  </li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <div key={i} className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.10]">
                      {b.head.map((h, j) => (
                        <th key={j} className="px-2 py-1.5 text-left font-medium text-slate-400">
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j} className="border-b border-white/[0.05] last:border-0">
                        {row.map((c, k) => (
                          <td key={k} className="px-2 py-1.5 text-slate-300">
                            {inline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return (
              <p key={i} className="whitespace-pre-wrap">
                {inline(b.text)}
              </p>
            );
        }
      })}
    </div>
  );
}

type Block =
  | { kind: 'h1' | 'h2' | 'h3' | 'p' | 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] };

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
  const cells = (s: string) =>
    s
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '') {
      i++;
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      out.push({ kind: 'hr' });
      i++;
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) {
      const depth = h[1]!.length;
      out.push({ kind: depth === 1 ? 'h1' : depth === 2 ? 'h2' : 'h3', text: h[2]! });
      i++;
      continue;
    }

    // 表格：表头 + 分隔行 + 若干行
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(cells(lines[i]!));
        i++;
      }
      out.push({ kind: 'table', head, rows });
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      out.push({ kind: 'ul', items });
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      out.push({ kind: 'ol', items });
      continue;
    }

    if (trimmed.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        buf.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push({ kind: 'quote', text: buf.join(' ') });
      continue;
    }

    // 普通段落：连续非空行合并
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(#{1,3}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(lines[i]!.trim())) {
      buf.push(lines[i]!.trim());
      i++;
    }
    if (buf.length === 0) {
      // 保险：不认识的行原样输出，避免死循环或吞内容
      buf.push(trimmed);
      i++;
    }
    out.push({ kind: 'p', text: buf.join(' ') });
  }

  return out;
}

/** 行内格式：**粗体**、`代码`。返回 React 节点数组 */
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) {
      parts.push(
        <strong key={m.index} className="font-semibold text-slate-100">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      parts.push(
        <code
          key={m.index}
          className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px] text-indigo-300"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
