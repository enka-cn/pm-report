import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import type { DashboardSection, ItemDetail } from '@manager/shared';
import { codeOf, makeApp } from './helpers.ts';

type App = ReturnType<typeof createApp>;

/**
 * 设计文档 P1 的验收清单，逐条跑出来。
 *
 * 写成常驻测试而不是一次性脚本：验收标准会随代码一起演进，
 * 下次改动把哪一步跑坏了，`pnpm test` 会直接指出来。
 *
 * 「新建一个 dev 角色需求 → 自动生成 7 个阶段和 todo → 上传一份文档 → 推进两个阶段
 *   → 建一条阻塞 → 挂起它 → 恢复并关闭 → 命令面板输入 REQ-xxx 能跳转 → 驾驶舱各桶判定正确」
 */

const dev = (app: App) => ({
  post: (url: string, body: unknown = {}) =>
    app.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  patch: (url: string, body: unknown) =>
    app.request(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  get: (url: string) => app.request(url),
});

function shiftDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function codes(sections: DashboardSection[], key: string): string[] {
  return sections.find((s) => s.key === key)!.cards.map((c) => c.code ?? '(无编号)');
}

test('P1 验收流程', async () => {
  const { db, app } = makeApp();
  const api = dev(app);
  const today = new Date().toISOString().slice(0, 10);
  const log: string[] = [];

  // ---- 1. 新建一个 dev 角色需求，给一个已经过去的整体 DDL 好验证逾期 ----
  //      编号显式给：真实的公司需求本来就有自己的单号，系统不再自动生成 REQ-N
  const created = await api.post('/api/items', {
    title: '接口鉴权改造',
    code: 'REQ-2026-0042',
    role: 'dev',
    criticality: 5,
    dueAt: shiftDays(today, -5),
  });
  assert.equal(created.status, 201);
  let detail = (await created.json()) as ItemDetail;

  assert.equal(detail.stages.length, 7);
  assert.equal(detail.todos.length, 15);
  assert.ok(detail.stages[0]!.actual_start_at, '首阶段应自动开始');
  assert.equal(detail.item.active_stage_id, detail.stages[0]!.id);
  assert.equal(detail.item.condition, 'normal');
  log.push(
    `建需求 ${detail.item.code}（dev）→ ${detail.stages.length} 个阶段 / ${detail.todos.length} 项待办，` +
      `首阶段「${detail.stages[0]!.name}」自动开始`,
  );

  // ---- 2. 上传一份文档作为必交交付物 ----
  const form = new FormData();
  form.set('itemId', String(detail.item.id));
  form.set('stageId', String(detail.stages[0]!.id));
  form.set('name', '架构设计说明');
  form.set('category', 'design');
  form.set('required', 'true');
  form.set('file', new File([Buffer.from('# 架构设计说明', 'utf8')], '说明.md'));

  const uploaded = await app.request('/api/deliverables', { method: 'POST', body: form });
  assert.equal(uploaded.status, 201);
  const deliverable = (await uploaded.json()) as { name: string; versions: { version_no: number }[] };
  log.push(`上传必交交付物「${deliverable.name}」v${deliverable.versions[0]!.version_no}`);

  // ---- 3. 推进两个阶段（推进前必须先勾完待办 —— 这是 D5） ----
  for (let i = 0; i < 2; i++) {
    const current = (await (await api.get(`/api/items/${detail.item.id}`)).json()) as ItemDetail;
    const active = current.stages.find((s) => s.id === current.item.active_stage_id)!;

    const refused = await api.post(`/api/stages/${active.id}/advance`);
    assert.equal(refused.status, 400, '待办没勾完时应拒绝推进');

    for (const todo of current.todos.filter((t) => t.stage_id === active.id && t.done === 0)) {
      await api.patch(`/api/todos/${todo.id}`, { done: true });
    }

    const advanced = await api.post(`/api/stages/${active.id}/advance`);
    assert.equal(advanced.status, 200);
    const body = (await advanced.json()) as ItemDetail & {
      result: { fromStageName: string; toStageName: string };
    };
    log.push(`推进：${body.result.fromStageName} → ${body.result.toStageName}`);
    detail = body;
  }
  assert.equal(detail.stages[0]!.outcome, 'completed');
  assert.equal(detail.stages[1]!.outcome, 'completed');
  assert.equal(detail.item.active_stage_id, detail.stages[2]!.id);

  // ---- 4. 建一条阻塞 ----
  const blockerRes = await api.post('/api/blockers', {
    itemId: detail.item.id,
    direction: 'blocked_by_others',
    counterparty: '测试组',
    need: '测试报告',
    severity: 'high',
  });
  assert.equal(blockerRes.status, 201);
  const blockerId = ((await blockerRes.json()) as { blockerId: number }).blockerId;

  detail = (await (await api.get(`/api/items/${detail.item.id}`)).json()) as ItemDetail;
  assert.equal(detail.item.condition, 'blocked');
  log.push(`建阻塞：等 测试组 的测试报告 → 状况变为「${detail.item.condition}」`);

  let sections = ((await (await api.get('/api/dashboard')).json()) as { sections: DashboardSection[] })
    .sections;
  assert.ok(codes(sections, 'overdue').includes(codeOf(detail.item)), '应落在逾期桶');
  assert.ok(codes(sections, 'blocked_by_others').includes(codeOf(detail.item)), '应落在「我被阻塞」桶');
  log.push(
    `驾驶舱：逾期 [${codes(sections, 'overdue').join(',')}]、` +
      `我被阻塞 [${codes(sections, 'blocked_by_others').join(',')}] —— 同一需求可同时在多个桶`,
  );

  // ---- 5. 挂起：退出逾期/阻塞桶，只进挂起桶 ----
  const suspended = await api.post(`/api/items/${detail.item.id}/suspend`, {
    reason: '人力被抽调到现网问题',
  });
  assert.equal(suspended.status, 200);
  detail = (await suspended.json()) as ItemDetail;
  assert.equal(detail.item.condition, 'suspended');

  sections = ((await (await api.get('/api/dashboard')).json()) as { sections: DashboardSection[] })
    .sections;
  assert.equal(codes(sections, 'overdue').includes(codeOf(detail.item)), false, '挂起后应退出逾期桶');
  assert.equal(
    codes(sections, 'blocked_by_others').includes(codeOf(detail.item)),
    false,
    '挂起后应退出被阻塞桶',
  );
  assert.ok(codes(sections, 'suspended').includes(codeOf(detail.item)));

  const suspendedCard = sections
    .find((s) => s.key === 'suspended')!
    .cards.find((c) => c.code === detail.item.code)!;
  assert.match(suspendedCard.reason, /挂起时已逾期 5 天/, '挂起不能变成藏逾期的地方');
  log.push(`挂起 → 状况「suspended」，退出逾期/阻塞桶；卡片标注「${suspendedCard.reason}」`);

  // ---- 6. 恢复：阻塞还在，所以回到 blocked ----
  detail = (await (await api.post(`/api/items/${detail.item.id}/resume`)).json()) as ItemDetail;
  assert.equal(detail.item.condition, 'blocked');
  log.push('恢复 → 阻塞尚未解除，状况回到「blocked」');

  // ---- 7. 解除阻塞后关闭 ----
  await api.patch(`/api/blockers/${blockerId}`, { resolution: '报告已收到' });
  detail = (await (await api.get(`/api/items/${detail.item.id}`)).json()) as ItemDetail;
  assert.equal(detail.item.condition, 'normal');

  const closed = await api.post(`/api/items/${detail.item.id}/close`, { reason: 'cancelled' });
  assert.equal(closed.status, 200);
  detail = (await closed.json()) as ItemDetail;
  assert.equal(detail.item.condition, 'closed');

  sections = ((await (await api.get('/api/dashboard')).json()) as { sections: DashboardSection[] })
    .sections;
  assert.ok(sections.every((s) => s.cards.length === 0), '关闭后不应出现在任何桶里');
  log.push('解除阻塞 → 关闭 → 状况「closed」，驾驶舱各桶均为空');

  // ---- 8. 命令面板输入编号能跳转 ----
  assert.ok(detail.item.code, '这条验收路径的前提是需求有编号');
  const itemCode = detail.item.code;
  const jump = (await (
    await api.get(`/api/palette/query?q=${encodeURIComponent(itemCode)}`)
  ).json()) as { candidates: { kind: string; itemId?: number }[] };
  const target = jump.candidates.find((c) => c.kind === 'jump');
  assert.equal(target?.itemId, detail.item.id, `${itemCode} 应能跳到对应需求`);

  const exact = (await (
    await api.get(`/api/palette/query?q=${encodeURIComponent(`>${itemCode}`)}`)
  ).json()) as { candidates: unknown[] };
  assert.equal(exact.candidates.length, 1, '>编号 应精确命中');
  log.push(`命令面板：输入 ${detail.item.code} 跳转到该需求；>${detail.item.code} 精确命中`);

  // ---- 9. 时间线可完整复盘 ----
  const timeline = (await (
    await api.get(`/api/items/${detail.item.id}/timeline`)
  ).json()) as { events: { type: string }[] };
  const types = timeline.events.map((e) => e.type);
  assert.deepEqual(types, [
    'item_created',
    'stage_enter',
    'deliverable_added',
    'todo_done',
    'todo_done',
    'stage_exit',
    'stage_enter',
    'todo_done',
    'todo_done',
    'todo_done',
    'stage_exit',
    'stage_enter',
    'blocker_open',
    'suspend',
    'resume',
    'blocker_close',
    'item_close',
  ]);
  log.push(`时间线 ${types.length} 条事件，可完整复盘整个推进过程`);

  console.log('\n  ── P1 验收 ──');
  for (const line of log) console.log(`  · ${line}`);
  console.log('');

  db.close();
});
