import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all } from '../src/db/index.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { createItem, getItem } from '../src/domain/items.ts';
import { listDeliverables, listRemovedDeliverables } from '../src/domain/deliverables.ts';
import { createFolder, folderTree, listFolders, moveDeliverable } from '../src/domain/folders.ts';
import { batchDeliverables } from '../src/domain/batch.ts';
import { listTimeline } from '../src/domain/events.ts';
import { storeFile } from '../src/domain/storage.ts';
import { freshDb, makeApp } from './helpers.ts';

const TEMPLATES = loadPipelines();

function fileIn(text: string, filename: string, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-'))) {
  const stored = storeFile(Buffer.from(text, 'utf8'), dir);
  return {
    sha256: stored.sha256,
    relPath: stored.relPath,
    filename,
    sizeBytes: stored.sizeBytes,
    mime: 'text/plain',
  };
}

/** 造一条需求 + N 个交付物，返回它们的 id */
function seed(db: ReturnType<typeof freshDb>, count: number) {
  const item = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const info = db
      .prepare(
        `INSERT INTO deliverable (item_id, stage_id, name, category, required, created_at, updated_at)
         VALUES (?, NULL, ?, 'other', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run(item.item.id, `文件${i}`);
    ids.push(Number(info.lastInsertRowid));
    void fileIn('x', `f${i}.bin`);
  }
  return { item, ids };
}

// ---------------------------------------------------------------------------

test('批量移动：把整个文件夹的内容一次挪出来（就是那个「建错文件夹」的场景）', () => {
  const db = freshDb();
  const { item, ids } = seed(db, 5);
  const assets = createFolder(db, { itemId: item.item.id, name: 'assets' });
  const deep = createFolder(db, { itemId: item.item.id, parentId: assets.id, name: 'deep' });

  // 前 3 个放进 assets，后 2 个放进 assets/deep
  batchDeliverables(db, { ids: ids.slice(0, 3), action: 'move', folderId: assets.id });
  batchDeliverables(db, { ids: ids.slice(3), action: 'move', folderId: deep.id });

  let tree = folderTree(db, item.item.id);
  assert.equal(tree.children[0]!.files.length, 3);
  assert.equal(tree.children[0]!.children[0]!.files.length, 2);

  // 一次把 5 个全移回根目录
  const result = batchDeliverables(db, { ids, action: 'move', folderId: null });
  assert.equal(result.changed, 5);
  assert.equal(result.unchanged, 0);
  assert.deepEqual(result.missing, []);

  tree = folderTree(db, item.item.id);
  assert.equal(tree.files.length, 5, '全都在根目录了');
  assert.equal(tree.children[0]!.files.length, 0);
  assert.equal(
    all(db, 'SELECT id FROM folder').length,
    2,
    '文件夹还在（空文件夹是允许存在的）',
  );

  db.close();
});

test('批量移动：已经在目标文件夹里的算「没变化」，不算失败', () => {
  const db = freshDb();
  const { item, ids } = seed(db, 3);
  const f = createFolder(db, { itemId: item.item.id, name: 'f' });

  batchDeliverables(db, { ids, action: 'move', folderId: f.id });
  const again = batchDeliverables(db, { ids, action: 'move', folderId: f.id });

  assert.equal(again.changed, 0);
  assert.equal(again.unchanged, 3, '幂等，不该报错');
  db.close();
});

test('批量移动：找不到的 id 会被报告出来，但不影响其他的', () => {
  const db = freshDb();
  const { ids } = seed(db, 2);

  const result = batchDeliverables(db, { ids: [...ids, 99999], action: 'move', folderId: null });
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0], 99999);
  assert.equal(result.changed + result.unchanged, 2, '存在的两条照常处理');

  db.close();
});

test('批量移动：目标文件夹不存在时，动数据之前就报错', () => {
  const db = freshDb();
  const { item, ids } = seed(db, 2);
  const f = createFolder(db, { itemId: item.item.id, name: 'f' });
  batchDeliverables(db, { ids, action: 'move', folderId: f.id });

  assert.throws(
    () => batchDeliverables(db, { ids, action: 'move', folderId: 88888 }),
    /文件夹不存在/,
  );
  assert.equal(listDeliverables(db, item.item.id)[0]!.folder_id, f.id, '原来的归置没被破坏');

  db.close();
});

test('批量移动：一个跨需求就整批回滚 —— 半截生效比失败更糟', () => {
  const db = freshDb();
  const a = seed(db, 2);
  const b = createItem(db, TEMPLATES, { title: '乙', role: 'dev' });
  const foreign = createFolder(db, { itemId: b.item.id, name: '别人的文件夹' });

  // 先都放在根目录，再试图把它们移到「别人的文件夹」
  assert.throws(
    () => batchDeliverables(db, { ids: a.ids, action: 'move', folderId: foreign.id }),
    /别的需求/,
  );

  // 关键是：整批都没动，而不是动了一半
  for (const d of listDeliverables(db, a.item.item.id)) {
    assert.equal(d.folder_id, null, '一条都不该被移动');
  }

  db.close();
});

test('批量移除与恢复，事件一条条留痕', () => {
  const db = freshDb();
  const { item, ids } = seed(db, 4);

  const removed = batchDeliverables(db, { ids: ids.slice(0, 3), action: 'remove', reason: '传错了' });
  assert.equal(removed.changed, 3);
  assert.equal(listDeliverables(db, item.item.id).length, 1);
  assert.equal(listRemovedDeliverables(db, item.item.id).length, 3);

  const events = listTimeline(db, item.item.id).filter((e) => e.type === 'deliverable_removed');
  assert.equal(events.length, 3, '每一份都要能被追溯，不能只留一条「批量移除了 3 个」');
  assert.equal(events[0]!.note, '传错了', '批量给的原因要写进每条事件');

  // 重复移除是幂等的
  const again = batchDeliverables(db, { ids: ids.slice(0, 3), action: 'remove' });
  assert.equal(again.changed, 0);
  assert.equal(again.unchanged, 3);

  const restored = batchDeliverables(db, { ids: ids.slice(0, 3), action: 'restore' });
  assert.equal(restored.changed, 3);
  assert.equal(listDeliverables(db, item.item.id).length, 4);

  assert.equal(
    listTimeline(db, item.item.id).filter((e) => e.type === 'deliverable_restored').length,
    3,
  );

  db.close();
});

test('批量：参数不合法要说人话', () => {
  const db = freshDb();
  const { ids } = seed(db, 1);

  assert.throws(() => batchDeliverables(db, { ids: [], action: 'move' }), /没有选中任何/);
  assert.throws(() => batchDeliverables(db, { ids: [0], action: 'move' }), /id 不合法/);
  assert.throws(() => batchDeliverables(db, { ids: [1.5], action: 'move' }), /id 不合法/);
  assert.throws(
    () => batchDeliverables(db, { ids: Array.from({ length: 1001 }, (_, i) => i + 1), action: 'move' }),
    /一次最多处理 1000 个/,
  );

  // 重复的 id 会被去重，不报错
  const dup = batchDeliverables(db, { ids: [ids[0]!, ids[0]!], action: 'move' });
  assert.equal(dup.changed + dup.unchanged, 1, '去重后只处理一次');

  db.close();
});

test('批量移动不影响阶段 —— 两个轴互不干涉', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const stageId = item.stages[0]!.id;

  const ids = [1, 2].map((i) => {
    const info = db
      .prepare(
        `INSERT INTO deliverable (item_id, stage_id, name, category, required, created_at, updated_at)
         VALUES (?, ?, ?, 'other', 0, 't', 't')`,
      )
      .run(item.item.id, stageId, `文件${i}`);
    return Number(info.lastInsertRowid);
  });

  const f = createFolder(db, { itemId: item.item.id, name: 'f' });
  batchDeliverables(db, { ids, action: 'move', folderId: f.id });

  for (const d of listDeliverables(db, item.item.id)) {
    assert.equal(d.stage_id, stageId, '换文件夹不动阶段');
    assert.equal(d.folder_id, f.id);
  }

  db.close();
});

test('单个移动和批量移动的结果一致', () => {
  const db = freshDb();
  const { item, ids } = seed(db, 2);
  const f = createFolder(db, { itemId: item.item.id, name: 'f' });

  moveDeliverable(db, ids[0]!, f.id);
  batchDeliverables(db, { ids: [ids[1]!], action: 'move', folderId: f.id });

  const rows = listDeliverables(db, item.item.id);
  assert.deepEqual(rows.map((d) => d.folder_id), [f.id, f.id]);
  db.close();
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('HTTP：批量移动 / 移除 / 恢复', async () => {
  const { db, app } = makeApp();
  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'dev' }),
  });
  const detail = (await created.json()) as { item: { id: number }; stages: { id: number }[] };

  const folder = (await (
    await app.request(`/api/items/${detail.item.id}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'assets' }),
    })
  ).json()) as { id: number };

  // 拖三个文件进去（先落根目录）
  const form = new FormData();
  form.set('stageId', String(detail.stages[0]!.id));
  for (let i = 0; i < 3; i++) {
    form.append('file', new File([Buffer.from(`内容${i}`, 'utf8')], `文件${i}.md`));
  }
  await app.request(`/api/items/${detail.item.id}/deliverables/drop`, { method: 'POST', body: form });
  const ids = listDeliverables(db, detail.item.id).map((d) => d.id);
  assert.equal(ids.length, 3);

  const moved = await app.request('/api/deliverables/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, action: 'move', folderId: folder.id }),
  });
  assert.equal(moved.status, 200);
  assert.equal(((await moved.json()) as { changed: number }).changed, 3);
  assert.equal(
    all(db, 'SELECT id FROM deliverable WHERE folder_id = ?', folder.id).length,
    3,
  );

  const removed = await app.request('/api/deliverables/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, action: 'remove', reason: '批量清理' }),
  });
  assert.equal(((await removed.json()) as { changed: number }).changed, 3);

  const restored = await app.request('/api/deliverables/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, action: 'restore' }),
  });
  assert.equal(((await restored.json()) as { changed: number }).changed, 3);
  assert.equal(listDeliverables(db, detail.item.id).length, 3);

  db.close();
});

test('HTTP：批量参数错误', async () => {
  const { db, app } = makeApp();

  const noIds = await app.request('/api/deliverables/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'move' }),
  });
  assert.equal(noIds.status, 400);
  assert.match(((await noIds.json()) as { error: string }).error, /缺少 ids/);

  const badAction = await app.request('/api/deliverables/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [1], action: '炸掉' }),
  });
  assert.equal(badAction.status, 400);
  assert.match(((await badAction.json()) as { error: string }).error, /action 只能是/);

  const empty = await app.request('/api/deliverables/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [], action: 'move' }),
  });
  assert.equal(empty.status, 400);

  // Number([]) 是 0、Number(true) 是 1 —— 直接强转会得到一个看起来合法但完全无关的 id，
  // 然后报出跟原因毫不相干的错（「文件夹不存在: 0」）。所以类型不对就要拦在这里。
  for (const bad of [[], [5], true, {}]) {
    const res = await app.request('/api/deliverables/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [1], action: 'move', folderId: bad }),
    });
    assert.equal(res.status, 400, `folderId=${JSON.stringify(bad)} 应该被拒`);
    assert.match(
      ((await res.json()) as { error: string }).error,
      /folderId 必须是数字/,
      `folderId=${JSON.stringify(bad)} 要报「必须是数字」而不是别的`,
    );
  }

  db.close();
});

test('批量移动后，文件夹的计数立刻对上', () => {
  const db = freshDb();
  const { item, ids } = seed(db, 4);
  const f = createFolder(db, { itemId: item.item.id, name: 'f' });

  assert.equal(folderTree(db, item.item.id).children[0]!.files.length, 0);
  batchDeliverables(db, { ids, action: 'move', folderId: f.id });
  assert.equal(folderTree(db, item.item.id).children[0]!.files.length, 4);
  assert.equal(listFolders(db, item.item.id).length, 1);
  assert.ok(getItem(db, item.item.id));

  db.close();
});
