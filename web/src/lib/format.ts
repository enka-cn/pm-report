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
