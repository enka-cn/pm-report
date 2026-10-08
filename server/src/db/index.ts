import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DATA_DIR } from '../config.ts';

export type Db = DatabaseSync;

/**
 * 打开数据库并设置连接级 PRAGMA。
 *
 * 注意：PRAGMA foreign_keys 是**连接级**开关，靠迁移文件里的语句是设不上的，
 * 必须每次开连接都设，否则外键约束形同虚设。
 */
export function openDb(dbPath: string = DB_PATH): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** 内存库，测试用 */
export function openMemoryDb(): Db {
  const db = new DatabaseSync(':memory:');
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
