import { useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { messageOf } from '../lib/notice';

// ---------------------------------------------------------------------------
// 设计令牌
//
// 一律用这几档语义类名，组件里别再散写 bg-zinc-900 / border-zinc-800：
//   Level 0 画布   bg-[#0D1117]
//   Level 1 侧栏/抽屉 bg-[#11161F]  border-white/[0.07]
//   Level 2 卡片   bg-[#161C28]/90 border-white/[0.07] hover:border-white/[0.14]
//   Level 3 内嵌块  bg-[#1C2333]    border-white/[0.08]
//   Level 4 悬浮态  bg-white/[0.04] hover:bg-white/[0.07]
// ---------------------------------------------------------------------------

/** 表面色，供需要手写容器的地方引用 */
export const surface = {
  card: 'rounded-xl bg-[#161C28]/90 border border-white/[0.07] hover:border-white/[0.14] shadow-sm',
  inset: 'rounded-xl bg-[#1C2333] border border-white/[0.08]',
  panel: 'bg-[#11161F] border border-white/[0.07]',
} as const;

/** 输入类控件。**宽度保持中性**（不要内置 w-full），调用方照旧按需拼宽度 */
export const inputCls =
  'rounded-lg border border-white/[0.10] bg-[#0D1117]/90 px-2.5 py-1.5 text-slate-100 placeholder:text-slate-600 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20';

export const btnGhost =
  'rounded-lg border border-white/[0.08] px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.06] hover:text-slate-100 disabled:opacity-40';

export const btnPrimary =
  'rounded-lg bg-indigo-500 px-3 py-1 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-400 disabled:opacity-40 disabled:hover:bg-indigo-500';

export const btnDanger =
  'rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-300 transition-colors hover:bg-rose-500/20 hover:text-rose-200 disabled:opacity-40';

/** 等宽编号/日期/路径的统一写法 */
export const mono = 'font-mono text-xs text-indigo-400';

// ---------------------------------------------------------------------------
// 原子组件
// ---------------------------------------------------------------------------

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  const variants = {
    primary: 'bg-indigo-500 hover:bg-indigo-400 text-white border border-indigo-400/20',
    secondary: 'bg-[#1C2333] hover:bg-white/[0.08] text-slate-200 border border-white/[0.08]',
    ghost: 'bg-transparent hover:bg-white/[0.05] text-slate-300 border border-transparent',
    danger: 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30',
  };
  const sizes = {
    sm: 'px-2.5 py-1 text-xs rounded-lg',
    md: 'px-3.5 py-1.5 text-xs rounded-lg',
  };
  return (
    <button
      className={`inline-flex cursor-pointer items-center justify-center gap-1.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputCls} w-full ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${inputCls} ${className}`} {...props}>
      {children}
    </select>
  );
}

/**
 * Level 2 卡片。标题栏可选，用来替代原来那种「实线框 + 灰头」的后台风。
 *
 * `highlight` 是给拖放高亮这类「整块卡片要变色」的场景准备的：边框和底色**在这里一处决定**，
 * 调用方不用靠 `!important` 去压 `surface.card` 里的同名类 —— 那样能 work，
 * 但下次谁改了 SurfaceCard 的底色，就会莫名把高亮弄坏。
 */
export function SurfaceCard({
  title,
  extra,
  highlight = false,
  className = '',
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> & {
  title?: ReactNode;
  extra?: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border shadow-sm transition-colors ${
        highlight
          ? 'border-indigo-400/60 bg-indigo-500/5'
          : 'border-white/[0.07] bg-[#161C28]/90 hover:border-white/[0.14]'
      } ${className}`}
      {...props}
    >
      {(title || extra) && (
        <header className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
          {title && <h3 className="text-xs font-semibold tracking-tight text-slate-200">{title}</h3>}
          {extra && <div className="ml-auto flex items-center gap-2">{extra}</div>}
        </header>
      )}
      {children}
    </div>
  );
}

/**
 * 右滑抽屉（Level 1 表面）。
 *
 * 点遮罩或 ✕ 关闭，Esc 也关。**它只负责壳** —— 里面放什么由调用方决定，
 * 这样同一个壳既能放只读预览，也能放可编辑面板。
 */
export function SlideOverDrawer({
  open,
  onClose,
  title,
  badge,
  width = 'max-w-xl',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  badge?: ReactNode;
  width?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      className="animate-overlay-in fixed inset-0 z-40 flex justify-end bg-black/55 backdrop-blur-xs"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`animate-drawer-in flex h-full w-full ${width} flex-col overflow-hidden border-l border-white/[0.08] bg-[#11161F] shadow-2xl`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.07] px-5">
          <div className="flex min-w-0 items-center gap-2">
            {badge && (
              <span className="rounded bg-indigo-500/15 px-2 py-0.5 font-mono text-xs font-semibold text-indigo-400">
                {badge}
              </span>
            )}
            {title && <span className="truncate text-xs text-slate-400">{title}</span>}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
            title="关闭（Esc）"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 表单与容器
// ---------------------------------------------------------------------------

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-500">{label}</span>
      {children}
    </label>
  );
}

export function Hint({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return (
    <div className={`py-6 text-sm ${tone === 'error' ? 'text-rose-300' : 'text-slate-500'}`}>
      {children}
    </div>
  );
}

/** 带标题的分段容器。等价于无 extra 的 SurfaceCard，保留旧名字供现有页面使用 */
export function Panel({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SurfaceCard title={title} extra={extra}>
      <div className="p-4">{children}</div>
    </SurfaceCard>
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
            ? `${mono} text-sm hover:text-indigo-300`
            : 'rounded-md border border-dashed border-white/[0.14] px-1.5 text-[11px] text-slate-600 hover:border-white/[0.24] hover:text-slate-400'
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
        className="text-xs text-indigo-400 transition-colors hover:text-indigo-300 disabled:opacity-40"
      >
        {busy ? '…' : '改'}
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="text-xs text-slate-500 transition-colors hover:text-slate-300"
      >
        取消
      </button>
      {error && <span className="text-[11px] text-rose-400">{error}</span>}
    </span>
  );
}
