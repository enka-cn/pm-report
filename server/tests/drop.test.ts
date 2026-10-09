import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { one } from '../src/db/index.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { createItem } from '../src/domain/items.ts';
import {
  addDeliverable,
  deliverableNameFrom,
  dropDeliverables,
  guessCategory,
  listDeliverables,
  setDeliverableCategory,
  setDeliverableRequired,
} from '../src/domain/deliverables.ts';
import { stageAdvanceBlockers } from '../src/domain/stages.ts';
import { storeFile } from '../src/domain/storage.ts';
import { freshDb, makeApp , makeItem } from './helpers.ts';

const TEMPLATES = loadPipelines();

function freshFilesDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manager-drop-'));
}

/** 走一遍完整的落盘流程，返回 dropDeliverables 需要的元数据 */
function dropped(text: string, filename: string, dir = freshFilesDir()) {
  const stored = storeFile(Buffer.from(text, 'utf8'), dir);
  return {
    sha256: stored.sha256,
    relPath: stored.relPath,
    filename,
    sizeBytes: stored.sizeBytes,
    mime: 'text/plain',
  };
}

// ---------------------------------------------------------------------------
// 命名与分类
// ---------------------------------------------------------------------------

test('文件名 → 交付物名：剥掉扩展名，但不碰前导点', () => {
  assert.equal(deliverableNameFrom('送测申请单.docx'), '送测申请单');
  assert.equal(deliverableNameFrom('架构图.png'), '架构图');
  assert.equal(deliverableNameFrom('没有扩展名'), '没有扩展名');
  assert.equal(deliverableNameFrom('a.b.c.md'), 'a.b.c', '只剥最后一个点');
  assert.equal(deliverableNameFrom('.gitignore'), '.gitignore', '前导点不是扩展名');
  assert.equal(deliverableNameFrom('C:\\some\\dir\\文件.pdf'), '文件', '带上路径也要能处理');
  assert.equal(deliverableNameFrom('  空格  .txt'), '空格');
  assert.equal(deliverableNameFrom('.md'), '.md', '只剩扩展名时别剥成空');
});

test('按扩展名猜类别，认不出来就归「其他」', () => {
  assert.equal(guessCategory('架构图.png'), 'screenshot');
  assert.equal(guessCategory('流程.DRAWIO'), 'design', '大小写不敏感');
  assert.equal(guessCategory('run.log'), 'log');
  assert.equal(guessCategory('设计说明.md'), 'doc');
  assert.equal(guessCategory('评审记录.docx'), 'doc', '不按名字里的关键词猜，只按扩展名');
  assert.equal(guessCategory('data.bin'), 'other');
  assert.equal(guessCategory('没有扩展名'), 'other');
  assert.equal(guessCategory('.gitignore'), 'other');
});

// ---------------------------------------------------------------------------
// 拖进来就加入
// ---------------------------------------------------------------------------

test('拖进来：名字从文件名来，类别按扩展名猜', () => {
  const db = freshDb();
  const dir = freshFilesDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const stageId = item.stages[0]!.id;

  const results = dropDeliverables(db, {
    itemId: item.item.id,
    stageId,
    files: [dropped('# 设计说明', '设计说明.md', dir)],
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.action, 'created');
  assert.equal(results[0]!.deliverableName, '设计说明');

  const list = listDeliverables(db, item.item.id);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, '设计说明');
  assert.equal(list[0]!.category, 'doc');
  assert.equal(list[0]!.stage_id, stageId);
  assert.equal(list[0]!.required, 0, '拖进来的默认不是必交项');
  assert.equal(list[0]!.versions.length, 1);
  assert.equal(list[0]!.versions[0]!.original_filename, '设计说明.md', '原始文件名要留着，下载时还原');

  db.close();
});

test('同名再拖一次 = 新版本，不是又建一条', () => {
  const db = freshDb();
  const dir = freshFilesDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  dropDeliverables(db, { itemId: item.item.id, stageId: item.stages[0]!.id, files: [dropped('v1', '设计说明.md', dir)] });
  const second = dropDeliverables(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    files: [dropped('v2 改了内容', '设计说明.md', dir)],
  });

  assert.equal(second[0]!.action, 'versioned');
  const list = listDeliverables(db, item.item.id);
  assert.equal(list.length, 1, '还是一条交付物');
  assert.equal(list[0]!.versions.length, 2);
  assert.equal(list[0]!.current_version_id, list[0]!.versions[0]!.id, '当前版本指向最新的');

  db.close();
});

test('内容一模一样就别造一个没有意义的 v2', () => {
  const db = freshDb();
  const dir = freshFilesDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const stageId = item.stages[0]!.id;

  dropDeliverables(db, { itemId: item.item.id, stageId, files: [dropped('同样的内容', '文档.md', dir)] });
  const again = dropDeliverables(db, {
    itemId: item.item.id,
    stageId,
    files: [dropped('同样的内容', '文档.md', dir)],
  });

  assert.equal(again[0]!.action, 'unchanged');
  const list = listDeliverables(db, item.item.id);
  assert.equal(list[0]!.versions.length, 1, '版本数没变');

  db.close();
});

test('同名匹配忽略大小写和首尾空格', () => {
  const db = freshDb();
  const dir = freshFilesDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const stageId = item.stages[0]!.id;

  dropDeliverables(db, { itemId: item.item.id, stageId, files: [dropped('a', 'Design.md', dir)] });
  const r = dropDeliverables(db, {
    itemId: item.item.id,
    stageId,
    files: [dropped('b', '  design.MD', dir)],
  });

  assert.equal(r[0]!.action, 'versioned');
  assert.equal(listDeliverables(db, item.item.id).length, 1);

  db.close();
});

test('拖到「必交项」上，卡点就解了 —— 这才是拖拽最省事的地方', () => {
  const db = freshDb();
  const dir = freshFilesDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const stageId = item.stages[0]!.id;

  // 先手工建一条必交项（现在还没有上传任何东西）
  addDeliverable(db, {
    itemId: item.item.id,
    stageId,
    name: 'SEG 评审记录',
    category: 'review_record',
    required: true,
    file: dropped('占位', 'placeholder.txt', dir),
  });
  // 清掉版本，让它回到「未上传」状态
  const d = listDeliverables(db, item.item.id)[0]!;
  db.exec(`UPDATE deliverable SET current_version_id = NULL WHERE id = ${d.id}`);
  db.exec(`DELETE FROM deliverable_version WHERE deliverable_id = ${d.id}`);

  assert.match(stageAdvanceBlockers(db, stageId).join(' '), /SEG 评审记录/);

  const r = dropDeliverables(db, {
    itemId: item.item.id,
    stageId,
    files: [dropped('评审结论：通过', 'SEG 评审记录.docx', dir)],
  });

  assert.equal(r[0]!.action, 'versioned', '归到那条必交项上，而不是新建一条');
  assert.equal(listDeliverables(db, item.item.id).length, 1);
  assert.ok(
    !stageAdvanceBlockers(db, stageId).join(' ').includes('SEG 评审记录'),
    '卡点应该解除了',
  );

  db.close();
});

test('一个文件失败不拖累整批', () => {
  const db = freshDb();
  const dir = freshFilesDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const results = dropDeliverables(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    files: [
      dropped('好的', '甲.md', dir),
      { sha256: 'not-a-sha', relPath: '', filename: '坏的.md', sizeBytes: 1 },
      dropped('也好', '乙.md', dir),
    ],
  });

  assert.equal(results.length, 3);
  assert.equal(results[0]!.action, 'created');
  assert.equal(results[1]!.action, 'failed');
  assert.ok(results[1]!.error, '失败原因要带上');
  assert.equal(results[2]!.action, 'created');
  assert.equal(listDeliverables(db, item.item.id).length, 2, '好的那两个进去了');

  db.close();
});

test('需求不存在时直接报错，而不是悄悄什么都不做', () => {
  const db = freshDb();
  assert.throws(
    () => dropDeliverables(db, { itemId: 99999, files: [dropped('x', 'x.md')] }),
    /需求不存在/,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// 改类别：猜错了得能改回来
// ---------------------------------------------------------------------------

test('改类别不动必交项；改必交不动类别', () => {
  const db = freshDb();
  const dir = freshFilesDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const created = addDeliverable(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    name: '东西',
    category: 'other',
    file: dropped('x', 'x.bin', dir),
  });

  setDeliverableCategory(db, created.id, 'design');
  setDeliverableRequired(db, created.id, true);

  let row = one<{ category: string; required: number }>(db, 'SELECT * FROM deliverable WHERE id = ?', created.id)!;
  assert.equal(row.category, 'design');
  assert.equal(row.required, 1);

  setDeliverableCategory(db, created.id, 'log');
  row = one<{ category: string; required: number }>(db, 'SELECT * FROM deliverable WHERE id = ?', created.id)!;
  assert.equal(row.required, 1, '改类别不该把必交项顺手取消');

  setDeliverableRequired(db, created.id, false);
  row = one<{ category: string; required: number }>(db, 'SELECT * FROM deliverable WHERE id = ?', created.id)!;
  assert.equal(row.category, 'log', '改必交不该顺手改类别');

  db.close();
});

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------

test('HTTP：一次拖多个文件进来', async () => {
  const { db, app } = makeApp();
  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'dev' }),
  });
  const detail = (await created.json()) as { item: { id: number }; stages: { id: number }[] };

  const form = new FormData();
  form.set('stageId', String(detail.stages[0]!.id));
  form.append('file', new File([Buffer.from('图', 'utf8')], '架构图.png'));
  form.append('file', new File([Buffer.from('日志内容', 'utf8')], 'run.log'));
  form.append('file', new File([Buffer.from('说明', 'utf8')], '设计说明.md'));

  const res = await app.request(`/api/items/${detail.item.id}/deliverables/drop`, {
    method: 'POST',
    body: form,
  });
  assert.equal(res.status, 201);

  const { results } = (await res.json()) as {
    results: { deliverableName: string; action: string }[];
  };
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => `${r.deliverableName}:${r.action}`),
    ['架构图:created', 'run:created', '设计说明:created'],
  );

  const listed = await app.request(`/api/items/${detail.item.id}/deliverables`);
  const { deliverables } = (await listed.json()) as {
    deliverables: { name: string; category: string }[];
  };
  assert.deepEqual(
    deliverables.map((d) => `${d.name}:${d.category}`),
    ['架构图:screenshot', 'run:log', '设计说明:doc'],
  );

  db.close();
});

test('HTTP：没有文件时报错，字段名说清楚', async () => {
  const { db, app } = makeApp();
  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'dev' }),
  });
  const detail = (await created.json()) as { item: { id: number } };

  const res = await app.request(`/api/items/${detail.item.id}/deliverables/drop`, {
    method: 'POST',
    body: new FormData(),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /字段名应为 file/);

  db.close();
});

test('HTTP：PATCH 只传类别时不碰必交项（原来的潜伏 bug）', async () => {
  const { db, app } = makeApp();
  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'dev' }),
  });
  const detail = (await created.json()) as { item: { id: number }; stages: { id: number }[] };

  const form = new FormData();
  form.set('itemId', String(detail.item.id));
  form.set('stageId', String(detail.stages[0]!.id));
  form.set('name', '评审记录');
  form.set('category', 'review_record');
  form.set('required', 'true');
  form.set('file', new File([Buffer.from('x', 'utf8')], '评审记录.md'));
  const uploaded = await app.request('/api/deliverables', { method: 'POST', body: form });
  const deliverable = (await uploaded.json()) as { id: number };

  // 只改类别
  const patch = await app.request(`/api/deliverables/${deliverable.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'design' }),
  });
  assert.equal(patch.status, 200);

  const row = one<{ category: string; required: number }>(
    db,
    'SELECT * FROM deliverable WHERE id = ?',
    deliverable.id,
  )!;
  assert.equal(row.category, 'design');
  assert.equal(row.required, 1, '只改类别不该把必交项取消掉');

  // 非法类别要拦住
  const bad = await app.request(`/api/deliverables/${deliverable.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: '不存在的类别' }),
  });
  assert.equal(bad.status, 400);

  db.close();
});
