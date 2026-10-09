import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DATA_DIR } from '../config.ts';

export type Db = DatabaseSync;

/**
 * 这个项目要求的最低 SQLite 版本。
 *
 * 迁移 007 用了 `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`，**那是 SQLite 3.53 才有的能力**
 * （把「去掉 NOT NULL」从「建新表 → 拷 → 删旧 → 改名」的重建流程变成一次写）。
 *
 * 为什么值得单独守一道：**Node 自带的 SQLite 版本随发布而变**，而且和 Node 的版本号没有对应关系 ——
 * Node 22.22 是 3.50.4、22.23 是 3.51.3、24.21 是 3.53.4。所以「我装了 Node 24」并不等于「SQLite 够新」。
 *
 * 不守的话，用户看到的是一句 `near "ALTER": syntax error` —— 从这句话里根本看不出是版本问题。
 */
const MIN_SQLITE = [3, 53, 0] as const;

/** 把 `3.53.4` 拆成数字数组。遇到非数字（某些构建带后缀）就截断。 */
export function parseSqliteVersion(version: string): number[] {
  const parts: number[] = [];
  for (const piece of version.trim().split('.')) {
    const n = Number.parseInt(piece, 10);
    if (!Number.isFinite(n)) break;
    parts.push(n);
  }
  return parts;
}

/** 按逐段数字比较（不能用字符串比：`'3.9' > '3.53'` 会是 true） */
export function sqliteIsTooOld(version: string, min: readonly number[] = MIN_SQLITE): boolean {
  const got = parseSqliteVersion(version);
  for (let i = 0; i < min.length; i++) {
    const a = got[i] ?? 0;
    const b = min[i]!;
    if (a !== b) return a < b;
  }
  return false;
}

function tooOldMessage(version: string): string {
  return (
    `SQLite 版本太低：当前 ${version}，需要 ${MIN_SQLITE.join('.')} 以上。\n\n` +
    `这个项目依赖 SQLite 3.53 的 ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL（迁移 007 用它把\n` +
    `需求编号改成可选）。老版本没有这个能力，只能走「建新表 → 拷 → 删旧 → 改名」的重建流程，\n` +
    `而 item 被 7 张表 + 视图 + 一堆触发器引用 —— 那是整个项目里最危险的一类迁移。\n\n` +
    `Node 自带的 SQLite 版本**随发布而变**，和 Node 版本号没有对应关系：\n` +
    `  Node 22.22 → 3.50.4    Node 22.23 → 3.51.3    Node 24.21 → 3.53.4\n` +
    `所以「我装的是 Node 24」不等于「SQLite 够新」。**升级 Node 是唯一的办法**（Node 22 全线都不够）。`
  );
}

/**
 * 开完连接先验版本，让版本问题在**跑迁移之前**就用一句人话报出来。
 *
 * 参数收窄成结构类型（只要有个能查版本的 prepare），这样测试能塞一个假连接进来 ——
 * 否则「SQLite 太旧」这条分支在够新的机器上永远测不到。
 */
export function assertSqliteVersion(db: {
  prepare: (sql: string) => { get: () => unknown };
}): void {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | undefined;
  const version = String(row?.v ?? '');
  if (sqliteIsTooOld(version)) throw new Error(tooOldMessage(version));
}

/**
 * 打开数据库并设置连接级 PRAGMA。
 *
 * 注意：PRAGMA foreign_keys 是**连接级**开关，靠迁移文件里的语句是设不上的，
 * 必须每次开连接都设，否则外键约束形同虚设。
 */
export function openDb(dbPath: string = DB_PATH): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  assertSqliteVersion(db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** 内存库，测试用 */
export function openMemoryDb(): Db {
  const db = new DatabaseSync(':memory:');
  assertSqliteVersion(db);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** 扁平事务。不做嵌套——嵌套会静默失效，不如直接不支持。 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误，别把它盖掉 */
    }
    throw err;
  }
}

/** 取一行。node:sqlite 的 get() 返回 unknown，这里统一收口成泛型。 */
export function one<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(db: Db, sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}

/** INSERT 之后取自增主键 */
export function lastId(info: { lastInsertRowid: number | bigint }): number {
  return Number(info.lastInsertRowid);
}

export function count(db: Db, sql: string, ...params: unknown[]): number {
  const row = one<{ n: number | bigint }>(db, sql, ...params);
  return Number(row?.n ?? 0);
}

/** ISO 8601 时刻（UTC），对应设计文档里的“时刻”类字段 */
export function nowIso(): string {
  return new Date().toISOString();
}

export { DATA_DIR };
