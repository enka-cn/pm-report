import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CommandPalette } from './components/CommandPalette';
import { Dashboard } from './components/Dashboard';
import { ItemDetail } from './components/ItemDetail';
import { ItemList } from './components/ItemList';
import { ProjectDetail } from './components/ProjectDetail';
import { Projects } from './components/Projects';
import { Reports } from './components/Reports';
import { Search } from './components/Search';
import { Pipelines } from './components/Pipelines';
import { NoticeProvider, messageOf, useNotice } from './lib/notice';
import { api } from './api';
import { navigate, useRoute } from './lib/router';
import { Select, inputCls } from './components/ui';

export default function App() {
  return (
    <NoticeProvider>
      <Shell />
    </NoticeProvider>
  );
}

// ---------------------------------------------------------------------------
// 内联图标（不引图标库：内网装包是不可控风险，而这里只需要六个 24px 描边图形）
// ---------------------------------------------------------------------------

const ICONS = {
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  items: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  projects: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  reports: 'M7 3h7l5 5v13H7zM14 3v5h5M9 13h7M9 17h5',
  pipelines: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
  note: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  collapse: 'M15 19l-7-7 7-7',
  expand: 'M9 5l7 7-7 7',
} as const;

function Icon({ name, className = '' }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 shrink-0 ${className}`}
      aria-hidden
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

// ---------------------------------------------------------------------------

/** 侧栏折叠状态存起来：这是个人偏好，每次刷新都让它展开很烦 */
const COLLAPSE_KEY = 'manager.sidebarCollapsed';

function Shell() {
  const route = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem(COLLAPSE_KEY) === '1',
  );

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const currentItemId = route.name === 'item' ? route.id : null;
  const viewTitle = viewTitleOf(route.name);

  return (
    <div className="relative flex h-full overflow-hidden bg-[#0D1117] text-slate-100">
      <div className="ambient-top-glow" />

      {/* ---- 左侧工作台 ---- */}
      <aside
        className={`relative z-20 flex shrink-0 flex-col bg-[#11161F] transition-[width] duration-200 ${
          collapsed ? 'w-16' : 'w-60'
        } border-r border-white/[0.07]`}
      >
        <div className={`flex h-14 items-center gap-2 ${collapsed ? 'justify-center' : 'px-4'}`}>
          {!collapsed && (
            <span className="text-sm font-semibold tracking-tight text-slate-100">项目管理</span>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? '展开侧栏' : '折叠侧栏'}
            className={`rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 ${
              collapsed ? '' : 'ml-auto'
            }`}
          >
            <Icon name={collapsed ? 'expand' : 'collapse'} />
          </button>
        </div>

        {/* 搜索入口：不再占一个导航页，搜索就该走命令面板 */}
        <div className={collapsed ? 'px-2' : 'px-3'}>
          <button
            onClick={() => setPaletteOpen(true)}
            title="命令面板（Ctrl K）"
            className={`flex w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] text-xs text-slate-400 transition-colors hover:border-white/[0.16] hover:text-slate-200 ${
              collapsed ? 'justify-center px-0 py-2' : 'px-2.5 py-1.5'
            }`}
          >
            <Icon name="search" />
            {!collapsed && (
              <>
                <span>搜索 / 命令</span>
                <kbd className="ml-auto rounded border border-white/[0.08] bg-white/[0.04] px-1 font-mono text-[10px] text-slate-500">
                  Ctrl K
                </kbd>
              </>
            )}
          </button>
        </div>

        <nav className="mt-4 flex-1 space-y-4 overflow-y-auto px-2">
          <NavGroup label="日常跟踪" collapsed={collapsed}>
            <NavItem
              icon="dashboard"
              label="驾驶舱"
              collapsed={collapsed}
              active={route.name === 'dashboard'}
              onClick={() => navigate({ name: 'dashboard' })}
            />
            <NavItem
              icon="items"
              label="需求流转"
              collapsed={collapsed}
              active={route.name === 'items' || route.name === 'item'}
              onClick={() => navigate({ name: 'items' })}
            />
            <NavItem
              icon="projects"
              label="看护项目"
              collapsed={collapsed}
              active={route.name === 'projects'}
              onClick={() => navigate({ name: 'projects', projectId: null })}
            />
          </NavGroup>

          <NavGroup label="输出与配置" collapsed={collapsed}>
            <NavItem
              icon="reports"
              label="汇报"
              collapsed={collapsed}
              active={route.name === 'reports'}
              onClick={() => navigate({ name: 'reports', reportId: null })}
            />
            <NavItem
              icon="pipelines"
              label="流水线"
              collapsed={collapsed}
              active={route.name === 'pipelines'}
              onClick={() => navigate({ name: 'pipelines' })}
            />
          </NavGroup>
        </nav>

        {/* 底部不放假的数据（没有 git 集成就没有 git 卡片），只放真用得上的提示 */}
        {!collapsed && (
          <div className="m-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-slate-500">
            <div className="mb-1 font-medium text-slate-400">顺手的两件事</div>
            <div>
              <kbd className="rounded border border-white/[0.08] px-1 font-mono text-[10px]">Ctrl K</kbd>{' '}
              命令面板：`/log` 记进展、`/todo` 加待办
            </div>
            <div className="mt-1">上面那条「记一笔」可以随手写一句，回车就归档</div>
          </div>
        )}
      </aside>

      {/* ---- 右侧主视图 ---- */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.07] bg-[#11161F]/80 px-6 backdrop-blur-md">
          <h1 className="text-sm font-semibold tracking-tight text-slate-100">{viewTitle}</h1>
          {route.name === 'search' && route.q && (
            <span className="truncate text-xs text-slate-500">「{route.q}」</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => navigate({ name: 'reports', reportId: null })}
              className="rounded-lg border border-white/[0.08] px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.06] hover:text-slate-100"
              title="去汇报页生成一份草稿"
            >
              生成汇报
            </button>
          </div>
        </header>

        {/*
          需求详情页有自己的「记一条进展」，而且那是**绑定当前需求**的。
          这一条带需求下拉，两个输入框同时出现会让人不知道该用哪个；
          在详情页上那个作用域明确的更该赢。
        */}
        {route.name !== 'item' && <QuickCapture />}

        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {route.name === 'dashboard' && <Dashboard />}
          {route.name === 'items' && <ItemList />}
          {route.name === 'item' && <ItemDetail id={route.id} stageId={route.stageId} />}
          {route.name === 'reports' && <Reports reportId={route.reportId} />}
          {route.name === 'search' && <Search q={route.q} />}
          {route.name === 'pipelines' && <Pipelines />}
          {route.name === 'projects' &&
            (route.projectId === null ? (
              <Projects />
            ) : (
              <ProjectDetail projectId={route.projectId} />
            ))}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        currentItemId={currentItemId}
      />

      <NoticeBar />
    </div>
  );
}

function viewTitleOf(name: string): string {
  switch (name) {
    case 'dashboard':
      return '驾驶舱';
    case 'items':
      return '需求流转';
    case 'item':
      return '需求详情';
    case 'projects':
      return '看护项目';
    case 'reports':
      return '汇报';
    case 'pipelines':
      return '流水线';
    case 'search':
      return '搜索';
    default:
      return '项目管理';
  }
}

function NavGroup({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      {!collapsed && (
        <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-slate-600">
          {label}
        </div>
      )}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: keyof typeof ICONS;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={`flex w-full items-center gap-2 rounded-lg text-xs transition-colors ${
        collapsed ? 'justify-center px-0 py-2' : 'px-2.5 py-1.5'
      } ${
        active
          ? 'bg-indigo-500/15 font-medium text-indigo-300'
          : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
      }`}
    >
      <Icon name={icon} />
      {!collapsed && <span>{label}</span>}
    </button>
  );
}

/**
 * 常驻「只言片语随手记」。
 *
 * 碎片进展是这类工作里最高频的记录动作，它不该需要先按 Ctrl K 再敲 `/log`。
 * 这里直接一行：选需求 → 写一句 → 回车。落到服务端就是一条 note 事件（会进时间线、
 * 也会进下次汇报的「本区间进展」）。
 */
function QuickCapture() {
  const route = useRoute();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [itemId, setItemId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useQuery({ queryKey: ['items', { quick: true }], queryFn: () => api.listItems({}) });
  const list = useMemo(() => items.data?.items ?? [], [items.data]);

  // 在需求详情页时默认选中它自己 —— 你最可能记的就是当前这条
  const routeItemId = route.name === 'item' ? route.id : null;
  const effectiveId =
    itemId ??
    (routeItemId !== null && list.some((i) => i.id === routeItemId) ? routeItemId : (list[0]?.id ?? null));

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const target = effectiveId;
    const body = text.trim();
    if (target === null || !body) return;

    setBusy(true);
    setError(null);
    try {
      await api.note(target, body);
      await queryClient.invalidateQueries();
      setText('');
      // 成功不弹 toast：输入框被清空、按钮变灰，本身就是最好的反馈
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (items.isLoading || list.length === 0) return null;

  return (
    <div className="shrink-0 px-6 pt-3">
      <form
        onSubmit={(e) => void submit(e)}
        className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-[#161C28]/70 px-3 py-1.5"
      >
        <Icon name="note" className="text-slate-600" />
        <Select
          value={effectiveId ?? ''}
          onChange={(e) => setItemId(Number(e.target.value))}
          className={`${inputCls} max-w-[16rem] shrink-0 border-transparent bg-transparent py-0.5 text-xs`}
          title="记到哪条需求上"
        >
          {list.map((i) => (
            <option key={i.id} value={i.id}>
              {i.ref}
            </option>
          ))}
        </Select>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="随手记一句进展，回车归档到时间线（也会进下次汇报）"
          className="min-w-0 flex-1 border-0 bg-transparent px-1 text-xs text-slate-200 outline-none placeholder:text-slate-600"
        />
        {error && <span className="shrink-0 text-[11px] text-rose-400">{error}</span>}
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="shrink-0 rounded-lg bg-indigo-500/90 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-indigo-400 disabled:bg-white/[0.06] disabled:text-slate-500"
        >
          {busy ? '记录中…' : '记一笔'}
        </button>
      </form>
    </div>
  );
}

function NoticeBar() {
  const { notice, clear } = useNotice();

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(clear, notice.kind === 'error' ? 9000 : 5000);
    return () => window.clearTimeout(timer);
  }, [notice, clear]);

  if (!notice) return null;

  return (
    <div
      onClick={clear}
      className={`animate-overlay-in fixed bottom-5 left-1/2 z-40 max-w-[80vw] -translate-x-1/2 cursor-pointer rounded-xl border px-4 py-2 text-sm shadow-2xl backdrop-blur-md ${
        notice.kind === 'error'
          ? 'border-rose-500/30 bg-rose-950/85 text-rose-200'
          : 'border-white/[0.10] bg-[#11161F]/95 text-slate-200'
      }`}
      title="点击关闭"
    >
      {notice.text}
    </div>
  );
}
