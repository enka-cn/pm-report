/**
 * 日期工具。
 *
 * 全系统的约定（见 docs/design.md §4）：
 *   - 「日期」只有年月日，'YYYY-MM-DD'，用于 DDL 语义
 *   - 「时刻」是 ISO 8601 UTC，用于发生时间
 * 这里只处理「日期」。天数一律按 UTC 天数序号相减，避免本地时区把差算歪一天。
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  // 挡住 2026-02-31 这种格式对但日子不存在的输入
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function assertDateOnly(value: string, field: string): void {
  if (!isDateOnly(value)) {
    throw new Error(`${field} 必须是 YYYY-MM-DD 格式的合法日期，收到: ${value}`);
  }
}

/**
 * ISO 时刻 → 本地日期 'YYYY-MM-DD'。
 *
 * 凡是「把某个发生时刻当作哪一天」的地方都要走这里。直接用
 * `ts.slice(0, 10)` 取的是 UTC 日期，在 UTC+8 下本地凌晨 0~8 点发生的
 * 事情会被算到前一天，「几天没动静」就少算一天。
 */
export function localDate(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 今天是哪天（**按本地时区**）。
 *
 * 不能用 `toISOString().slice(0, 10)`：在 UTC+8 这类时区，本地凌晨 0~8 点时
 * UTC 日期还停在昨天，于是「还有几天到期」会整体差一天。
 * 存储照旧用 UTC 时刻，只有「日期」这个概念按本地算。
 */
export function todayIso(): string {
  return localDate(new Date().toISOString());
}

/** 把 'YYYY-MM-DD' 或 ISO 时刻统一降到「天」的序号 */
export function dayNumber(dateOrTimestamp: string): number {
  const parts = dateOrTimestamp.slice(0, 10).split('-');
  return Math.round(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) / DAY_MS);
}

/** to - from，单位天。负数表示 to 在 from 之前。 */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** 在 'YYYY-MM-DD' 上加减天数 */
export function shiftDays(dateStr: string, days: number): string {
  return new Date(dayNumber(dateStr) * DAY_MS + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 解析命令行里的日期表达式，供命令面板的 `due:` 和 `/ddl` 使用。
 * 支持：'2026-03-05' / '3d' / '+3d' / 'today'
 */
export function parseDateExpr(expr: string, today: string = todayIso()): string {
  const value = expr.trim().toLowerCase();
  if (value === 'today' || value === '今天') return today;

  const rel = /^\+?(\d+)d$/.exec(value);
  if (rel) return shiftDays(today, Number(rel[1]));

  if (isDateOnly(value)) return value;

  throw new Error(`看不懂的日期「${expr}」。可用 '2026-03-05'、'3d'（今天起 3 天）或 'today'`);
}
