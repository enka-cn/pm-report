import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, one } from '../src/db/index.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { createItem, getItem } from '../src/domain/items.ts';
import {
  addDeliverable,
  dropDeliverables,
  getDeliverable,
  listDeliverables,
  listRemovedDeliverables,
  purgeFiles,
  removeDeliverable,
  restoreDeliverable,
  storageUsage,
} from '../src/domain/deliverables.ts';
import { createFolder, folderContents, folderTree } from '../src/domain/folders.ts';
import { stageAdvanceBlockers } from '../src/domain/stages.ts';
import { rebuildSearchIndex, search } from '../src/domain/search.ts';
import { humanSize, listStoredFiles, storeFile } from '../src/domain/storage.ts';
import { listTimeline } from '../src/domain/events.ts';
import { freshDb, makeApp , makeItem } from './helpers.ts';

const TEMPLATES = loadPipelines();

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manager-purge-'));
}

function fileFrom(text: string, filename: string, dir: string) {
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
// 移除：从每一个界面消失
// ---------------------------------------------------------------------------

test('移除之后，从每一个界面都消失', () => {
  const db = freshDb();
  const dir = tempDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const stageId = item.stages[0]!.id;
  const folder = createFolder(db, { itemId: item.item.id, name: 'assets' });

  const d = addDeliverable(db, {
    itemId: item.item.id,
    stageId,
    folderId: folder.id,
    name: '架构设计说明',
    category: 'doc',
    required: true,
    file: fileFrom('# 说明', '架构设计说明.md', dir),
  });

  // 前提：移除前它到处都在
  assert.equal(listDeliverables(db, item.item.id).length, 1);
  assert.equal(folderTree(db, item.item.id).children[0]!.files.length, 1);
  assert.equal(folderContents(db, folder.id).files, 1);
  assert.equal(search(db, '架构设计说明').total, 1);

  removeDeliverable(db, d.id, '传错了');

  assert.equal(listDeliverables(db, item.item.id).length, 0, '列表里没有了');
  assert.equal(getItem(db, item.item.id)!.deliverables.length, 0, '需求详情里没有了');
  assert.equal(folderTree(db, item.item.id).children[0]!.files.length, 0, '文件树里没有了');
  assert.equal(folderContents(db, folder.id).files, 0, '文件夹计数不算它');
  assert.equal(search(db, '架构设计说明').total, 0, '全文索引里没有了');
  assert.equal(
    listRemovedDeliverables(db, item.item.id).length,
    1,
    '但「已移除」列表里有 —— 否则就不可逆了',
  );

  const types = listTimeline(db, item.item.id).map((e) => e.type);
  assert.ok(types.includes('deliverable_removed'));

  assert.throws(() => removeDeliverable(db, d.id), /已经移除过了/);
  db.close();
});

test('移除必交项之后，阶段卡点不该再拦着', () => {
  const db = freshDb();
  const dir = tempDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const stageId = item.stages[0]!.id;

  // 手工建一条「必交但没上传」的
  const d = addDeliverable(db, {
    itemId: item.item.id,
    stageId,
    name: 'SEG 评审记录',
    category: 'review_record',
    required: true,
    file: fileFrom('占位', 'p.txt', dir),
  });
  db.exec(`UPDATE deliverable SET current_version_id = NULL WHERE id = ${d.id}`);
  db.exec(`DELETE FROM deliverable_version WHERE deliverable_id = ${d.id}`);
  assert.match(stageAdvanceBlockers(db, stageId).join(' '), /SEG 评审记录/);

  removeDeliverable(db, d.id, '这条其实不用交');
  assert.ok(
    !stageAdvanceBlockers(db, stageId).join(' ').includes('SEG 评审记录'),
    '移除的必交项不能继续卡着阶段',
  );

  db.close();
});

test('移除是可逆的', () => {
  const db = freshDb();
  const dir = tempDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const d = addDeliverable(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    name: '手滑传错了',
    category: 'other',
    file: fileFrom('x', 'x.bin', dir),
  });

  removeDeliverable(db, d.id);
  restoreDeliverable(db, d.id);

  const back = listDeliverables(db, item.item.id);
  assert.equal(back.length, 1);
  assert.equal(back[0]!.name, '手滑传错了');
  assert.equal(back[0]!.versions.length, 1, '版本也还在');
  assert.equal(search(db, '手滑传错了').total, 1, '索引也恢复了');

  assert.throws(() => restoreDeliverable(db, d.id), /本来就没有移除/);
  db.close();
});

// ---------------------------------------------------------------------------
// 回收磁盘：这才是 200G 的出路
// ---------------------------------------------------------------------------

test('回收：删掉已移除交付物的字节，并报告释放了多少', () => {
  const db = freshDb();
  const dir = tempDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  // 模拟一个「大文件」：这里用 200KB 的文本，重点是逻辑不是字节数
  const big = 'x'.repeat(200 * 1024);
  const d = addDeliverable(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    name: '误传的模型包',
    category: 'other',
    file: fileFrom(big, 'model.bin', dir),
  });
  const before = listStoredFiles(dir);
  assert.equal(before.length, 1);

  // 只移除时字节还在 —— 这一步是可逆的底气
  removeDeliverable(db, d.id, '传错了');
  assert.equal(listStoredFiles(dir).length, 1, '移除本身不动磁盘');

  const usage = storageUsage(db, dir);
  assert.equal(usage.totalBytes, 200 * 1024);
  assert.equal(usage.recoverableBytes, 200 * 1024, '要能提前告诉用户「有这么多可以回收」');
  assert.equal(usage.recoverableFiles, 1);
  assert.equal(usage.removedDeliverables, 1);

  const result = purgeFiles(db, dir);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.deletedVersions, 1);
  assert.equal(result.freedBytes, 200 * 1024);
  assert.equal(listStoredFiles(dir).length, 0, '磁盘上真的没了');
  assert.equal(storageUsage(db, dir).recoverableBytes, 0, '收完就没什么可收的了');

  // 记录没了，但事件日志还在 —— 历史没有被牺牲
  assert.equal(getDeliverable(db, d.id)!.versions.length, 0);
  assert.ok(listTimeline(db, item.item.id).some((e) => e.type === 'deliverable_removed'));

  db.close();
});

test('回收：同一份内容还被别人引用时，字节要留着', () => {
  const db = freshDb();
  const dir = tempDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const stageId = item.stages[0]!.id;

  // 内容寻址：两份「不同名字、同样内容」的文件共用一个 blob
  const shared = fileFrom('同一份内容', 'a.md', dir);
  const a = addDeliverable(db, { itemId: item.item.id, stageId, name: '甲文档', file: shared });
  addDeliverable(db, {
    itemId: item.item.id,
    stageId,
    name: '乙文档',
    file: { ...fileFrom('同一份内容', 'b.md', dir) },
  });

  assert.equal(listStoredFiles(dir).length, 1, '内容一样就只存一份');

  removeDeliverable(db, a.id);
  const result = purgeFiles(db, dir);

  assert.equal(result.deletedFiles, 0, '还有在册的引用，不能删');
  assert.equal(result.keptShared, 1);
  assert.equal(listStoredFiles(dir).length, 1);
  assert.equal(search(db, '完全不同的名字').total, 0);

  db.close();
});

test('回收：不碰在册交付物的文件，也不碰没被引用的孤儿文件之外的正常文件', () => {
  const db = freshDb();
  const dir = tempDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  dropDeliverables(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    files: [fileFrom('在册的', 'keep.md', dir)],
  });
  const doomed = dropDeliverables(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    files: [fileFrom('要删的', 'drop.md', dir)],
  });
  removeDeliverable(db, doomed[0]!.deliverable!.id);

  assert.equal(listStoredFiles(dir).length, 2);
  const result = purgeFiles(db, dir);

  assert.equal(result.deletedFiles, 1);
  assert.equal(listStoredFiles(dir).length, 1);
  const kept = listStoredFiles(dir)[0]!;
  assert.notEqual(kept.sha256, doomed[0]!.deliverable!.versions[0]!.sha256);
  assert.equal(listDeliverables(db, item.item.id).length, 1);

  db.close();
});

test('回收：孤儿文件（上传中途失败留下的）也会被清掉', () => {
  const db = freshDb();
  const dir = tempDir();
  // 直接落一个盘，但没有任何数据库记录指向它
  const orphan = storeFile(Buffer.from('没人引用的孤儿', 'utf8'), dir);
  assert.equal(listStoredFiles(dir).length, 1);

  const result = purgeFiles(db, dir);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.freedBytes > 0, true);
  assert.equal(listStoredFiles(dir).length, 0);
  assert.ok(orphan.sha256);

  db.close();
});

test('重建索引也要把移除的排除掉', () => {
  const db = freshDb();
  const dir = tempDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const d = addDeliverable(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    name: '要被移除的交付物',
    file: fileFrom('x', 'x.md', dir),
  });
  removeDeliverable(db, d.id);

  rebuildSearchIndex(db);
  assert.equal(search(db, '要被移除的交付物').total, 0, '全量重建也必须排除移除的');
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM search_fts')!.n, 1, '只剩需求自己');

  db.close();
});

test('humanSize 要能显示 GB —— 误传的模型包是真实存在的', () => {
  assert.equal(humanSize(512), '512 B');
  assert.equal(humanSize(2048), '2.0 KB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(humanSize(3 * 1024 ** 3), '3.0 GB');
  assert.equal(humanSize(2 * 1024 ** 4), '2.0 TB');
  assert.equal(humanSize(200 * 1024 ** 3), '200.0 GB', '不该显示成 204800.0 MB');
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('HTTP：移除 / 恢复 / 存储用量 / 回收', async () => {
  const { db, filesDir, app } = makeApp();
  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'dev' }),
  });
  const detail = (await created.json()) as { item: { id: number }; stages: { id: number }[] };

  const form = new FormData();
  form.set('itemId', String(detail.item.id));
  form.set('stageId', String(detail.stages[0]!.id));
  form.set('name', '误传的东西');
  form.set('file', new File([Buffer.from('x'.repeat(4096), 'utf8')], 'wrong.bin'));
  const uploaded = await app.request('/api/deliverables', { method: 'POST', body: form });
  const deliverable = (await uploaded.json()) as { id: number };

  const before = (await (await app.request('/api/storage')).json()) as {
    totalBytes: number;
  };
  assert.equal(before.totalBytes, 4096);

  const removed = await app.request(`/api/deliverables/${deliverable.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: '传错了' }),
  });
  assert.equal(removed.status, 200);

  const mid = (await (await app.request('/api/storage')).json()) as {
    totalBytes: number;
    recoverableBytes: number;
    removedDeliverables: number;
  };
  assert.equal(mid.totalBytes, 4096, '移除不动磁盘');
  assert.equal(mid.recoverableBytes, 4096);
  assert.equal(mid.removedDeliverables, 1);

  const purged = await app.request('/api/storage/purge', { method: 'POST' });
  const outcome = (await purged.json()) as { freedBytes: number; deletedFiles: number };
  assert.equal(outcome.deletedFiles, 1);
  assert.equal(outcome.freedBytes, 4096);

  const after = (await (await app.request('/api/storage')).json()) as { totalBytes: number };
  assert.equal(after.totalBytes, 0);

  // 恢复一个已经回收过的：记录回来了，字节没了（下载会 404），但记录本身是诚实的
  const restored = await app.request(`/api/deliverables/${deliverable.id}/restore`, {
    method: 'POST',
  });
  assert.equal(restored.status, 200);
  assert.equal(listDeliverables(db, detail.item.id).length, 1);
  assert.equal(listStoredFiles(filesDir).length, 0);

  db.close();
});

test('HTTP：超大上传在解析之前就被挡住', async () => {
  const { db, app } = makeApp();

  // 关键：这个请求体其实很小，但声明的 Content-Length 很大 ——
  // 挡的就是这个：等 multipart 解析完再检查，内存已经吃进去了
  const form = new FormData();
  form.set('itemId', '1');
  form.set('name', 'x');
  form.set('file', new File([Buffer.from('tiny', 'utf8')], 'tiny.bin'));

  const res = await app.request('/api/deliverables', {
    method: 'POST',
    headers: { 'content-length': String(600 * 1024 * 1024) },
    body: form,
  });

  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /超过了 512 MB 的上限/);
  assert.match(body.error, /链接/, '要告诉用户大文件该怎么办');

  db.close();
});

test('HTTP：正常大小的上传不受影响', async () => {
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
  form.set('name', '正常的文档');
  form.set('file', new File([Buffer.from('hello', 'utf8')], 'doc.md'));

  const res = await app.request('/api/deliverables', { method: 'POST', body: form });
  assert.equal(res.status, 201);

  const meta = (await (await app.request('/api/meta')).json()) as {
    limits: { maxUploadMb: number };
  };
  assert.equal(meta.limits.maxUploadMb, 512, '前端要靠这个提前拦一下');

  db.close();
});

test('HTTP：删除不存在的交付物报人话', async () => {
  const { db, app } = makeApp();
  const res = await app.request('/api/deliverables/99999', { method: 'DELETE' });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /交付物不存在/);
  db.close();
});

test('移除的交付物不会在文件夹树里留下空壳计数', () => {
  const db = freshDb();
  const dir = tempDir();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const folder = createFolder(db, { itemId: item.item.id, name: 'assets' });

  const d = addDeliverable(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    folderId: folder.id,
    name: '图',
    category: 'screenshot',
    file: fileFrom('png', 'x.png', dir),
  });
  assert.equal(folderContents(db, folder.id).files, 1);

  removeDeliverable(db, d.id);
  assert.equal(folderContents(db, folder.id).files, 0);
  assert.equal(all(db, 'SELECT id FROM deliverable').length, 1, '行还在，只是不算数了');

  db.close();
});
