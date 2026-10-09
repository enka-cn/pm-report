import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, openDb } from '../src/db/index.ts';
import { MIGRATIONS_DIR, migrate } from '../src/db/migrate.ts';
import { rebuildSearchIndex } from '../src/domain/search.ts';

/**
 * 迁移测试：**模拟一个「升级前」的库**，然后升级它。
 *
 * 这测的是一类很隐蔽的 bug：改了派生数据的计算方式（触发器），却忘了把存量重算一遍。
 * 光看代码看不出来 —— 新建的库从头跑完所有迁移，永远是自洽的；
 * 只有「老库 + 新迁移」才会暴露。
 */
function snapshot(db: ReturnType<typeof openDb>) {
  return all<{ kind: string; ref_id: number; title: string | null }>(
    db,
    'SELECT kind, ref_id, title FROM search_fts ORDER BY kind, ref_id',
  );
}

/** 只拷到 `until` 为止的迁移，用来伪造一个旧版本的库 */
function migrationsUpTo(untilExclusive: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-oldmig-'));
  for (const name of fs.readdirSync(MIGRATIONS_DIR).sort()) {
    if (name >= untilExclusive) continue;
    fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
  }
  return dir;
}

test('迁移：升级前就存在的需求，索引会被刷新（重建 == 增量）', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-upgrade-'));
  const db = openDb(path.join(work, 'm.db'));

  // ① 造一个「007 之前」的库
  migrate(db, migrationsUpTo('007_optional_codes.sql'));
  const oldItems = all<{ name: string }>(db, 'SELECT name FROM schema_migrations ORDER BY name');
  assert.ok(!oldItems.some((m) => m.name.startsWith('007')), '007 还没应用');

  // ② 迁移只建表，默认项目是建需求时懒创建的 —— 先手工放一个，不然外键会拦
  db.prepare(
    `INSERT INTO project (code, name, is_default, created_at, updated_at)
     VALUES ('DEFAULT', '默认项目', 1, 't', 't')`,
  ).run();

  // ③ 用当时的触发器写几条数据（那时 code 是 NOT NULL，所以都有编号）
  const seeds: [string, string][] = [
    ['REQ-1', '接口鉴权改造'],
    ['REQ-2', '计费模块重构'],
  ];
  for (const [code, title] of seeds) {
    db.prepare(
      `INSERT INTO item (code, project_id, title, role, criticality, created_at, updated_at)
       VALUES (?, 1, ?, 'dev', 3, 't', 't')`,
    ).run(code, title);
  }

  const beforeUpgrade = snapshot(db);
  assert.ok(
    beforeUpgrade.every((r) => r.title !== null && r.title.includes(' ')),
    '升级前索引里是「编号 标题」',
  );
  assert.ok(
    beforeUpgrade.some((r) => r.title === 'REQ-1 接口鉴权改造'),
    '而且是老的单空格形态',
  );

  // ④ 升级
  migrate(db);

  // ⑤ 核心断言：升级之后，全量重建不该改变任何东西
  const afterUpgrade = snapshot(db);
  rebuildSearchIndex(db);
  assert.deepEqual(
    snapshot(db),
    afterUpgrade,
    '重建索引必须是幂等的 —— 如果这里不一致，说明有新迁移只改了触发器、没重算存量',
  );

  // ⑥ 而且内容真的换成新的 ref 形态了（双空格），不是留着老的
  assert.ok(
    afterUpgrade.some((r) => r.title === 'REQ-1  接口鉴权改造'),
    '存量索引要刷新成 ref 的形态',
  );
  assert.ok(
    !afterUpgrade.some((r) => r.title === 'REQ-1 接口鉴权改造'),
    '老形态必须被清掉',
  );

  // ⑦ 编号变成可选之后，老数据一条没丢
  assert.equal(all(db, 'SELECT id FROM item').length, 2);

  db.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test('迁移：从零跑完所有迁移，索引重建也是幂等的', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-fresh-'));
  const db = openDb(path.join(work, 'm.db'));
  migrate(db);

  db.prepare(
    `INSERT INTO project (code, name, is_default, created_at, updated_at)
     VALUES ('DEFAULT', '默认项目', 1, 't', 't')`,
  ).run();

  db.prepare(
    `INSERT INTO item (code, project_id, title, role, criticality, created_at, updated_at)
     VALUES (?, 1, ?, 'dev', 3, 't', 't')`,
  ).run('REQ-1', '甲');
  db.prepare(
    `INSERT INTO item (code, project_id, title, role, criticality, created_at, updated_at)
     VALUES (NULL, 1, ?, 'dev', 3, 't', 't')`,
  ).run('没编号的乙');

  const before = snapshot(db);
  rebuildSearchIndex(db);
  assert.deepEqual(snapshot(db), before, '新库上重建索引也必须幂等');

  // 没编号的那条，索引里要是标题而不是空
  assert.ok(
    before.some((r) => r.title === '没编号的乙'),
    'NULL || \' \' 是 NULL —— 用了 code || title 的话这里会是空串，也就是搜不到',
  );

  db.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test('迁移：记录 checksum，重复跑是空操作', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-checksum-'));
  const db = openDb(path.join(work, 'm.db'));

  const first = migrate(db);
  assert.ok(first.length >= 8, `应该有至少 8 个迁移，实际 ${first.length}`);
  assert.equal(migrate(db).length, 0, '第二次跑不该再应用任何迁移');

  db.close();
  fs.rmSync(work, { recursive: true, force: true });
});
