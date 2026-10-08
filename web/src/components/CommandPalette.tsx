import { useEffect, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaletteCandidate } from '@manager/shared';
import { api } from '../api';
import { navigate } from '../lib/router';
import { messageOf, useNotice } from '../lib/notice';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 界面当前打开的需求，供不带 #REQ 的命令使用 */
  currentItemId: number | null;
}

/**
 * 命令面板。
 *
 * 键盘分工（这是这个组件里唯一需要想清楚的事）：
 *   Tab   = 补全。方向键选过就用选中的那条，否则补到所有候选的**最长公共前缀**
 *   Enter = 执行当前输入（命令模式）或跳转到选中项（搜索模式）
 *   ↑↓    = 选择
 *   鼠标点 = 命令模式下补全（别把正在写的命令冲掉），搜索模式下跳转
 */
export function CommandPalette({ open, onOpenChange, currentItemId }: Props) {
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState('');
  /** 用户有没有用方向键挑过。没用过时 Tab 走「公共前缀」逻辑 */
  const [navigated, setNavigated] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const cursorRef = useRef<number | null>(null);
  /** onSelect 分不出「回车」和「鼠标点」，点的时候先记一笔 */
  const mouseRef = useRef(false);

  const queryClient = useQueryClient();
  const notice = useNotice();

  useEffect(() => {
    if (open) {
      setInput('');
      setSelected('');
      setNavigated(false);
    }
  }, [open]);

  // 输入一变就重新开始挑
  useEffect(() => {
    setNavigated(false);
  }, [input]);

  // 补全之后把光标放到插入内容之后，方便接着敲
  useEffect(() => {
    const el = inputRef.current;
    if (el && cursorRef.current !== null) {
      el.setSelectionRange(cursorRef.current, cursorRef.current);
      cursorRef.current = null;
    }
  }, [input]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const query = useQuery({
    queryKey: ['palette', input, currentItemId],
    queryFn: () => api.paletteQuery(input, currentItemId),
    enabled: open,
    placeholderData: (prev) => prev,
  });

  if (!open) return null;

  const result = query.data;
  const candidates = result?.candidates ?? [];

  function candidateAt(value: string): PaletteCandidate | undefined {
    const index = Number(value.replace('cand-', ''));
    return Number.isInteger(index) ? candidates[index] : undefined;
  }

  /** 把「正在输入的那一段」换成 insert */
  function applyInsert(insert: string): void {
    const token = result?.completion?.token;
    if (token === undefined) {
      // 没有补全上下文（纯搜索）：整体替换 —— 把模糊搜索变成精确引用
      setInput(insert);
      cursorRef.current = insert.length;
      return;
    }

    const found = input.lastIndexOf(token);
    const at = found < 0 ? input.length : found;
    setInput(input.slice(0, at) + insert + input.slice(at + token.length));
    cursorRef.current = at + insert.length;
  }

  function handleTab(): void {
    const highlighted = navigated ? candidateAt(selected) : undefined;
    if (highlighted?.insert) {
      applyInsert(highlighted.insert);
      return;
    }

    const completion = result?.completion;
    if (!completion) return;

    const inserts = candidates
      .map((c) => c.insert)
      .filter((x): x is string => x !== undefined);

    if (inserts.length === 1) {
      applyInsert(inserts[0]!);
      return;
    }

    // 补到第一个不一样的字符。
    // 只有真能延长当前这段才动 —— 否则会把 `#接口` 换成毫不相干的 `#REQ-`，
    // 那是在帮倒忙。这种情况让用户用方向键挑一条。
    const prefix = completion.commonPrefix;
    if (prefix.length > completion.token.length && prefix.startsWith(completion.token)) {
      applyInsert(prefix);
    }
  }

  async function execute(text: string): Promise<void> {
    try {
      const res = await api.paletteExecute(text, currentItemId);
      void queryClient.invalidateQueries();
      notice.ok(res.message);
      if (res.navigate) {
        if (res.navigate.kind === 'item') {
          navigate({
            name: 'item',
            id: res.navigate.itemId,
            stageId: res.navigate.stageId ?? null,
          });
        } else if (res.navigate.kind === 'search') {
          navigate({ name: 'search', q: res.navigate.q });
        } else {
          navigate({ name: 'reports', reportId: res.navigate.reportId });
        }
      }
      onOpenChange(false);
    } catch (err) {
      notice.fail(messageOf(err));
    }
  }

  function choose(candidate: PaletteCandidate, viaMouse: boolean): void {
    // 命令模式：鼠标点 = 补全（别把正在写的命令冲掉），回车 = 执行
    if (result?.mode === 'command') {
      if (viaMouse && candidate.insert) {
        applyInsert(candidate.insert);
        return;
      }
      void execute(input);
      return;
    }

    // 搜索模式
    if (candidate.kind === 'jump' && candidate.itemId !== undefined) {
      navigate({ name: 'item', id: candidate.itemId, stageId: null });
      onOpenChange(false);
      return;
    }
    // 垫底的「在全文里搜」带的是完整命令
    if (candidate.run) {
      void execute(candidate.run);
      return;
    }
    if (candidate.command) {
      void execute(`/${candidate.command}`);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh]"
      onMouseDown={() => onOpenChange(false)}
    >
      <Command
        shouldFilter={false}
        loop
        value={selected}
        onValueChange={setSelected}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setNavigated(true);
        }}
        className="w-[min(760px,94vw)] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Command.Input
          ref={inputRef}
          autoFocus
          value={input}
          onValueChange={setInput}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              handleTab();
            }
          }}
          placeholder="搜索需求，或输入 / 开头的命令（Tab 补全）"
          className="w-full border-b border-zinc-800 bg-transparent px-4 py-3 text-zinc-100 outline-none placeholder:text-zinc-500"
        />

        {result?.preview && (
          <div className="border-b border-zinc-800 bg-zinc-800/40 px-4 py-2 text-xs text-zinc-300">
            <span className="text-zinc-500">将要执行：</span> {result.preview}
          </div>
        )}

        {result?.error && (
          <div className="border-b border-zinc-800 px-4 py-2 text-xs text-amber-300">
            {result.error}
          </div>
        )}

        <Command.List className="max-h-[52vh] overflow-y-auto py-1">
          {query.isLoading && <div className="px-4 py-3 text-xs text-zinc-500">查询中…</div>}

          <Command.Empty className="px-4 py-6 text-center text-xs text-zinc-500">
            没有匹配项
          </Command.Empty>

          {candidates.map((cand, i) => (
            <Command.Item
              key={`${cand.kind}-${cand.insert ?? cand.label}-${i}`}
              value={`cand-${i}`}
              onMouseDown={() => {
                mouseRef.current = true;
              }}
              onSelect={() => {
                const viaMouse = mouseRef.current;
                mouseRef.current = false;
                choose(cand, viaMouse);
              }}
              className="flex cursor-pointer items-baseline gap-2 border-l-2 border-transparent px-4 py-2 data-[selected=true]:border-sky-400 data-[selected=true]:bg-zinc-800"
            >
              <span className="text-zinc-500">{cand.kind === 'command' ? '/' : '·'}</span>
              <span className="text-zinc-100">{cand.label}</span>
              {cand.insert && (
                <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-500" title="按 Tab 补全">
                  ⇥ {cand.insert}
                </span>
              )}
              <span className="ml-auto truncate text-xs text-zinc-500">{cand.detail}</span>
            </Command.Item>
          ))}
        </Command.List>

        <div className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">
          Tab 补全 · #REQ 指定需求 · @阶段 指定阶段 · ↑↓ 选择 · Enter 执行 · Esc 关闭
        </div>
      </Command>
    </div>
  );
}
