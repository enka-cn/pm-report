import { useEffect, useState } from 'react';

/**
 * 极简 hash 路由。
 *
 * 没有引入 react-router：这个应用只有三个视图，而 hash 路由带来的
 * 「命令面板跳转后地址栏可复制」「刷新不丢位置」这两点，用三十行就够了。
 */

export type Route =
  | { name: 'dashboard' }
  | { name: 'items' }
  | { name: 'item'; id: number; stageId: number | null }
  | { name: 'reports'; reportId: number | null }
  | { name: 'projects'; projectId: number | null }
  | { name: 'search'; q: string | null };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');

  if (path === 'items') return { name: 'items' };
  if (path === 'reports') return { name: 'reports', reportId: null };
  if (path === 'projects') return { name: 'projects', projectId: null };
  if (path === 'search') return { name: 'search', q: null };

  const m = /^items\/(\d+)(?:\/(\d+))?$/.exec(path);
  if (m) {
    return { name: 'item', id: Number(m[1]), stageId: m[2] ? Number(m[2]) : null };
  }

  const r = /^reports\/(\d+)$/.exec(path);
  if (r) return { name: 'reports', reportId: Number(r[1]) };

  const p = /^projects\/(\d+)$/.exec(path);
  if (p) return { name: 'projects', projectId: Number(p[1]) };

  // 搜索词放在 hash 里，刷新和分享都能还原
  const s = /^search\/(.*)$/.exec(path);
  if (s) return { name: 'search', q: safeDecode(s[1]!) };

  return { name: 'dashboard' };
}

/** 手输的 hash 可能带坏掉的百分号转义，别让它把整个界面搞崩 */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'dashboard':
      return '#/';
    case 'items':
      return '#/items';
    case 'item':
      return route.stageId ? `#/items/${route.id}/${route.stageId}` : `#/items/${route.id}`;
    case 'reports':
      return route.reportId === null ? '#/reports' : `#/reports/${route.reportId}`;
    case 'projects':
      return route.projectId === null ? '#/projects' : `#/projects/${route.projectId}`;
    case 'search':
      return route.q ? `#/search/${encodeURIComponent(route.q)}` : '#/search';
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigate(route: Route): void {
  const next = routeToHash(route);
  if (window.location.hash !== next) window.location.hash = next;
}
