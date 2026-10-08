import { useEffect, useState, type ReactNode } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { Dashboard } from './components/Dashboard';
import { ItemDetail } from './components/ItemDetail';
import { ItemList } from './components/ItemList';
import { ProjectDetail } from './components/ProjectDetail';
import { Projects } from './components/Projects';
import { Reports } from './components/Reports';
import { Search } from './components/Search';
import { NoticeProvider, useNotice } from './lib/notice';
import { navigate, useRoute } from './lib/router';

export default function App() {
  return (
    <NoticeProvider>
      <Shell />
    </NoticeProvider>
  );
}

function Shell() {
  const route = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-200">
      <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <span className="text-sm font-medium text-zinc-100">项目管理</span>

        <nav className="flex items-center gap-1">
          <NavButton
            active={route.name === 'dashboard'}
            onClick={() => navigate({ name: 'dashboard' })}
          >
            驾驶舱
          </NavButton>
          <NavButton
            active={route.name === 'items' || route.name === 'item'}
            onClick={() => navigate({ name: 'items' })}
          >
            需求
          </NavButton>
          <NavButton
            active={route.name === 'search'}
            onClick={() => navigate({ name: 'search', q: null })}
          >
            搜索
          </NavButton>
          <NavButton
            active={route.name === 'projects'}
            onClick={() => navigate({ name: 'projects', projectId: null })}
          >
            项目
          </NavButton>
          <NavButton
            active={route.name === 'reports'}
            onClick={() => navigate({ name: 'reports', reportId: null })}
          >
            汇报
          </NavButton>
        </nav>

        <button
          onClick={() => setPaletteOpen(true)}
          className="ml-auto flex items-center gap-2 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        >
          命令面板
          <kbd className="rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
            Ctrl K
          </kbd>
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {route.name === 'dashboard' && <Dashboard />}
        {route.name === 'items' && <ItemList />}
        {route.name === 'item' && <ItemDetail id={route.id} stageId={route.stageId} />}
        {route.name === 'reports' && <Reports reportId={route.reportId} />}
        {route.name === 'search' && <Search q={route.q} />}
        {route.name === 'projects' &&
          (route.projectId === null ? (
            <Projects />
          ) : (
            <ProjectDetail projectId={route.projectId} />
          ))}
      </main>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        currentItemId={currentItemId}
      />

      <NoticeBar />
    </div>
  );
}

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
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
      className={`fixed bottom-4 left-1/2 z-40 max-w-[80vw] -translate-x-1/2 cursor-pointer rounded border px-3 py-2 text-sm shadow-lg ${
        notice.kind === 'error'
          ? 'border-amber-700 bg-amber-950/90 text-amber-200'
          : 'border-zinc-700 bg-zinc-900/95 text-zinc-200'
      }`}
      title="点击关闭"
    >
      {notice.text}
    </div>
  );
}
