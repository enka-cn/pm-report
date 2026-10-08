import type { ReactNode } from 'react';

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
