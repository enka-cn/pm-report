import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { ROLE_LABELS } from '../src/domain/labels.ts';
import { createItem, closeItem, getItem } from '../src/domain/items.ts';
import { advanceStage } from '../src/domain/stages.ts';
import { createProject } from '../src/domain/projects.ts';
import { computeDashboardPayload } from '../src/domain/dashboard.ts';
import { REAL_TODAY, completeStageTodos, freshDb, makeApp, shift } from './helpers.ts';

const TEMPLATES = loadPipelines();

// ---------------------------------------------------------------------------
// 模板本身
// ---------------------------------------------------------------------------

test('内置模板：key 唯一、阶段非空、角色都有中文标签', () => {
  const keys = TEMPLATES.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, '模板 key 必须唯一');

  for (const t of TEMPLATES) {
    assert.ok(t.stages.length > 0, `${t.key} 没有阶段`);
    assert.ok(
      ROLE_LABELS[t.role],
      `${t.key} 的角色「${t.role}」没有中文标签 —— 界面上会显示成 undefined`,
    );
    const stageKeys = t.stages.map((s) => s.key);
    assert.equal(new Set(stageKeys).size, stageKeys.length, `${t.key} 的阶段 key 重复`);
  }
});

test('每一条模板都能真的建出需求 —— 模板和建需求逻辑必须一致', () => {
  const db = freshDb();

  for (const template of TEMPLATES) {
    const detail = createItem(db, TEMPLATES, {
      title: `试 ${template.key}`,
      role: template.role,
      pipelineKey: template.key,
    });
    assert.equal(detail.stages.length, template.stages.length, `${template.key} 阶段数对不上`);
    assert.deepEqual(
      detail.stages.map((s) => s.name),
      template.stages.map((s) => s.name),
      `${template.key} 阶段名对不上`,
    );

    // 模板里声明的待办要真的实例化出来
    const expectedTodos = template.stages.flatMap((s) => s.todos ?? []).length;
    assert.equal(detail.todos.length, expectedTodos, `${template.key} 待办数对不上`);
  }

  db.close();
});

test('看护维护流水线的预设：定位 → 修复 → 验证 → 合入', () => {
  const maint = TEMPLATES.find((t) => t.key === 'maint_default');
  assert.ok(maint, '看护维护流水线应该内置');
  assert.equal(maint.role, 'maint');
  assert.deepEqual(
    maint.stages.map((s) => s.name),
    ['定位', '修复', '验证', '合入'],
  );
  // 给一个 bug 修复用的流程不该带一堆模板待办
  const totalTodos = maint.stages.reduce((n, s) => n + (s.todos?.length ?? 0), 0);
  assert.ok(totalTodos <= 10, `待办太多了（${totalTodos} 条），就不轻量了`);
});

test('维护角色现在可以建需求了（之前下拉里有、选中必失败）', () => {
  const db = freshDb();
  const detail = createItem(db, TEMPLATES, { title: '修个 bug', role: 'maint' });
  assert.equal(detail.item.role, 'maint');
  assert.equal(detail.item.active_stage_id, detail.stages[0]!.id);
  assert.equal(detail.stages[0]!.name, '定位');
  db.close();
});

test('没有模板的角色会报人话，并列出已有模板', () => {
  const db = freshDb();
  assert.throws(
    () => createItem(db, TEMPLATES, { title: 'x', role: 'test' }),
    /角色 test 没有对应的流水线模板.*maint_default/,
    '报错要告诉人「现在有哪些能用」',
  );
  db.close();
});

// ---------------------------------------------------------------------------
// 端到端：这就是用户描述的看护场景
// ---------------------------------------------------------------------------

test('看护场景端到端：算法团队交付 → 算法侧报 bug → 修完关闭', () => {
  const db = freshDb();

  // ① 算法团队交付过来的东西：我们长期看护，没有交付日期
  const project = createProject(db, {
    name: '模型量化',
    kind: 'caretaking',
    watchFor: '算法侧报 bug 时',
    description: '算法组交付，两个平台已量化；平时只有零星 bug 要处理。',
  });

  // 容器不进时间桶 —— 没有 DDL 也不会被「无 DDL」桶念
  let dash = computeDashboardPayload(db, { today: REAL_TODAY });
  assert.equal(dash.caretaking.length, 1);
  assert.equal(
    dash.caretaking[0]!.active_items,
    0,
    '没有在途子需求是看护的正常状态，不算停滞',
  );

  // ② 触发：算法侧报了一个 bug，建一条维护需求（不用走反串讲 → DT → 送测那一整套）
  const bug = createItem(db, TEMPLATES, {
    title: '平台A 量化结果偏差',
    role: 'maint',
    pipelineKey: 'maint_default',
    projectId: project.id,
    dueAt: shift(REAL_TODAY, 3),
    criticality: 4,
  });
  assert.deepEqual(
    bug.stages.map((s) => s.name),
    ['定位', '修复', '验证', '合入'],
  );
  assert.equal(bug.project.id, project.id);

  dash = computeDashboardPayload(db, { today: REAL_TODAY });
  assert.equal(dash.caretaking[0]!.active_items, 1, '有在途子需求了');
  assert.deepEqual(
    dash.sections.find((s) => s.key === 'due_soon')!.cards.map((c) => c.code),
    [bug.item.code],
    '子需求是普通需求，有 DDL 就照常进临期桶',
  );

  // ③ 一步步修完
  for (const template of TEMPLATES.find((t) => t.key === 'maint_default')!.stages) {
    const stage = getItem(db, bug.item.id)!.stages.find((s) => s.key === template.key)!;
    completeStageTodos(db, stage.id);
    advanceStage(db, { itemId: bug.item.id, stageId: stage.id });
  }

  // ④ 关闭
  closeItem(db, bug.item.id, { reason: 'done' });
  const closed = getItem(db, bug.item.id)!;
  assert.equal(closed.item.condition, 'closed');
  assert.equal(closed.stages.every((s) => s.actual_end_at !== null), true, '四个阶段都走完了');

  // ⑤ 看护清单回到安静状态，历史留在容器下面
  dash = computeDashboardPayload(db, { today: REAL_TODAY });
  assert.equal(dash.caretaking[0]!.active_items, 0);
  assert.equal(dash.caretaking[0]!.total_items, 1, '历史子需求还挂在容器下');

  db.close();
});

test('HTTP：/api/pipelines 里每条模板的 role 都有标签', async () => {
  const { db, app } = makeApp();
  const res = await app.request('/api/pipelines');
  const { pipelines } = (await res.json()) as {
    pipelines: { key: string; role: string; stages: unknown[] }[];
  };

  assert.ok(pipelines.length >= 3);
  for (const p of pipelines) {
    assert.ok(
      (ROLE_LABELS as Record<string, string>)[p.role],
      `${p.key} 的角色 ${p.role} 没有中文标签`,
    );
    assert.ok(p.stages.length > 0);
  }

  // 新建需求的下拉框就是照这个列表渲染的，所以「列出来的都能用」是硬要求
  const meta = (await (await app.request('/api/meta')).json()) as { roles: Record<string, string> };
  const usableRoles = new Set(pipelines.map((p) => p.role));
  assert.ok(usableRoles.has('maint'), '维护角色现在应该可用');
  assert.ok(meta.roles['maint'], '而且要有中文标签');

  db.close();
});
