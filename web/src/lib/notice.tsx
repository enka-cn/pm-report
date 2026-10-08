import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * 极简提示条。命令面板、挂起、推进这些操作都需要明确的成功/失败反馈 ——
 * 本地工具没有日志面板，操作完没反应会让人以为没生效。
 */

export interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

interface NoticeApi {
  notice: Notice | null;
  ok: (text: string) => void;
  fail: (text: string) => void;
  clear: () => void;
}

const NoticeContext = createContext<NoticeApi | null>(null);

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);

  const ok = useCallback((text: string) => setNotice({ kind: 'ok', text }), []);
  const fail = useCallback((text: string) => setNotice({ kind: 'error', text }), []);
  const clear = useCallback(() => setNotice(null), []);

  const value = useMemo<NoticeApi>(() => ({ notice, ok, fail, clear }), [notice, ok, fail, clear]);

  return <NoticeContext.Provider value={value}>{children}</NoticeContext.Provider>;
}

export function useNotice(): NoticeApi {
  const ctx = useContext(NoticeContext);
  if (!ctx) throw new Error('useNotice 必须在 NoticeProvider 内使用');
  return ctx;
}

/** 把任意异常转成能给用户看的一句话 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
