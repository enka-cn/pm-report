export function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDay(value: string | null): string {
  return value ?? '—';
}

/** ISO 时刻 → 本地日期（只到天） */
export function fmtLocalDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayIso(): string {
  return fmtLocalDay(new Date().toISOString());
}

/** ISO 时刻 → <input type="date"> 需要的 YYYY-MM-DD */
export function toDateInput(value: string | null): string {
  return value ? value.slice(0, 10) : '';
}

/**
 * 给人看的体积。**GB / TB 也要能显示** —— 误传一个模型包是真实会发生的事，
 * 那时候显示成「204800.0 MB」等于没说。
 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
