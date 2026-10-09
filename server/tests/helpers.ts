import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DashboardBucketKey,
  DashboardCard,
  DashboardSection,
  ItemDetail,
  PipelineTemplate,
} from '@manager/shared';
import { all, openDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createItem, getItem, type CreateItemInput } from '../src/domain/items.ts';
import { advanceStage, setTodoDone } from '../src/domain/stages.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { todayIso } from '../src/domain/dates.ts';
import { createApp } from '../src/app.ts';
import { PIPELINES_DIR } from '../src/config.ts';

const TEMPLATES = loadPipelines();

/**
 * 起一个挂了真实 HTTP 处理链的应用（Hono 的 app.request，不占端口），
 * 附件写到临时目录，免得测试污染真实 data/files。
 */
export function makeApp() {
  const db = freshDb();
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-files-'));

  // 每个测试一份模板目录的副本。**这一步是必须的**：流水线能在界面上改，
  // 不隔开的话跑一次测试就把仓库里的 config/pipelines 改掉了。
  const pipelinesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-pipelines-'));
  for (const name of fs.readdirSync(PIPELINES_DIR)) {
    fs.copyFileSync(path.join(PIPELINES_DIR, name), path.join(pipelinesDir, name));
  }

  return { db, filesDir, pipelinesDir, app: createApp(db, TEMPLATES, { filesDir, pipelinesDir }) };
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
  // 测试里建的需求都有自动编号。用占位符而不是 null，这样万一混进一个没编号的，
  // 断言失败时看到的是「(无编号)」而不是一个让人摸不着头脑的 null。
  return cardsOf(sections, key).map((c) => c.code ?? '(无编号)');
}

/** 卡片/列表里这个需求的编号显示值。没编号就是占位符（见 codesOf 的说明） */
export function codeOf(x: { code: string | null }): string {
  return x.code ?? '(无编号)';
}

// ---------------------------------------------------------------------------
// 建需求
// ---------------------------------------------------------------------------

let itemSeq = 0;

/**
 * 建一条需求，**默认给一个编号**。
 *
 * 真实使用里编号是可选的（预研/算法项目没有单号），但测试里大多关心编号 ——
 * 断言、命令面板跳转、列表对照全靠它。所以这里默认塞一个 `T-n`。
 *
 * 显式传 `code` 就用传的，**包括显式传 `null`** 来测「没有编号」的场景
 * （对象展开的顺序保证了这一点）。
 */
export function makeItem(
  db: Db,
  templates: PipelineTemplate[],
  input: CreateItemInput,
): ItemDetail {
  return createItem(db, templates, { code: `T-${++itemSeq}`, ...input });
}
