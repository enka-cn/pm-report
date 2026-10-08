import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, one, nowIso, type Db } from './index.ts';
import { DB_PATH } from '../config.ts';

export interface MigrationRecord {
  name: string;
  checksum: string;
  applied_at: string;
}

export const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 迁移运行器：按文件名排序应用 migrations/*.sql，已应用的记在 schema_migrations 里。
 *
 * 已应用迁移的 checksum 被改动时会直接报错，而不是默默跑过去 ——
 * 这个系统要陪你很多年，schema 漂移必须响亮地失败。
 */
export function migrate(db: Db, migrationsDir: string = MIGRATIONS_DIR): MigrationRecord[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedRows = db
    .prepare('SELECT name, checksum, applied_at FROM schema_migrations')
    .all() as unknown as MigrationRecord[];
  const applied = new Map(appliedRows.map((r) => [r.name, r]));

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const justApplied: MigrationRecord[] = [];

  for (const name of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    const checksum = sha256(sql);
    const prev = applied.get(name);

    if (prev) {
      if (prev.checksum !== checksum) {
        throw new Error(
          `迁移 ${name} 在应用后被修改过（checksum 不匹配）。\n` +
            `  已应用: ${prev.checksum}\n  当前文件: ${checksum}\n` +
            `已应用的迁移是不可变的 —— 请新增 00N_xxx.sql 来表达这次变更。`,
        );
      }
      continue;
    }

    // SQLite 的 DDL 是事务性的，可以整体回滚
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      const record: MigrationRecord = { name, checksum, applied_at: nowIso() };
      db.prepare(
        'INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
      ).run(record.name, record.checksum, record.applied_at);
      db.exec('COMMIT');
      justApplied.push(record);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 保留原始错误 */
      }
      throw new Error(`迁移 ${name} 失败: ${(err as Error).message}`, { cause: err });
    }
  }

  return justApplied;
}

/** 已应用但文件已消失的迁移，属于异常状态，值得在启动时提醒 */
export function orphanMigrations(db: Db, migrationsDir: string = MIGRATIONS_DIR): string[] {
  const onDisk = new Set(
    fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql')),
  );
  const rows = db
    .prepare('SELECT name FROM schema_migrations ORDER BY name')
    .all() as unknown as { name: string }[];
  return rows.map((r) => r.name).filter((n) => !onDisk.has(n));
}

export function isMigrated(db: Db): boolean {
  const row = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
  );
  return Number(row?.n ?? 0) > 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const db = openDb();
  try {
    const applied = migrate(db);
    if (applied.length === 0) {
      console.log('数据库已是最新，无迁移需要应用。');
    } else {
      for (const m of applied) console.log(`已应用迁移: ${m.name}`);
    }
    const orphans = orphanMigrations(db);
    if (orphans.length > 0) {
      console.warn(`警告：以下迁移已应用但源文件不存在 —— ${orphans.join(', ')}`);
    }
    console.log(`数据库: ${DB_PATH}`);
  } finally {
    db.close();
  }
}
