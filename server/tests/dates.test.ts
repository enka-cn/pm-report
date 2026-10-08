import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysBetween,
  isDateOnly,
  localDate,
  parseDateExpr,
  shiftDays,
  todayIso,
} from '../src/domain/dates.ts';

test('daysBetween 按天计算，不受时区影响', () => {
  assert.equal(daysBetween('2026-06-15', '2026-06-15'), 0);
  assert.equal(daysBetween('2026-06-15', '2026-06-18'), 3);
  assert.equal(daysBetween('2026-06-15', '2026-06-10'), -5);
  assert.equal(daysBetween('2026-01-31', '2026-02-01'), 1);
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1);
  assert.equal(daysBetween('2026-03-01', '2026-02-28'), -1);
});

test('localDate 按本地时区把时刻归到某一天', () => {
  const noon = new Date(2026, 5, 15, 12, 0, 0);
  assert.equal(localDate(noon.toISOString()), '2026-06-15');

  // 本地当天 00:30。在东八区这类 UTC 正偏移的时区里，这个时刻的 UTC 日期
  // 还停在 6-14 —— 这正是不能用 slice(0, 10) 的原因。
  const earlyMorning = new Date(2026, 5, 15, 0, 30, 0);
  assert.equal(localDate(earlyMorning.toISOString()), '2026-06-15');

  if (new Date().getTimezoneOffset() < 0) {
    assert.notEqual(
      earlyMorning.toISOString().slice(0, 10),
      '2026-06-15',
      '本机是 UTC 正偏移时区，UTC 日期此时应落后一天（说明这个测试确实在验证时区处理）',
    );
  }
});

test('localDate 遇到非法输入不抛异常，退回原字符串前 10 位', () => {
  assert.equal(localDate('2026-06-15'), '2026-06-15');
  assert.equal(localDate('乱七八糟'), '乱七八糟');
});

test('todayIso 返回本地日期，而不是 UTC 日期', () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  assert.equal(todayIso(), `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  assert.equal(todayIso(), localDate(now.toISOString()));
});

test('isDateOnly 挡住格式对但日子不存在的输入', () => {
  assert.equal(isDateOnly('2026-06-15'), true);
  assert.equal(isDateOnly('2026-02-31'), false, '2 月没有 31 号');
  assert.equal(isDateOnly('2026-13-01'), false);
  assert.equal(isDateOnly('2026-2-5'), false, '必须补零');
  assert.equal(isDateOnly('20260615'), false);
  assert.equal(isDateOnly('today'), false);
});

test('parseDateExpr 支持绝对日期、相对天数和 today', () => {
  const today = '2026-06-15';
  assert.equal(parseDateExpr('2026-07-01', today), '2026-07-01');
  assert.equal(parseDateExpr('3d', today), '2026-06-18');
  assert.equal(parseDateExpr('+3d', today), '2026-06-18');
  assert.equal(parseDateExpr('0d', today), '2026-06-15');
  assert.equal(parseDateExpr('today', today), '2026-06-15');
  assert.equal(parseDateExpr('今天', today), '2026-06-15');

  assert.throws(() => parseDateExpr('下个月', today), /看不懂的日期/);
  assert.throws(() => parseDateExpr('2026-02-31', today), /看不懂的日期/);
});

test('shiftDays 跨月、跨年、跨闰日都正确', () => {
  assert.equal(shiftDays('2026-01-31', 1), '2026-02-01');
  assert.equal(shiftDays('2025-12-31', 1), '2026-01-01');
  assert.equal(shiftDays('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDays('2024-02-28', 1), '2024-02-29', '2024 是闰年');
  assert.equal(shiftDays('2026-02-28', 1), '2026-03-01', '2026 不是闰年');
  assert.equal(shiftDays('2026-06-15', 0), '2026-06-15');
});
