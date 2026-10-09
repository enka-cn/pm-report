import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db/index.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { createItem, getItem, listItems, setItemCode } from '../src/domain/items.ts';
import { createProject, getProject, setProjectCode } from '../src/domain/projects.ts';
import { listTimeline } from '../src/domain/events.ts';
import { search } from '../src/domain/search.ts';
import { queryPalette } from '../src/domain/palette.ts';
import { normalizeCode } from '../src/domain/codes.ts';
import { freshDb, makeApp, makeItem } from './helpers.ts';

const TEMPLATES = loadPipelines();

// ---------------------------------------------------------------------------
// 「没有编号」是一种真实存在的东西
//
// 预研 / 算法项目往往没有外部需求单号 —— 它们是上游团队交付过来看护的。
// 硬编一个 REQ-6 等于凭空造一个你必须记住的映射，比没有标识更糟。
// ---------------------------------------------------------------------------

test('不传编号就是真的没有 —— 不再自动生成 REQ-N', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '模型量化预研', role: 'dev' });
  const b = createItem(db, TEMPLATES, { title: '另一个预研', role: 'dev' });

  assert.equal(a.item.code, null);
  assert.equal(b.item.code, null, '多条「没有编号」要能并存（SQLite 把 NULL 当作互不相同）');
  assert.equal(a.item.ref, '模型量化预研', '没编号时 ref 就是标题');
  assert.equal(b.item.ref, '另一个预研');

  // 编号仍然唯一 —— 一旦有，就不能撞
  createItem(db, TEMPLATES, { code: 'REQ-1', title: '有编号的', role: 'dev' });
  assert.throws(
    () => createItem(db, TEMPLATES, { code: 'REQ-1', title: '撞号的', role: 'dev' }),
    /编号「REQ-1」已经被「有编号的」占了/,
    '要告诉用户是谁占了，而不是抛一句 UNIQUE constraint failed',
  );

  db.close();
});

test('自己起的短名可以是中文，但不能带空格', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { code: '量化-平台A', title: '甲', role: 'dev' });
  assert.equal(a.item.code, '量化-平台A');
  assert.equal(a.item.ref, '量化-平台A  甲');

  // 空格会把 #引用 切断，所以必须拦在前面
  assert.throws(
    () => createItem(db, TEMPLATES, { code: '量化 平台A', title: '乙', role: 'dev' }),
    /不能包含空格/,
  );
  assert.throws(() => normalizeCode('#REQ-1'), /不能包含 # 或 @/);
  assert.throws(() => normalizeCode('x'.repeat(41)), /太长了/);

  db.close();
});

test('编号前后空格会被去掉，只给空白等于没给', () => {
  assert.equal(normalizeCode('  REQ-1  '), 'REQ-1');
  assert.equal(normalizeCode('   '), null);
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(undefined), null);

  const db = freshDb();
  const a = createItem(db, TEMPLATES, { code: '   ', title: '甲', role: 'dev' });
  assert.equal(a.item.code, null, '只给空白等于没给编号');
  db.close();
});

test('没编号的需求，用标题就能搜到、也能被 # 引用', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '模型量化预研', role: 'dev' });

  // 全文检索：索引里必须是标题，不能是空字符串
  assert.equal(search(db, '量化').total, 1);
  assert.equal(search(db, '模型量化预研').hits[0]?.refId, a.item.id);

  // 命令面板：# 同时匹配编号和标题，所以没编号也找得到
  const byTitle = queryPalette(db, '#量化');
  assert.equal(byTitle.error, undefined);
  assert.equal(byTitle.candidates.find((c) => c.kind === 'jump')?.itemId, a.item.id);

  db.close();
});

test('没编号时的 Tab 补全插标题，不是插一个 null', () => {
  const db = freshDb();
  createItem(db, TEMPLATES, { title: '模型量化预研', role: 'dev' });

  const r = queryPalette(db, '/todo 写文档 #量化');
  const jump = r.candidates.find((c) => c.kind === 'jump');
  assert.ok(jump, '应该给候选');
  assert.equal(jump.insert, '#模型量化预研', '插的是标题 —— 虽然长，但它是唯一的稳定标识');
  assert.ok(!String(jump.insert).includes('null'));
  assert.equal(jump.label, '模型量化预研');

  db.close();
});

// ---------------------------------------------------------------------------
// 事后补编号：预研转立项
// ---------------------------------------------------------------------------

test('预研转立项：补上真单号，时间线上留痕', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '模型量化预研', role: 'dev' });
  assert.equal(a.item.code, null);

  setItemCode(db, a.item.id, 'REQ-2026-0042');

  const after = getItem(db, a.item.id)!;
  assert.equal(after.item.code, 'REQ-2026-0042');
  assert.equal(after.item.ref, 'REQ-2026-0042  模型量化预研', 'ref 自动跟着变');

  const ev = listTimeline(db, a.item.id).find((e) => e.type === 'code_change')!;
  assert.ok(ev, '补编号是一件真实发生的事，要留在时间线上');
  assert.deepEqual(JSON.parse(ev.payload!), { from: null, to: 'REQ-2026-0042' });

  // 搜索索引也跟着更新（触发器用的是 ref）
  assert.equal(search(db, 'REQ-2026-0042').total, 1);

  db.close();
});

test('改编号留痕；改成一样的不写事件（免得时间线上全是噪音）', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { code: 'REQ-1', title: '甲', role: 'dev' });

  setItemCode(db, a.item.id, 'REQ-1');
  assert.equal(
    listTimeline(db, a.item.id).filter((e) => e.type === 'code_change').length,
    0,
    '没变化就不该写事件',
  );

  setItemCode(db, a.item.id, 'REQ-2');
  const ev = listTimeline(db, a.item.id).filter((e) => e.type === 'code_change');
  assert.equal(ev.length, 1);
  assert.deepEqual(JSON.parse(ev[0]!.payload!), { from: 'REQ-1', to: 'REQ-2' });

  db.close();
});

test('可以取消编号 —— 立项之后又撤了也是常事', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { code: 'REQ-1', title: '甲', role: 'dev' });
  setItemCode(db, a.item.id, null);

  assert.equal(getItem(db, a.item.id)!.item.code, null);
  assert.equal(getItem(db, a.item.id)!.item.ref, '甲');
  const ev = listTimeline(db, a.item.id).find((e) => e.type === 'code_change')!;
  assert.deepEqual(JSON.parse(ev.payload!), { from: 'REQ-1', to: null });

  db.close();
});

test('补编号时撞号要报人话', () => {
  const db = freshDb();
  createItem(db, TEMPLATES, { code: 'REQ-1', title: '占了号的', role: 'dev' });
  const b = createItem(db, TEMPLATES, { title: '想抢号的', role: 'dev' });

  assert.throws(() => setItemCode(db, b.item.id, 'REQ-1'), /已经被「占了号的」占了/);
  assert.equal(getItem(db, b.item.id)!.item.code, null, '失败了不该留下半截状态');

  db.close();
});

// ---------------------------------------------------------------------------
// 项目编号同样可选
// ---------------------------------------------------------------------------

test('项目编号也可以没有 —— 看护对象本来就没有单号', () => {
  const db = freshDb();
  const p = createProject(db, {
    name: '模型量化看护',
    kind: 'caretaking',
    watchFor: '算法侧报 bug 时',
  });

  assert.equal(p.code, null);
  assert.equal(p.ref, '模型量化看护');

  setProjectCode(db, p.id, 'PRJ-量化');
  assert.equal(getProject(db, p.id)!.ref, 'PRJ-量化  模型量化看护');

  assert.throws(
    () => createProject(db, { name: '重复的', code: 'PRJ-量化' }),
    /已经被「模型量化看护」占了/,
  );

  db.close();
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('HTTP：建需求可以不给编号；可以事后补', async () => {
  const { db, app } = makeApp();

  const post = async (body: Record<string, unknown>) =>
    app.request('/api/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const created = await post({ title: '模型量化预研', role: 'dev' });
  assert.equal(created.status, 201);
  const detail = (await created.json()) as { item: { id: number; code: string | null; ref: string } };
  assert.equal(detail.item.code, null);
  assert.equal(detail.item.ref, '模型量化预研');

  // 补编号
  const patched = await app.request(`/api/items/${detail.item.id}/code`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'REQ-2026-0042' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(
    ((await (await app.request(`/api/items/${detail.item.id}`)).json()) as {
      item: { code: string | null };
    }).item.code,
    'REQ-2026-0042',
  );

  // 带空格的编号要给人话
  const bad = await app.request(`/api/items/${detail.item.id}/code`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'a b' }),
  });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /不能包含空格/);

  db.close();
});

test('HTTP：项目编号也可以不给、可以补', async () => {
  const { db, app } = makeApp();
  const created = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '看护对象', kind: 'caretaking', watchFor: '有新需求时' }),
  });
  const project = (await created.json()) as { id: number; code: string | null; ref: string };
  assert.equal(project.code, null);
  assert.equal(project.ref, '看护对象');

  const patched = await app.request(`/api/projects/${project.id}/code`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'PRJ-1' }),
  });
  assert.equal(patched.status, 200);

  db.close();
});

test('列表按编号找得到，也按标题找得到', () => {
  const db = freshDb();
  createItem(db, TEMPLATES, { code: 'REQ-7', title: '接口鉴权改造', role: 'dev' });
  createItem(db, TEMPLATES, { title: '模型量化预研', role: 'dev' });

  const byCode = listItems(db, { q: 'REQ-7' });
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0]!.title, '接口鉴权改造');

  const byTitle = listItems(db, { q: '量化' });
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0]!.title, '模型量化预研');
  assert.equal(byTitle[0]!.code, null);

  db.close();
});

test('旧数据里已有编号的行不受影响', () => {
  const db = freshDb();
  const a = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  assert.ok(a.item.code, 'makeItem 给的是 T-n');

  // 迁移只是去掉了 NOT NULL，UNIQUE 还在，已有编号照常工作
  const rows = all<{ code: string | null }>(db, 'SELECT code FROM item').map((r) => r.code);
  assert.deepEqual(rows, [a.item.code]);
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM item WHERE code IS NOT NULL')!.n, 1);

  db.close();
});
