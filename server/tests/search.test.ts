import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one, run } from '../src/db/index.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { createItem, noteItem } from '../src/domain/items.ts';
import { addTodo, openBlocker, closeBlocker } from '../src/domain/stages.ts';
import { addDeliverable } from '../src/domain/deliverables.ts';
import { createProject, handoffProject } from '../src/domain/projects.ts';
import { rebuildSearchIndex, search } from '../src/domain/search.ts';
import { freshDb , makeItem } from './helpers.ts';

const TEMPLATES = loadPipelines();

/**
 * 交付物入库要一份文件元数据。数据库不校验文件真的存在，
 * 所以这里给一份形状正确的假元数据就够了 —— 这条测试关心的是索引，不是落盘。
 */
const FAKE_FILE = {
  sha256: 'a'.repeat(64),
  relPath: `aa/${'a'.repeat(64)}`,
  filename: '送测申请单.md',
  sizeBytes: 12,
  mime: 'text/markdown',
};

/** 抽出「类别#id」便于断言 */
const hitIds = (db: ReturnType<typeof freshDb>, q: string, kind?: string): string[] =>
  search(db, q, { kind: kind as never })
    .hits.map((h) => `${h.kind}#${h.refId}`)
    .sort();

const indexed = (db: ReturnType<typeof freshDb>): number =>
  one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM search_fts')!.n;

// ---------------------------------------------------------------------------
// 索引跟随源表（触发器）
// ---------------------------------------------------------------------------

test('需求：标题和说明都进索引', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, {
    title: '接口鉴权改造',
    role: 'dev',
    description: '把老的单点登录换成统一鉴权',
  });

  assert.deepEqual(hitIds(db, '鉴权'), [`item#${item.item.id}`]);
  assert.deepEqual(hitIds(db, '单点登录'), [`item#${item.item.id}`]);
  assert.deepEqual(hitIds(db, '接口'), [`item#${item.item.id}`], '两字词也要能搜到');
  assert.equal(search(db, '不存在的词').total, 0);

  db.close();
});

test('备注：只有带 note 的事件进索引', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  // 建需求本身会写好几条事件，但都没有 note，所以一条都不该进索引
  assert.equal(search(db, '甲').counts.note, 0, '没有 note 的事件不该进索引');

  noteItem(db, item.item.id, '送测材料已提交，等测试组排期');
  assert.equal(search(db, '排期').counts.note, 1);
  assert.deepEqual(hitIds(db, '测试组'), hitIds(db, '排期'));
  assert.match(search(db, '排期').hits[0]!.snippet, /\[排期\]/);

  db.close();
});

test('待办：手工的进索引，模板的不进', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  // 模板待办已经随第一个阶段实例化了，它们全是样板文字
  const templateTodos = all<{ text: string }>(db, 'SELECT text FROM todo WHERE source = ?', 'template');
  assert.ok(templateTodos.length > 0, '这个模板应该有内置待办，否则这条测试没意义');
  for (const t of templateTodos) {
    assert.equal(search(db, t.text).hits.filter((h) => h.kind === 'todo').length, 0, `模板待办「${t.text}」不该进索引`);
  }

  const manual = addTodo(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    text: '补写鉴权时序图',
  });
  assert.deepEqual(hitIds(db, '时序图'), [`todo#${manual.id}`]);

  db.close();
});

test('待办：改了文本旧词消失，删了整条消失', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const t = addTodo(db, { itemId: item.item.id, stageId: item.stages[0]!.id, text: '补写时序图' });

  run(db, 'UPDATE todo SET text = ? WHERE id = ?', '补写异常分支', t.id);
  assert.equal(search(db, '时序图').total, 0, '改了文本，旧词必须搜不到');
  assert.equal(search(db, '异常分支').total, 1);

  run(db, 'DELETE FROM todo WHERE id = ?', t.id);
  assert.equal(search(db, '异常分支').total, 0, '删了待办，索引里也不能留着');

  db.close();
});

test('模板待办被改成手工时也要进索引', () => {
  const db = freshDb();
  makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const first = all<{ id: number }>(db, 'SELECT id FROM todo WHERE source = ? LIMIT 1', 'template')[0]!;
  assert.equal(search(db, '理解需求并复述').total, 0);

  run(db, 'UPDATE todo SET source = ?, text = ? WHERE id = ?', 'manual', '自己补的一条特别说明', first.id);
  assert.equal(search(db, '特别说明').total, 1);

  db.close();
});

test('阻塞：对方、需要什么、怎么解的都要能搜到', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const blockerId = openBlocker(db, {
    itemId: item.item.id,
    direction: 'blocked_by_others',
    counterparty: '网关模块 张三',
    need: '接口定义冻结',
  });

  assert.deepEqual(hitIds(db, '张三'), [`blocker#${blockerId}`]);
  assert.deepEqual(hitIds(db, '接口定义冻结'), [`blocker#${blockerId}`]);

  closeBlocker(db, blockerId, '已冻结，走的是 v2 草案');
  assert.deepEqual(hitIds(db, 'v2 草案'), [`blocker#${blockerId}`], '解除说明也要能搜到');

  db.close();
});

test('交付物：名称进索引', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const d = addDeliverable(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    name: '送测申请单',
    category: 'doc',
    required: true,
    file: FAKE_FILE,
  });

  assert.deepEqual(hitIds(db, '送测申请单'), [`deliverable#${d.id}`]);

  db.close();
});

test('项目：说明和看护条件进索引；默认项目不进', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  assert.equal(item.project.is_default, 1);

  // 默认项目对用户是隐形的，不该在结果里冒出来
  assert.equal(
    search(db, '默认项目').hits.filter((h) => h.kind === 'project').length,
    0,
    '默认项目不该被索引',
  );

  const p = createProject(db, {
    name: '模型量化看护',
    kind: 'caretaking',
    watchFor: '上游提出新的平台适配需求时',
    description: '算法组交付，我们长期持有',
  });
  assert.deepEqual(hitIds(db, '算法组'), [`project#${p.id}`]);
  assert.deepEqual(hitIds(db, '平台适配'), [`project#${p.id}`]);

  db.close();
});

test('改需求标题后旧词消失（索引不能留下幽灵）', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '接口鉴权改造', role: 'dev' });

  run(db, 'UPDATE item SET title = ?, updated_at = ? WHERE id = ?', '接口限流改造', '2026-01-01T00:00:00Z', item.item.id);

  assert.equal(search(db, '鉴权').total, 0);
  assert.equal(search(db, '限流').total, 1);

  db.close();
});

test('作废的事件要从索引里抽掉', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  noteItem(db, item.item.id, '这条记录写错了，一会儿作废');

  assert.equal(search(db, '一会儿作废').total, 1);
  run(
    db,
    'UPDATE event SET voided_at = ?, void_reason = ? WHERE note LIKE ?',
    '2026-01-01T00:00:00Z',
    '记错了',
    '%一会儿作废%',
  );
  assert.equal(search(db, '一会儿作废').total, 0, '作废的记录不该还能搜出来');

  db.close();
});

// ---------------------------------------------------------------------------
// 查询行为
// ---------------------------------------------------------------------------

test('LIKE 通配符必须转义，否则搜出来的东西跟打的字没关系', () => {
  const db = freshDb();
  const a = makeItem(db, TEMPLATES, { title: '完成率统计', role: 'dev', description: '当前完成率 50% 左右' });
  makeItem(db, TEMPLATES, { title: '五十件事', role: 'dev', description: '跟百分号无关' });
  noteItem(db, a.item.id, 'a_b 这种下划线也要能搜');

  assert.equal(search(db, '50%').total, 1, '「50%」不能变成「以 50 开头的一切」');
  assert.equal(search(db, '%').total, 1, '光一个 % 不是通配符');
  assert.equal(search(db, 'a_b').total, 1, '_ 不是任意字符');
  assert.equal(search(db, '_').total, 1);
  assert.equal(search(db, "it's").total, 0, '撇号不该把 SQL 弄坏');

  db.close();
});

test('大小写不敏感', () => {
  const db = freshDb();
  makeItem(db, TEMPLATES, { title: 'ABC 需求', role: 'dev', description: 'MixedCase Needle' });

  assert.equal(search(db, 'needle').total, 1);
  assert.equal(search(db, 'NEEDLE').total, 1);
  assert.equal(search(db, 'abc').total, 1);

  db.close();
});

test('标题命中排在正文命中前面', () => {
  const db = freshDb();
  makeItem(db, TEMPLATES, { title: '别的东西', role: 'dev', description: '正文里提到了鉴权' });
  const byTitle = makeItem(db, TEMPLATES, { title: '鉴权平台化', role: 'dev' });

  const r = search(db, '鉴权');
  assert.equal(r.hits[0]!.refId, byTitle.item.id, '标题命中的排最前');
  assert.equal(r.hits[0]!.inTitle, true);
  assert.equal(r.hits[1]!.inTitle, false);

  db.close();
});

test('按类别过滤与计数', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '鉴权改造', role: 'dev', description: '鉴权相关说明' });
  noteItem(db, item.item.id, '鉴权这块还有点疑问');

  const all1 = search(db, '鉴权');
  assert.equal(all1.counts.item, 1);
  assert.equal(all1.counts.note, 1);
  assert.equal(all1.counts.todo, 0);
  assert.equal(all1.counts.project, 0);

  const onlyNotes = search(db, '鉴权', { kind: 'note' });
  assert.equal(onlyNotes.hits.length, 1);
  assert.equal(onlyNotes.hits[0]!.kind, 'note');
  assert.equal(onlyNotes.counts.item, 1, '计数是「这一类总共多少」，不受 kind 过滤影响');

  db.close();
});

test('结果带得回所属需求，用来跳转', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '接口鉴权改造', role: 'dev' });
  noteItem(db, item.item.id, '等测试组排期');

  const hit = search(db, '排期').hits[0]!;
  assert.equal(hit.kind, 'note');
  assert.equal(hit.itemId, item.item.id);
  assert.equal(hit.itemCode, item.item.code);
  assert.equal(hit.itemTitle, '接口鉴权改造');
  assert.equal(hit.projectName, '默认项目');

  db.close();
});

test('空查询和纯空白返回空结果，不去扫全表', () => {
  const db = freshDb();
  makeItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  for (const q of ['', '   ', '\t\n']) {
    const r = search(db, q);
    assert.equal(r.total, 0);
    assert.deepEqual(r.hits, []);
    assert.equal(r.counts.item, 0);
  }

  db.close();
});

test('limit 会被夹在合理区间', () => {
  const db = freshDb();
  for (let i = 0; i < 8; i++) makeItem(db, TEMPLATES, { title: `共同词 ${i}`, role: 'dev' });

  assert.equal(search(db, '共同词', { limit: 3 }).hits.length, 3);
  assert.equal(search(db, '共同词', { limit: 0 }).hits.length, 1, '下限是 1');
  assert.equal(search(db, '共同词', { limit: 9999 }).hits.length, 8, '上限 200 高过实际条数');

  db.close();
});

test('关闭的需求仍然搜得到 —— 历史不该消失', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, {
    title: '接口鉴权改造',
    role: 'dev',
    description: '那时候换成了统一鉴权',
  });
  noteItem(db, item.item.id, '上线那天灰度了三个小时');

  run(
    db,
    'UPDATE item SET closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?',
    '2026-01-01T00:00:00Z',
    'done',
    '2026-01-01T00:00:00Z',
    item.item.id,
  );

  assert.equal(search(db, '统一鉴权').total, 1);
  assert.equal(search(db, '灰度').total, 1);

  db.close();
});

test('交接备注也能搜到', () => {
  const db = freshDb();
  const p = createProject(db, {
    name: '看护对象',
    kind: 'caretaking',
    watchFor: '有新需求时',
  });
  handoffProject(db, { projectId: p.id, toOwner: 'SE组-张三', note: '回 SE 组了，脚本在共享盘' });

  const hit = search(db, '共享盘').hits[0]!;
  assert.equal(hit.kind, 'note');
  assert.equal(hit.projectId, p.id);
  assert.equal(hit.projectName, '看护对象');

  db.close();
});

// ---------------------------------------------------------------------------
// 重建索引：增量维护和全量重建必须一致
// ---------------------------------------------------------------------------

test('rebuildSearchIndex 与触发器增量维护的结果一致', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '接口鉴权改造', role: 'dev', description: '统一鉴权' });
  noteItem(db, item.item.id, '等测试组排期');
  addTodo(db, { itemId: item.item.id, stageId: item.stages[0]!.id, text: '补写时序图' });
  openBlocker(db, {
    itemId: item.item.id,
    direction: 'blocked_by_others',
    counterparty: '张三',
    need: '接口定义',
  });
  addDeliverable(db, {
    itemId: item.item.id,
    stageId: item.stages[0]!.id,
    name: '送测申请单',
    category: 'doc',
    file: FAKE_FILE,
  });
  createProject(db, { name: '看护对象', kind: 'caretaking', watchFor: '有新需求时' });

  const snapshot = () =>
    all<{ rowid: number; kind: string; title: string; body: string }>(
      db,
      'SELECT rowid, kind, title, body FROM search_fts ORDER BY rowid',
    );

  const before = snapshot();
  assert.ok(before.length > 0);

  const count = rebuildSearchIndex(db);
  assert.equal(count, before.length, '重建出来的行数要和增量维护的一致');
  assert.deepEqual(snapshot(), before, '逐行内容也要一致，不能只是条数对');

  db.close();
});

test('重建索引能修掉人为破坏的索引', () => {
  const db = freshDb();
  const item = makeItem(db, TEMPLATES, { title: '接口鉴权改造', role: 'dev' });
  noteItem(db, item.item.id, '等测试组排期');

  // 模拟「索引漂了」：偷偷塞一条不该存在的
  run(
    db,
    `INSERT INTO search_fts(rowid, kind, ref_id, item_id, project_id, occurred_at, title, body)
     VALUES (999999999, 'item', 999, NULL, NULL, '2026-01-01T00:00:00Z', '', '凭空出现的幽灵内容')`,
  );
  assert.equal(search(db, '幽灵内容').total, 1);

  rebuildSearchIndex(db);
  assert.equal(search(db, '幽灵内容').total, 0, '重建之后幽灵必须消失');
  assert.equal(search(db, '排期').total, 1, '真数据要还在');

  db.close();
});
