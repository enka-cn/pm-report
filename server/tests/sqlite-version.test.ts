import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSqliteVersion,
  openDb,
  openMemoryDb,
  parseSqliteVersion,
  sqliteIsTooOld,
} from '../src/db/index.ts';
import type { Db } from '../src/db/index.ts';

/**
 * SQLite 版本门槛。
 *
 * 这一组测试的存在理由：**「SQLite 太旧」这条分支在够新的机器上永远不会自己触发**，
 * 所以不写测试就等于没写守卫 —— 而它要防的恰恰是「换台机器就起不来」。
 */

test('解析版本号：容忍后缀和脏输入', () => {
  assert.deepEqual(parseSqliteVersion('3.53.4'), [3, 53, 4]);
  assert.deepEqual(parseSqliteVersion('  3.53.4  '), [3, 53, 4]);
  assert.deepEqual(parseSqliteVersion('3.53'), [3, 53]);
  assert.deepEqual(parseSqliteVersion('3.53.4-beta1'), [3, 53, 4], '非数字段就截断');
  assert.deepEqual(parseSqliteVersion(''), []);
});

test('版本比较：逐段按数字比，不能按字符串比', () => {
  // 按字符串比的话 '3.9.9' > '3.53.0' 会成立，那就把太旧的放进来了
  assert.equal(sqliteIsTooOld('3.9.9'), true, '字符串比较会在这里出错');

  assert.equal(sqliteIsTooOld('3.50.4'), true, 'Node 22.22 就是它');
  assert.equal(sqliteIsTooOld('3.51.3'), true, 'Node 22.23 就是它');
  assert.equal(sqliteIsTooOld('3.52.9'), true, '3.53 之前都不行');
  assert.equal(sqliteIsTooOld('3.53.0'), false, 'ALTER COLUMN 是 3.53 引入的');
  assert.equal(sqliteIsTooOld('3.53.4'), false, '当前开发环境');
  assert.equal(sqliteIsTooOld('3.54.0'), false);
  assert.equal(sqliteIsTooOld('4.0.0'), false, '主版本更高当然可以');
  assert.equal(sqliteIsTooOld('3.53'), false, '只写到两位也算够');
});

test('太旧时报的是一句人话，而不是 near "ALTER": syntax error', () => {
  const fake = (version: string) =>
    ({ prepare: () => ({ get: () => ({ v: version }) }) }) as unknown as Db;

  // 够新的不吭声
  assert.doesNotThrow(() => assertSqliteVersion(fake('3.53.4')));

  // 太旧的要拦住，而且话要说清楚
  const err = (() => {
    try {
      assertSqliteVersion(fake('3.50.4'));
      return null;
    } catch (e) {
      return e as Error;
    }
  })();

  assert.ok(err, '太旧的必须抛错');
  assert.match(err.message, /SQLite 版本太低：当前 3\.50\.4/);
  assert.match(err.message, /需要 3\.53\.0 以上/);
  assert.match(err.message, /ALTER TABLE \.\.\. ALTER COLUMN/, '要说清是哪个能力不够');
  assert.match(err.message, /升级 Node 是唯一的办法/, '要给得出下一步');
  assert.match(err.message, /Node 22\.22 → 3\.50\.4/, '要把「Node 版本 ≠ SQLite 版本」讲明白');
});

test('当前环境开库正常（守卫不误报）', () => {
  const db = openMemoryDb();
  const v = String((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v);
  assert.equal(sqliteIsTooOld(v), false, `当前是 ${v}，应该通过`);
  db.close();
});

test('openDb 和 openMemoryDb 都会过这道守卫', () => {
  // 两个入口都验，否则某个入口漏掉就白设了
  const db: Db = openMemoryDb();
  assert.doesNotThrow(() => assertSqliteVersion(db));
  db.close();

  const file = openDb(':memory:');
  assert.doesNotThrow(() => assertSqliteVersion(file));
  file.close();
});
