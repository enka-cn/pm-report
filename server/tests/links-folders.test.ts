import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, one, run } from '../src/db/index.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { createItem, getItem } from '../src/domain/items.ts';
import { addDeliverable, dropDeliverables, listDeliverables } from '../src/domain/deliverables.ts';
import {
  createFolder,
  deleteFolder,
  folderTree,
  listFolders,
  moveDeliverable,
  moveFolder,
  renameFolder,
  updateFolder,
} from '../src/domain/folders.ts';
import { addLink, assertHttpUrl, labelFromUrl, listLinks, removeLink, updateLink } from '../src/domain/links.ts';
import { listTimeline } from '../src/domain/events.ts';
import { rebuildSearchIndex, search } from '../src/domain/search.ts';
import { storeFile } from '../src/domain/storage.ts';
import { buildReportData } from '../src/domain/reports.ts';
import { freshDb, makeApp , makeItem } from './helpers.ts';

const TEMPLATES = loadPipelines();

function fileIn(text: string, filename: string, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'))) {
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
// 链接
// ---------------------------------------------------------------------------

test('链接：只收 http / https，其余一律挡住', () => {
  // 这条挡的是真事：javascript: 渲染成 <a href> 就是可执行代码
  assert.throws(() => assertHttpUrl('javascript:alert(1)'), /只支持 http \/ https/);
  assert.throws(() => assertHttpUrl('data:text/html,<script>x</script>'), /只支持 http \/ https/);
  assert.throws(() => assertHttpUrl('file:///C:/Windows'), /只支持 http \/ https/);
  assert.throws(() => assertHttpUrl('wiki.internal/pages/123'), /不是一个完整的网址/);
  assert.throws(() => assertHttpUrl('随便写的'), /不是一个完整的网址/);

  assert.doesNotThrow(() => assertHttpUrl('https://wiki.internal/pages/viewpage.action?pageId=1'));
  assert.doesNotThrow(() => assertHttpUrl('http://127.0.0.1:8080/x'));
});

test('链接：没写标题就从网址凑一个', () => {
  assert.equal(labelFromUrl('https://wiki.internal/pages/需求串讲'), '需求串讲');
  assert.equal(labelFromUrl('https://wiki.internal/'), 'wiki.internal');
  assert.equal(labelFromUrl('https://wiki.internal/a/b/c.html'), 'c.html');
});

test('链接：增删改，并留下事件', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const link = addLink(db, {
    itemId: item.item.id,
    url: 'https://wiki.internal/pages/viewpage.action?pageId=9527',
    label: '需求串讲记录',
  });
  assert.equal(link.label, '需求串讲记录');
  assert.equal(listLinks(db, item.item.id).length, 1);

  const updated = updateLink(db, link.id, { label: '需求串讲记录（已归档）' });
  assert.equal(updated.label, '需求串讲记录（已归档）');
  assert.equal(updated.url, link.url, '只改标题不该动网址');

  assert.throws(() => updateLink(db, link.id, { url: 'javascript:x' }), /只支持 http/);
  assert.throws(() => updateLink(db, link.id, { label: '   ' }), /标题不能为空/);

  removeLink(db, link.id);
  assert.equal(listLinks(db, item.item.id).length, 0);

  const types = listTimeline(db, item.item.id).map((e) => e.type);
  assert.ok(types.includes('link_added'));
  assert.ok(types.includes('link_removed'));

  db.close();
});

test('链接进了全文索引：搜 wiki 页名能找到这条需求', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  addLink(db, { itemId: item.item.id, label: '计费策略评审纪要', url: 'https://wiki.internal/x/9988' });

  const hit = search(db, '计费策略评审纪要').hits[0]!;
  assert.equal(hit.kind, 'link');
  assert.equal(hit.itemId, item.item.id);

  // 改标题后旧词要消失
  const link = listLinks(db, item.item.id)[0]!;
  updateLink(db, link.id, { label: '换了个标题' });
  assert.equal(search(db, '计费策略评审纪要').total, 0);
  assert.equal(search(db, '换了个标题').total, 1);

  removeLink(db, link.id);
  assert.equal(search(db, '换了个标题').total, 0, '删了链接索引也要清掉');

  db.close();
});

test('链接事件不会让汇报冒出空标题', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const at = new Date(Date.now() + 1000).toISOString();
  const end = new Date(Date.now() + 2000).toISOString();

  // 区间里只有「加链接」这一件事 —— link_added 在汇报里没有渲染分支
  addLink(db, { itemId: item.item.id, label: '某个 wiki 页', url: 'https://wiki.internal/a' });

  const data = buildReportData(db, { periodStart: at, periodEnd: end });
  assert.equal(
    data.items_with_events.length,
    0,
    '只有整理动作、没有进展时，不该渲染出一条有标题没内容的条目',
  );

  db.close();
});

// ---------------------------------------------------------------------------
// 文件夹
// ---------------------------------------------------------------------------

test('文件夹：建、改名、嵌套、同层重名要拦', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const assets = createFolder(db, { itemId: item.item.id, name: 'assets' });
  assert.equal(assets.parent_id, null);
  assert.equal(assets.name, 'assets');

  assert.throws(() => createFolder(db, { itemId: item.item.id, name: 'assets' }), /已经有叫「assets」的/);
  assert.throws(() => createFolder(db, { itemId: item.item.id, name: 'a/b' }), /不能有斜杠/);
  assert.throws(() => createFolder(db, { itemId: item.item.id, name: '  ' }), /不能为空/);
  assert.throws(() => createFolder(db, { itemId: item.item.id, name: '..' }), /不能用作文件夹名/);

  const nested = createFolder(db, { itemId: item.item.id, parentId: assets.id, name: 'assets' });
  assert.equal(nested.parent_id, assets.id, '不同层可以同名');

  const renamed = renameFolder(db, nested.id, 'old');
  assert.equal(renamed.name, 'old');

  // 根层再建一个 old，这时把 assets 改名成 old 就该被拦住
  createFolder(db, { itemId: item.item.id, name: 'old' });
  assert.throws(() => renameFolder(db, assets.id, 'old'), /已经有叫「old」的/);

  assert.equal(listFolders(db, item.item.id).length, 3);
  db.close();
});

test('文件夹：移动要挡环 —— 否则子树会从界面上消失', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const a = createFolder(db, { itemId: item.item.id, name: 'a' });
  const b = createFolder(db, { itemId: item.item.id, parentId: a.id, name: 'b' });
  const c = createFolder(db, { itemId: item.item.id, parentId: b.id, name: 'c' });

  assert.throws(() => moveFolder(db, a.id, a.id), /移进它自己/);
  assert.throws(() => moveFolder(db, a.id, b.id), /移进它自己的子文件夹/);
  assert.throws(() => moveFolder(db, a.id, c.id), /移进它自己的子文件夹/);

  // 合法的移动：c 提到根层
  const moved = moveFolder(db, c.id, null);
  assert.equal(moved.parent_id, null);

  // 改名和移动一起做
  const both = updateFolder(db, b.id, { name: 'b2', parentId: null });
  assert.equal(both.name, 'b2');
  assert.equal(both.parent_id, null);

  db.close();
});

test('文件夹：跨需求移动被挡住', () => {
  const db = freshDb();
  const a = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const b = makeItem(db, TEMPLATES, { title: '乙', role: 'dev' });

  const fa = createFolder(db, { itemId: a.item.id, name: 'fa' });
  const fb = createFolder(db, { itemId: b.item.id, name: 'fb' });

  assert.throws(() => moveFolder(db, fa.id, fb.id), /跨需求/);
  assert.throws(
    () => createFolder(db, { itemId: a.item.id, parentId: fb.id, name: 'x' }),
    /不属于这个需求/,
  );

  db.close();
});

test('文件夹：非空不让删，说清里面有几个', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const assets = createFolder(db, { itemId: item.item.id, name: 'assets' });

  // 空的时候可以删
  const spare = createFolder(db, { itemId: item.item.id, name: 'spare' });
  deleteFolder(db, spare.id);
  assert.equal(listFolders(db, item.item.id).length, 1);

  dropDeliverables(db, {
    itemId: item.item.id,
    folderId: assets.id,
    files: [fileIn('图', 'a.png'), fileIn('图', 'b.png')],
  });
  createFolder(db, { itemId: item.item.id, parentId: assets.id, name: '子' });

  assert.throws(() => deleteFolder(db, assets.id), /还有2 个交付物和1 个子文件夹/);

  // 清空之后就能删了
  run(db, 'UPDATE deliverable SET folder_id = NULL WHERE folder_id = ?', assets.id);
  createFolder(db, { itemId: item.item.id, name: '临时' });
  const child = listFolders(db, item.item.id).find((f) => f.parent_id === assets.id)!;
  updateFolder(db, child.id, { parentId: null });
  deleteFolder(db, assets.id);
  assert.equal(listFolders(db, item.item.id).some((f) => f.name === 'assets'), false);

  db.close();
});

test('文件树：和阶段正交，文件按 folder_id 归位', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const stageId = item.stages[0]!.id;

  const assets = createFolder(db, { itemId: item.item.id, name: 'assets' });
  const deep = createFolder(db, { itemId: item.item.id, parentId: assets.id, name: 'deep' });

  dropDeliverables(db, {
    itemId: item.item.id,
    stageId,
    folderId: assets.id,
    files: [fileIn('图', '截图.png')],
  });
  dropDeliverables(db, {
    itemId: item.item.id,
    stageId,
    folderId: deep.id,
    files: [fileIn('深', '深处的文件.md')],
  });
  dropDeliverables(db, {
    itemId: item.item.id,
    stageId,
    files: [fileIn('根', '根目录的文件.md')],
  });

  const tree = folderTree(db, item.item.id);
  assert.equal(tree.folder, null, '根节点是虚的');
  assert.deepEqual(tree.files.map((f) => f.name), ['根目录的文件']);

  const assetsNode = tree.children.find((n) => n.folder?.name === 'assets')!;
  assert.deepEqual(assetsNode.files.map((f) => f.name), ['截图']);
  const deepNode = assetsNode.children.find((n) => n.folder?.name === 'deep')!;
  assert.deepEqual(deepNode.files.map((f) => f.name), ['深处的文件']);

  // 归到文件夹不影响它在哪个阶段
  assert.equal(assetsNode.files[0]!.stage_id, stageId);
  assert.equal(assetsNode.files[0]!.folder_id, assets.id);

  // 移动一个交付物到别处，阶段仍然不变
  moveDeliverable(db, assetsNode.files[0]!.id, null);
  const after = folderTree(db, item.item.id);
  assert.deepEqual(
    after.files.map((f) => f.name).sort(),
    ['根目录的文件', '截图'].sort(),
  );
  assert.equal(after.files.find((f) => f.name === '截图')!.stage_id, stageId, '换文件夹不动阶段');

  db.close();
});

test('文件树通过 GET /api/items/:id 一起返回', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  createFolder(db, { itemId: item.item.id, name: 'assets' });
  addLink(db, { itemId: item.item.id, label: 'wiki', url: 'https://wiki.internal/x' });

  const detail = getItem(db, item.item.id)!;
  assert.equal(detail.links.length, 1);
  assert.equal(detail.tree.children.length, 1);
  assert.equal(detail.tree.children[0]!.folder!.name, 'assets');
  assert.deepEqual(detail.tree.files, [], '还没上传东西');

  db.close();
});

test('重建索引要把链接也算上', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  addLink(db, { itemId: item.item.id, label: '评审纪要', url: 'https://wiki.internal/x' });

  const snapshot = () =>
    all<{ rowid: number; kind: string }>(db, 'SELECT rowid, kind FROM search_fts ORDER BY rowid');

  const before = snapshot();
  assert.ok(before.some((r) => r.kind === 'link'));

  rebuildSearchIndex(db);
  assert.deepEqual(snapshot(), before, '增量维护和全量重建必须一致');

  db.close();
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('HTTP：链接的增删改查', async () => {
  const { db, app } = makeApp();
  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'dev' }),
  });
  const detail = (await created.json()) as { item: { id: number } };

  const post = await app.request(`/api/items/${detail.item.id}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://wiki.internal/pages/9527', label: '需求页' }),
  });
  assert.equal(post.status, 201);
  const link = (await post.json()) as { id: number; label: string };

  const bad = await app.request(`/api/items/${detail.item.id}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'javascript:alert(1)' }),
  });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /只支持 http/);

  const patched = await app.request(`/api/links/${link.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '改过的标题' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(((await patched.json()) as { label: string }).label, '改过的标题');

  const listed = await app.request(`/api/items/${detail.item.id}/links`);
  assert.equal(((await listed.json()) as { links: unknown[] }).links.length, 1);

  const removed = await app.request(`/api/links/${link.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(listLinks(db, detail.item.id).length, 0);

  db.close();
});

test('HTTP：文件夹管理与把交付物拖进文件夹', async () => {
  const { db, app } = makeApp();
  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'dev' }),
  });
  const detail = (await created.json()) as { item: { id: number }; stages: { id: number }[] };

  const made = await app.request(`/api/items/${detail.item.id}/folders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'assets' }),
  });
  assert.equal(made.status, 201);
  const folder = (await made.json()) as { id: number };

  // 拖文件时直接指定文件夹
  const form = new FormData();
  form.set('stageId', String(detail.stages[0]!.id));
  form.set('folderId', String(folder.id));
  form.append('file', new File([Buffer.from('图', 'utf8')], '截图.png'));
  const dropped = await app.request(`/api/items/${detail.item.id}/deliverables/drop`, {
    method: 'POST',
    body: form,
  });
  assert.equal(dropped.status, 201);

  const tree = (await (await app.request(`/api/items/${detail.item.id}/tree`)).json()) as {
    tree: {
      children: { folder: { name: string }; files: { id: number; name: string; folder_id: number }[] }[];
    };
  };
  assert.equal(tree.tree.children[0]!.folder.name, 'assets');
  assert.equal(tree.tree.children[0]!.files[0]!.name, '截图');
  assert.equal(tree.tree.children[0]!.files[0]!.folder_id, folder.id);

  // 通过 PATCH 交付物把它移回根目录
  const deliverableId = tree.tree.children[0]!.files[0]!.id;
  const moved = await app.request(`/api/deliverables/${deliverableId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folderId: null }),
  });
  assert.equal(moved.status, 200);
  assert.equal(
    listDeliverables(db, detail.item.id)[0]!.folder_id,
    null,
  );

  // 非空删不掉
  run(db, 'UPDATE deliverable SET folder_id = ? WHERE id = ?', folder.id, deliverableId);
  const refused = await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /还有1 个交付物/);

  db.close();
});

test('HTTP：改名 + 移动一起提交', async () => {
  const { db, app } = makeApp();
  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'dev' }),
  });
  const detail = (await created.json()) as { item: { id: number } };

  const mk = async (name: string, parentId?: number) =>
    ((await (
      await app.request(`/api/items/${detail.item.id}/folders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      })
    ).json()) as { id: number });

  const a = await mk('a');
  const b = await mk('b');

  const res = await app.request(`/api/folders/${b.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'b2', parentId: a.id }),
  });
  assert.equal(res.status, 200);
  const after = (await res.json()) as { name: string; parent_id: number };
  assert.equal(after.name, 'b2');
  assert.equal(after.parent_id, a.id);

  // 自己移进自己 -> 400
  const bad = await app.request(`/api/folders/${a.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentId: b.id }),
  });
  assert.equal(bad.status, 400);

  db.close();
});

test('迁移 005 的约束：同层重名在数据库层也被挡住', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  createFolder(db, { itemId: item.item.id, name: 'x' });

  // 绕过领域层直接插，唯一索引必须拦住
  assert.throws(
    () =>
      run(
        db,
        'INSERT INTO folder (item_id, parent_id, name, created_at) VALUES (?, NULL, ?, ?)',
        item.item.id,
        'x',
        '2026-01-01T00:00:00Z',
      ),
    /UNIQUE|constraint/i,
  );

  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM folder')!.n, 1);
  db.close();
});

test('需求删除时链接和文件夹跟着走（外键级联）', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  createFolder(db, { itemId: item.item.id, name: 'assets' });
  addLink(db, { itemId: item.item.id, label: 'wiki', url: 'https://wiki.internal/x' });

  // 需求本身在系统里删不掉（事件是 append-only，级联会撞触发器），
  // 这里只验证外键是挂上的：直接看 schema
  const fks = all<{ table: string; from: string; on_delete: string }>(
    db,
    'PRAGMA foreign_key_list(folder)',
  );
  assert.ok(fks.some((f) => f.table === 'item' && f.on_delete === 'CASCADE'));
  const linkFks = all<{ table: string; on_delete: string }>(db, 'PRAGMA foreign_key_list(item_link)');
  assert.ok(linkFks.some((f) => f.table === 'item' && f.on_delete === 'CASCADE'));

  db.close();
});
