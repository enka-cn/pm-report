import { useRef, useState, type ReactNode } from 'react';
import { messageOf } from '../lib/notice';

export const inputCls =
  'rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 outline-none focus:border-zinc-500';

export const btnGhost =
  'rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100';

export const btnPrimary =
  'rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600';

export const btnDanger =
  'rounded border border-rose-800 px-2 py-1 text-xs text-rose-300 hover:border-rose-600 hover:text-rose-200';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

export function Hint({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return (
    <div className={`py-6 text-sm ${tone === 'error' ? 'text-amber-300' : 'text-zinc-500'}`}>
      {children}
    </div>
  );
}

export function Panel({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded border border-zinc-800">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <h3 className="text-xs font-medium text-zinc-300">{title}</h3>
        <div className="ml-auto flex items-center gap-2">{extra}</div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** 需要一句话输入的操作（挂起原因、解除说明…）用它，别用 window.prompt */
export function PromptRow({
  placeholder,
  confirmText = '确定',
  onConfirm,
  onCancel,
}: {
  placeholder: string;
  confirmText?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="mt-1 flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const value = new FormData(e.currentTarget).get('value');
        onConfirm(String(value ?? ''));
      }}
    >
      <input
        name="value"
        autoFocus
        required
        placeholder={placeholder}
        className={`${inputCls} flex-1 text-xs`}
      />
      <button type="submit" className={btnGhost}>
        {confirmText}
      </button>
      <button type="button" className={btnGhost} onClick={onCancel}>
        取消
      </button>
    </form>
  );
}

/**
 * 编号的就地编辑：点一下就地变输入框，**不弹窗口**。
 *
 * 编号是「一个你能记住、说得出、打得快的短标识」，改它应该像改文件名一样随手。
 * 弹个 `window.prompt` 会把心流打断 —— 视线要从页面上挪到一个系统对话框上，
 * 改完再挪回来。
 *
 * 两个刻意的行为：
 *   · 保存失败（比如编号带了空格）时**留在编辑态**，把错误显示在输入框旁边 ——
 *     弹个 toast 再把输入框收走的话，你还得再点一次才能改
 *   · 值没变就直接收起，不发请求（免得白白写一条事件）
 */
export function InlineCode({
  code,
  onSave,
}: {
  code: string | null;
  /** 抛错 = 保存失败，错误会就地显示 */
  onSave: (next: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(code ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(code ?? '');
          setError(null);
          setEditing(true);
        }}
        title={
          code
            ? `编号「${code}」，点击修改`
            : '还没有编号。预研 / 算法项目本来就没有单号，不用硬编一个'
        }
        className={
          code
            ? 'font-mono text-sm text-zinc-500 hover:text-zinc-300'
            : 'rounded border border-dashed border-zinc-700 px-1.5 text-[11px] text-zinc-600 hover:border-zinc-500 hover:text-zinc-400'
        }
      >
        {code ?? '＋ 编号'}
      </button>
    );
  }

  async function commit(): Promise<void> {
    const next = value.trim() || null;
    if (next === code) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(messageOf(err)); // 留在编辑态，让人就地改
      // 焦点要还回去。校验失败之后往输入框里接着改，是最自然的下一步 ——
      // 让人再点一次输入框，就又变成了摩擦（这正是当初想消灭弹窗的原因）。
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      <input
        ref={inputRef}
        autoFocus
        value={value}
        // 用 readOnly 而不是 disabled：disabled 会让输入框掉焦点，
        // 请求还没回来你就没法接着改了
        readOnly={busy}
        placeholder="留空 = 没有编号"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
        className={`${inputCls} w-36 py-0.5 font-mono text-sm read-only:opacity-60`}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => void commit()}
        className="text-xs text-sky-400 hover:text-sky-300 disabled:opacity-40"
      >
        {busy ? '…' : '改'}
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="text-xs text-zinc-500 hover:text-zinc-300"
      >
        取消
      </button>
      {error && <span className="text-[11px] text-rose-400">{error}</span>}
    </span>
  );
}
