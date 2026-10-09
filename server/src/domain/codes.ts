/**
 * 编号的规范化与校验。
 *
 * 编号的作用只有一个：**一个你能记住、说得出、打得快的短标识**。
 * 所以它要么没有，要么必须是一个**单 token** —— 它会被塞进命令面板的 `#引用` 里，
 * 带空格的编号会被切成两半，引用不上，而那种错会表现成「明明填了编号却找不到」。
 *
 * 放在独立模块是因为 items 和 projects 都要用，而那两个域不该互相 import 成环。
 */

/** 最长多少字。够长了（`REQ-1234` 八位），再长就不叫短标识了 */
const MAX_LEN = 40;

import { one, type Db } from '../db/index.ts';

export function normalizeCode(v: unknown, what = '编号'): string | null {
  if (v === undefined || v === null) return null;

  const raw = String(v).trim();
  if (!raw) return null;

  if (/\s/.test(raw)) {
    throw new Error(`${what}不能包含空格 —— 它要用在 #引用 里，空格会把引用切断`);
  }
  if (/[#@]/.test(raw)) {
    throw new Error(`${what}不能包含 # 或 @ —— 这两个符号是命令面板的语法`);
  }
  if (raw.length > MAX_LEN) {
    throw new Error(`${what}太长了（${raw.length} 字）—— 它是给人快速输入的短标识`);
  }

  return raw;
}

/**
 * 检查和别人撞车。
 *
 * 数据库上的 UNIQUE 是兜底，但它报的是 `UNIQUE constraint failed: item.code` ——
 * 那是给开发者看的。这里提前查一次，好告诉用户**是谁占了**。
 */
export function assertCodeFree(
  db: Db,
  table: 'item' | 'project',
  nameCol: 'title' | 'name',
  code: string,
  exceptId: number,
): void {
  const clash = one<{ id: number; name: string }>(
    db,
    `SELECT id, ${nameCol} AS name FROM ${table} WHERE code = ? COLLATE NOCASE AND id <> ?`,
    code,
    exceptId,
  );

  if (clash) {
    throw new Error(`编号「${code}」已经被「${clash.name}」占了`);
  }
}
