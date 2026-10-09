import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { makeApp } from './helpers.ts';

type App = ReturnType<typeof createApp>;

function postJson(app: App, url: string, body: unknown) {
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function createItem(app: App, title = '甲') {
  // 编号显式给：这几个用例要拿编号去拼命令（`/bump #REQ-x`），而编号现在是可选的。
  // 计数器而不是固定值，免得同一批用例里撞号。
  const code = `REQ-API-${++apiItemSeq}`;
  const res = await postJson(app, '/api/items', { title, code, role: 'dev' });
  assert.equal(res.status, 201);
  return (await res.json()) as {
    item: { id: number; code: string | null };
    stages: { id: number; key: string; name: string }[];
    todos: { id: number; stage_id: number }[];
  };
}

let apiItemSeq = 0;

// ---------------------------------------------------------------------------

test('请求体是字面量 null 时给业务错误，而不是内部 TypeError', async () => {
  const { db, app } = makeApp();
  const item = await createItem(app);

  const res = await postJson(app, `/api/stages/${item.stages[0]!.id}/advance`, 'null');
  const body = (await res.json()) as { error: string };

  assert.equal(res.status, 400);
  assert.doesNotMatch(body.error, /Cannot read properties/);
  // 空体等同于「什么都没传」，于是正常走到待办检查
  assert.match(body.error, /还不能推进/);

  db.close();
});

test('空体、非法 JSON、数组体都不会把接口打崩', async () => {
  const { db, app } = makeApp();
  await createItem(app);

  const empty = await app.request('/api/items', { method: 'POST' });
  assert.equal(empty.status, 400);
  assert.match(((await empty.json()) as { error: string }).error, /缺少参数 title/);

  const broken = await postJson(app, '/api/items', '{不是 JSON');
  assert.equal(broken.status, 400);
  assert.match(((await broken.json()) as { error: string }).error, /缺少参数 title/);

  const array = await postJson(app, '/api/items', [1, 2, 3]);
  assert.equal(array.status, 400);
  assert.match(((await array.json()) as { error: string }).error, /缺少参数 title/);

  db.close();
});

test('GET /api/meta 提供中文标签与命令帮助', async () => {
  const { db, app } = makeApp();

  const res = await app.request('/api/meta');
  assert.equal(res.status, 200);

  const meta = (await res.json()) as {
    roles: Record<string, string>;
    conditions: Record<string, string>;
    paletteHelp: string;
  };

  assert.equal(meta.roles['dev'], '开发');
  assert.equal(meta.conditions['blocked'], '阻塞');
  assert.match(meta.paletteHelp, /\/todo/);

  db.close();
});

test('GET /api/dashboard 始终返回 7 个桶', async () => {
  const { db, app } = makeApp();

  const empty = (await (await app.request('/api/dashboard')).json()) as {
    sections: { key: string }[];
  };
  assert.equal(empty.sections.length, 7);

  await createItem(app);
  const res = (await (await app.request('/api/dashboard')).json()) as {
    summary: Record<string, number>;
    sections: { key: string; cards: { code: string }[] }[];
  };
  // 新建需求没有 DDL，所以落在「无 DDL」桶
  assert.equal(res.summary['no_ddl'], 1);
  assert.equal(res.sections.find((s) => s.key === 'no_ddl')!.cards.length, 1);

  db.close();
});

test('完整走一遍：建需求 → 勾待办 → 推进 → 记阻塞 → 挂起 → 恢复 → 关闭', async () => {
  const { db, app } = makeApp();
  const item = await createItem(app, '接口鉴权改造');
  const s1 = item.stages[0]!;

  for (const todo of item.todos.filter((t) => t.stage_id === s1.id)) {
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    assert.equal(res.status, 200);
  }

  const advanced = await postJson(app, `/api/stages/${s1.id}/advance`, {});
  assert.equal(advanced.status, 200);
  const afterAdvance = (await advanced.json()) as {
    result: { fromStageName: string; toStageName: string };
    item: { active_stage_id: number; condition: string };
  };
  assert.equal(afterAdvance.result.fromStageName, '需求反串讲');
  assert.equal(afterAdvance.result.toStageName, '开发');
  assert.equal(afterAdvance.item.condition, 'normal');

  const blocked = await postJson(app, '/api/blockers', {
    itemId: item.item.id,
    direction: 'blocked_by_others',
    counterparty: '张三',
    need: '接口定义',
  });
  assert.equal(blocked.status, 201);

  const afterBlocker = (await (await app.request(`/api/items/${item.item.id}`)).json()) as {
    item: { condition: string };
  };
  assert.equal(afterBlocker.item.condition, 'blocked');

  await postJson(app, `/api/items/${item.item.id}/suspend`, { reason: '人力被抽走' });
  const suspended = (await (await app.request(`/api/items/${item.item.id}`)).json()) as {
    item: { condition: string };
  };
  assert.equal(suspended.item.condition, 'suspended');

  await postJson(app, `/api/items/${item.item.id}/resume`, {});
  await postJson(app, `/api/items/${item.item.id}/close`, { reason: 'cancelled' });

  const closed = (await (await app.request(`/api/items/${item.item.id}`)).json()) as {
    item: { condition: string; close_reason: string };
  };
  assert.equal(closed.item.condition, 'closed');
  assert.equal(closed.item.close_reason, 'cancelled');

  const list = (await (await app.request('/api/items')).json()) as { items: unknown[] };
  assert.equal(list.items.length, 0, '关闭后默认不出现在列表');

  db.close();
});

test('multipart 上传：去重、版本、下载都能走通', async () => {
  const { db, filesDir, app } = makeApp();
  const item = await createItem(app);
  const s1 = item.stages[0]!;

  const form = new FormData();
  form.set('itemId', String(item.item.id));
  form.set('stageId', String(s1.id));
  form.set('name', '架构设计说明');
  form.set('category', 'design');
  form.set('required', 'true');
  form.set('file', new File([Buffer.from('# 架构设计说明', 'utf8')], '说明.md', { type: 'text/markdown' }));

  const first = await app.request('/api/deliverables', { method: 'POST', body: form });
  assert.equal(first.status, 201);
  const uploaded = (await first.json()) as {
    id: number;
    deduplicated: boolean;
    current_version_id: number;
    versions: { id: number; version_no: number; sha256: string; original_filename: string }[];
  };
  assert.equal(uploaded.deduplicated, false);
  assert.equal(uploaded.versions[0]!.original_filename, '说明.md');
  const sha = uploaded.versions[0]!.sha256;

  // 同一份内容再传一次：复用落盘文件
  const again = new FormData();
  again.set('itemId', String(item.item.id));
  again.set('name', '另一份同名内容');
  again.set('file', new File([Buffer.from('# 架构设计说明', 'utf8')], 'copy.md'));
  const second = await app.request('/api/deliverables', { method: 'POST', body: again });
  const secondBody = (await second.json()) as { deduplicated: boolean };
  assert.equal(secondBody.deduplicated, true);

  const filesOnDisk = fs.readdirSync(path.join(filesDir, sha.slice(0, 2)));
  assert.equal(filesOnDisk.length, 1, '同一内容只应落一个文件');

  // 加版本
  const versionForm = new FormData();
  versionForm.set('file', new File([Buffer.from('# 架构设计说明 v2', 'utf8')], '说明-v2.md'));
  const versioned = await app.request(`/api/deliverables/${uploaded.id}/versions`, {
    method: 'POST',
    body: versionForm,
  });
  const versionedBody = (await versioned.json()) as {
    current_version_id: number;
    versions: { version_no: number }[];
  };
  assert.equal(versionedBody.versions[0]!.version_no, 2);

  // 下载
  const download = await app.request(`/api/files/${sha}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
  assert.equal(Buffer.from(await download.arrayBuffer()).toString('utf8'), '# 架构设计说明');

  db.close();
});

test('命令面板接口：先预览，再执行', async () => {
  const { db, app } = makeApp();
  const item = await createItem(app);

  const query = await app.request(
    `/api/palette/query?q=${encodeURIComponent(`/bump #${item.item.code}`)}`,
  );
  const preview = (await query.json()) as { preview?: string; error?: string };
  assert.equal(preview.error, undefined);
  assert.match(preview.preview!, /待办未完成/);
  assert.match(preview.preview!, /执行会被拒绝/);

  const jump = (await (
    await app.request(`/api/palette/query?q=${encodeURIComponent('甲')}`)
  ).json()) as { candidates: { kind: string; itemId?: number }[] };
  assert.equal(jump.candidates.find((c) => c.kind === 'jump')?.itemId, item.item.id);

  const exec = await postJson(app, '/api/palette/execute', {
    input: `/log 与架构师对齐了协议 #${item.item.code}`,
  });
  assert.equal(exec.status, 200);
  const result = (await exec.json()) as { message: string; itemId: number | null };
  assert.match(result.message, /已记录/);
  assert.equal(result.itemId, item.item.id);

  const timeline = (await (
    await app.request(`/api/items/${item.item.id}/timeline`)
  ).json()) as { events: { type: string }[] };
  assert.deepEqual(
    timeline.events.map((e) => e.type),
    ['item_created', 'stage_enter', 'note'],
  );

  db.close();
});

test('DELETE /api/todos/:id 删掉待办并留痕', async () => {
  const { db, app } = makeApp();
  const item = await createItem(app);
  const todo = item.todos[0]!;

  const res = await app.request(`/api/todos/${todo.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);

  const after = (await (await app.request(`/api/items/${item.item.id}`)).json()) as {
    todos: unknown[];
  };
  assert.equal(after.todos.length, item.todos.length - 1);

  const timeline = (await (
    await app.request(`/api/items/${item.item.id}/timeline`)
  ).json()) as { events: { type: string }[] };
  assert.ok(timeline.events.some((e) => e.type === 'todo_removed'));

  const again = await app.request(`/api/todos/${todo.id}`, { method: 'DELETE' });
  assert.equal(again.status, 400);
  assert.match(((await again.json()) as { error: string }).error, /待办不存在/);

  db.close();
});

test('GET /api/dashboard 返回分桶 + 焦点列表 + 甘特图', async () => {
  const { db, app } = makeApp();
  const item = await createItem(app);

  const payload = (await (await app.request('/api/dashboard')).json()) as {
    summary: Record<string, number>;
    sections: unknown[];
    focus: { urgent: { code: string }[] };
    gantt: { bars: unknown[]; withoutDdl: { code: string }[]; totalDays: number };
  };

  assert.equal(payload.sections.length, 7);
  assert.equal(payload.focus.urgent[0]!.code, item.item.code);
  // 新建需求没有 DDL，所以画不上时间轴，另列出来
  assert.deepEqual(
    payload.gantt.withoutDdl.map((w) => w.code),
    [item.item.code],
  );
  assert.equal(payload.gantt.bars.length, 0);
  assert.ok(payload.gantt.totalDays > 0);

  db.close();
});

test('接口报错也走同一套 JSON 形状，前端能统一处理', async () => {
  const { db, app } = makeApp();

  const notFound = await app.request('/api/items/99999');
  assert.equal(notFound.status, 400);
  const body = (await notFound.json()) as { error: string };
  assert.match(body.error, /需求不存在/);

  const badParam = await postJson(app, '/api/todos', { itemId: 'abc', text: 'x' });
  assert.equal(badParam.status, 400);
  assert.match(((await badParam.json()) as { error: string }).error, /必须是数字/);

  db.close();
});
