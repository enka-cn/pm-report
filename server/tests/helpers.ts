import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DashboardBucketKey, DashboardCard, DashboardSection } from '@manager/shared';
import { all, openDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { getItem } from '../src/domain/items.ts';
import { advanceStage, setTodoDone } from '../src/domain/stages.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { todayIso } from '../src/domain/dates.ts';
import { createApp } from '../src/app.ts';

const TEMPLATES = loadPipelines();

/**
 * 起一个挂了真实 HTTP 处理链的应用（Hono 的 app.request，不占端口），
 * 附件写到临时目录，免得测试污染真实 data/files。
 */
export function makeApp() {
  const db = freshDb();
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-files-'));
  return { db, filesDir, app: createApp(db, TEMPLATES, { filesDir }) };
}

/** 真实今天（本地时区）。驾驶舱测试用它作为基准，避免依赖硬编码日期。 */
export const REAL_TODAY = todayIso();

/** 在 'YYYY-MM-DD' 上加减天数 */
export function shift(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function freshDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-test-'));
  const db = openDb(path.join(dir, 'manager.db'));
  migrate(db);
  return db;
}

export function completeStageTodos(db: Db, stageId: number): void {
  for (const t of all<{ id: number }>(db, 'SELECT id FROM todo WHERE stage_id = ?', stageId)) {
    setTodoDone(db, t.id, true);
  }
}

/** 反复推进直到进入指定 key 的阶段，沿途把待办勾完 */
export function advanceUntil(db: Db, itemId: number, targetKey: string): void {
  for (let guard = 0; guard < 50; guard++) {
    const detail = getItem(db, itemId)!;
    const activeId = detail.item.active_stage_id;
    if (activeId === null) throw new Error('没有进行中的阶段了');
    const active = detail.stages.find((s) => s.id === activeId)!;
    if (active.key === targetKey) return;
    completeStageTodos(db, activeId);
    advanceStage(db, { itemId, stageId: activeId });
  }
  throw new Error('推进次数超过上限');
}

export function cardsOf(sections: DashboardSection[], key: DashboardBucketKey): DashboardCard[] {
  const section = sections.find((s) => s.key === key);
  if (!section) throw new Error(`没有这个桶: ${key}`);
  return section.cards;
}

export function codesOf(sections: DashboardSection[], key: DashboardBucketKey): string[] {
  return cardsOf(sections, key).map((c) => c.code);
}
