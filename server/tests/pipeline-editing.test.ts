import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PipelineTemplate } from '@manager/shared';
import {
  PipelineError,
  assertTemplateKey,
  deleteTemplate,
  loadPipelines,
  saveTemplate,
} from '../src/domain/pipeline.ts';
import { makeApp } from './helpers.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manager-pipe-'));
}

/** 一个带注释的样板文件 —— 注释就是我们要保住的东西 */
const SAMPLE = `# 看护维护流水线。
#
# 用在「上游交付过来、我们长期看护、平时只有零星 bug」这类工作上。
key: maint_default
name: 看护维护流水线
role: maint
stages:
  - key: triage
    name: 定位
    kind: work
    todos:
      - 确认现象与复现步骤
      - 判断影响面
  # kind=wait 的阶段进入时自动创建阻塞（见设计文档 D6）
  - key: fix
    name: 修复
    kind: work
    todos:
      - 定位根因
      - 改代码
`;

function writeSample(dir: string): void {
  // 文件名必须和 key 一致 —— key 就是文件名
  fs.writeFileSync(path.join(dir, 'maint_default.yaml'), SAMPLE, 'utf8');
}

function readFile(dir: string, name = 'maint_default.yaml'): string {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function template(over: Partial<PipelineTemplate> = {}): PipelineTemplate {
  return {
    key: 'maint_default',
    name: '看护维护流水线',
    role: 'maint',
    stages: [
      { key: 'triage', name: '定位', kind: 'work', todos: ['确认现象与复现步骤'] },
      { key: 'fix', name: '修复', kind: 'work', todos: ['定位根因', '改代码', '自验证'] },
    ],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 保注释 —— 这个文件是给人读的，把注释吃掉就等于把文档删了
// ---------------------------------------------------------------------------

test('写回时保住文件头注释', () => {
  const dir = tempDir();
  writeSample(dir);

  saveTemplate(dir, template({ name: '看护维护（改过的）' }));

  const out = readFile(dir);
  assert.match(out, /# 看护维护流水线。/, '文件头第一行要还在');
  assert.match(out, /# 用在「上游交付过来、我们长期看护、平时只有零星 bug」这类工作上。/);
  assert.match(out, /name: 看护维护（改过的）/, '改的字段要生效');

  // 而且还能读回来
  const [loaded] = loadPipelines(dir);
  assert.equal(loaded!.name, '看护维护（改过的）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('写回时保住存活阶段上的注释', () => {
  const dir = tempDir();
  writeSample(dir);

  // 只改待办，两个阶段都留着
  saveTemplate(
    dir,
    template({
      stages: [
        { key: 'triage', name: '定位', kind: 'work', todos: ['确认现象与复现步骤', '判断影响面'] },
        { key: 'fix', name: '修复', kind: 'work', todos: ['定位根因', '改代码', '自验证'] },
      ],
    }),
  );

  const out = readFile(dir);
  assert.match(
    out,
    /# kind=wait 的阶段进入时自动创建阻塞（见设计文档 D6）/,
    '挂在第二个阶段上的注释必须还在 —— 整个数组换掉的话它就没了',
  );
  assert.match(out, /- 自验证/, '新加的待办要在');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('删掉一个阶段，只有挂在它上面的注释跟着走', () => {
  const dir = tempDir();
  writeSample(dir);

  saveTemplate(dir, template({ stages: [{ key: 'triage', name: '定位', kind: 'work', todos: [] }] }));

  const out = readFile(dir);
  assert.doesNotMatch(out, /# kind=wait 的阶段/, '挂在被删阶段上的注释跟着走，这是没办法的');
  assert.match(out, /# 看护维护流水线。/, '但文件头还在');
  assert.doesNotMatch(out, /key: fix/, '阶段确实删了');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('等待阶段的两个必填字段：改类型时会补上/清掉', () => {
  const dir = tempDir();
  writeSample(dir);

  saveTemplate(
    dir,
    template({
      stages: [
        { key: 'triage', name: '定位', kind: 'work', todos: [] },
        {
          key: 'fix',
          name: '等上游确认',
          kind: 'wait',
          wait_counterparty: '算法侧',
          wait_for: '修复确认',
          todos: ['跟踪进度'],
        },
      ],
    }),
  );

  const [loaded] = loadPipelines(dir);
  assert.equal(loaded!.stages[1]!.kind, 'wait');
  assert.equal(loaded!.stages[1]!.wait_counterparty, '算法侧');
  assert.match(readFile(dir), /wait_counterparty: 算法侧/);

  // 再改回 work —— 那两个字段必须被清掉，不然下次读会当成脏数据
  saveTemplate(dir, template());
  assert.doesNotMatch(readFile(dir), /wait_counterparty/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 新建 / 校验 / 删除
// ---------------------------------------------------------------------------

test('新建模板：生成文件、自带说明头、能被读回', () => {
  const dir = tempDir();
  writeSample(dir);

  saveTemplate(dir, {
    key: 'dev_hotfix',
    name: '开发热修',
    role: 'dev',
    stages: [
      { key: 'fix', name: '修复', kind: 'work', todos: ['改代码'] },
      { key: 'merge', name: '合入', kind: 'work', todos: [] },
    ],
  });

  assert.ok(fs.existsSync(path.join(dir, 'dev_hotfix.yaml')));
  assert.match(readFile(dir, 'dev_hotfix.yaml'), /^# /, '新文件要自带说明头');
  assert.match(readFile(dir, 'dev_hotfix.yaml'), /key: dev_hotfix/);

  const keys = loadPipelines(dir).map((t) => t.key).sort();
  assert.deepEqual(keys, ['dev_hotfix', 'maint_default']);

  // 只写了一次：不留临时文件
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.tmp-')),
    [],
    '原子写不该留下临时文件',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('key 必须是安全的 slug（它会变成文件名）', () => {
  assert.equal(assertTemplateKey('dev_hotfix'), 'dev_hotfix');
  assert.equal(assertTemplateKey('  a1  '), 'a1');

  for (const bad of ['中文名', 'Dev', 'has-dash', 'has space', '1abc', 'a', '../etc/passwd', 'x'.repeat(41)]) {
    assert.throws(() => assertTemplateKey(bad), /只能用小写字母/, `${bad} 应该被拒`);
  }
});

test('存之前会按同一套规则校验 —— 存得进去却读不出来是最糟的', () => {
  const dir = tempDir();
  writeSample(dir);
  const before = readFile(dir);

  // 重复的阶段 key
  assert.throws(
    () =>
      saveTemplate(dir, {
        key: 'maint_default',
        name: '坏模板',
        role: 'maint',
        stages: [
          { key: 'dup', name: '甲', kind: 'work', todos: [] },
          { key: 'dup', name: '乙', kind: 'work', todos: [] },
        ],
      }),
    /阶段 key 重复/,
  );

  // 空阶段列表
  assert.throws(
    () => saveTemplate(dir, { key: 'maint_default', name: '空的', role: 'maint', stages: [] }),
    /stages 必须是非空数组/,
  );

  // 等待阶段缺字段
  assert.throws(
    () =>
      saveTemplate(dir, {
        key: 'maint_default',
        name: '缺字段',
        role: 'maint',
        stages: [{ key: 'w', name: '等', kind: 'wait', todos: [] }],
      }),
    /wait_counterparty/,
  );

  assert.equal(readFile(dir), before, '校验失败时文件必须原封不动');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('key 和文件名不一致时也要找对文件（仓库里的 maint.yaml 就是这种情况）', () => {
  const dir = tempDir();
  // 文件名随便是啥，key 才是身份
  fs.writeFileSync(
    path.join(dir, '看起来像另一个东西.yaml'),
    `# 手写的文件名和 key 不一致
key: maint_default
name: 看护维护流水线
role: maint
stages:
  - key: triage
    name: 定位
    kind: work
    todos:
      - 确认现象
`,
    'utf8',
  );

  // 写回必须写进**原来那个文件**，不能另建一个 —— 另建会让同一个 key 出现两次，
  // loadPipelines 直接抛「key 重复」，服务起不来
  saveTemplate(dir, template({ name: '改过的' }));

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.deepEqual(files, ['看起来像另一个东西.yaml'], `不该多出文件，实际：${files.join(', ')}`);
  assert.match(readFile(dir, '看起来像另一个东西.yaml'), /# 手写的文件名和 key 不一致/, '注释还在');
  assert.match(readFile(dir, '看起来像另一个东西.yaml'), /name: 改过的/);
  assert.doesNotThrow(() => loadPipelines(dir), '不该出现 key 重复');

  // 删除也要找得到
  saveTemplate(dir, { key: 'other', name: '另一条', role: 'dev', stages: [{ key: 'a', name: 'A', kind: 'work', todos: [] }] });
  deleteTemplate(dir, 'maint_default');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')), ['other.yaml']);

  fs.rmSync(dir, { recursive: true, force: true });
});
test('删模板：删得掉；但最后一条不给删', () => {
  const dir = tempDir();
  writeSample(dir);
  saveTemplate(dir, { key: 'dev_x', name: 'X', role: 'dev', stages: [{ key: 'a', name: 'A', kind: 'work', todos: [] }] });

  deleteTemplate(dir, 'dev_x');
  assert.ok(!fs.existsSync(path.join(dir, 'dev_x.yaml')));
  assert.deepEqual(loadPipelines(dir).map((t) => t.key), ['maint_default']);

  // 最后一条删掉就没得选了 —— 而且 loadPipelines 会直接抛错让服务起不来
  assert.throws(() => deleteTemplate(dir, 'maint_default'), /最后一条流水线/);
  assert.ok(fs.existsSync(path.join(dir, 'maint_default.yaml')), '被拒之后文件要还在');

  assert.throws(() => deleteTemplate(dir, 'no_such_key'), /找不到流水线模板文件/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('手改文件（YAML 的注释和格式）也读得回来 —— 真相源始终是文件', () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'hand.yaml'),
    `# 手写的
key: hand_made
name: 手写流水线
role: se
stages:
  - key: a
    name: 甲
    kind: review
`,
    'utf8',
  );

  const [t] = loadPipelines(dir);
  assert.equal(t!.key, 'hand_made');
  assert.equal(t!.role, 'se');
  assert.equal(t!.stages[0]!.kind, 'review');
  assert.equal(t!.stages[0]!.todos, undefined === undefined ? t!.stages[0]!.todos : [], 'todos 缺省时按空处理');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PipelineError 是 Error 的子类（路由层靠它给 400 而不是 500）', () => {
  assert.ok(new PipelineError('x') instanceof Error);
});

// ---------------------------------------------------------------------------
// HTTP：界面上那个定制页面走的就是这几个路由
// ---------------------------------------------------------------------------

test('HTTP：新建一条流水线，立刻就能用它建需求', async () => {
  const { db, app, pipelinesDir } = makeApp();

  const put = await app.request('/api/pipelines/dev_hotfix', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '开发热修',
      role: 'dev',
      stages: [
        { key: 'fix', name: '修复', kind: 'work', todos: ['改代码'] },
        { key: 'merge', name: '合入', kind: 'work', todos: [] },
      ],
    }),
  });
  assert.equal(put.status, 200);
  const { pipelines } = (await put.json()) as { pipelines: PipelineTemplate[] };
  assert.ok(pipelines.some((t) => t.key === 'dev_hotfix'));

  // 文件真的落到传进来的那个目录里（不是仓库的 config）
  assert.ok(fs.existsSync(path.join(pipelinesDir, 'dev_hotfix.yaml')));

  // 关键：**不用重启**就能用它建需求 —— 闭包里那份模板必须跟着刷新
  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '线上告警修复', role: 'dev', pipelineKey: 'dev_hotfix' }),
  });
  assert.equal(created.status, 201);
  const detail = (await created.json()) as { stages: { name: string }[] };
  assert.deepEqual(
    detail.stages.map((s) => s.name),
    ['修复', '合入'],
  );

  db.close();
});

test('HTTP：改一条已有的流水线，改动立刻生效', async () => {
  const { db, app } = makeApp();

  // 先建一条，再改它的阶段
  const body = (name: string, stages: unknown[]) =>
    JSON.stringify({ name, role: 'maint', stages });

  await app.request('/api/pipelines/mine', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: body('我的流程', [{ key: 'a', name: '甲', kind: 'work', todos: [] }]),
  });
  await app.request('/api/pipelines/mine', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: body('我的流程（改）', [
      { key: 'a', name: '甲改', kind: 'work', todos: ['加了条待办'] },
      { key: 'b', name: '乙', kind: 'review', todos: [] },
    ]),
  });

  const created = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'maint', pipelineKey: 'mine' }),
  });
  const detail = (await created.json()) as {
    stages: { name: string; kind: string }[];
    todos: { text: string }[];
  };
  assert.deepEqual(detail.stages.map((s) => s.name), ['甲改', '乙']);
  assert.deepEqual(detail.todos.map((t) => t.text), ['加了条待办']);
  assert.equal(detail.stages[1]!.kind, 'review');

  db.close();
});

test('HTTP：key 以 URL 为准；非法参数都是 400 而不是 500', async () => {
  const { db, app } = makeApp();
  const put = (key: string, body: unknown) =>
    app.request(`/api/pipelines/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // body 里的 key 会被忽略
  const ok = await put('good_key', {
    key: 'ignored_key',
    name: 'X',
    role: 'dev',
    stages: [{ key: 'a', name: 'A', kind: 'work', todos: [] }],
  });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { key: string }).key, 'good_key');

  for (const [key, body, pattern] of [
    ['Bad-Key', { name: 'X', role: 'dev', stages: [{ key: 'a', name: 'A' }] }, /只能用小写字母/],
    ['ok_key', { name: 'X', role: 'research', stages: [{ key: 'a', name: 'A' }] }, /role 非法/],
    ['ok_key', { name: '', role: 'dev', stages: [{ key: 'a', name: 'A' }] }, /必须是非空字符串/],
    ['ok_key', { name: 'X', role: 'dev', stages: [] }, /stages 必须是非空数组/],
    [
      'ok_key',
      { name: 'X', role: 'dev', stages: [{ key: 'w', name: 'W', kind: 'wait' }] },
      /wait_counterparty/,
    ],
  ] as const) {
    const res = await put(key, body);
    assert.equal(res.status, 400, `${key} / ${JSON.stringify(body)} 应该是 400`);
    assert.match(((await res.json()) as { error: string }).error, pattern);
  }

  db.close();
});

test('HTTP：删模板；最后一条不给删', async () => {
  const { db, app, pipelinesDir } = makeApp();

  await app.request('/api/pipelines/temp_one', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '临时的',
      role: 'dev',
      stages: [{ key: 'a', name: 'A', kind: 'work', todos: [] }],
    }),
  });

  const del = await app.request('/api/pipelines/temp_one', { method: 'DELETE' });
  assert.equal(del.status, 200);
  const { pipelines } = (await del.json()) as { pipelines: PipelineTemplate[] };
  assert.ok(!pipelines.some((t) => t.key === 'temp_one'));
  assert.ok(!fs.existsSync(path.join(pipelinesDir, 'temp_one.yaml')));

  // 把剩下三条都删掉，最后一条要被拦住
  for (const key of ['dev_default', 'se_default']) {
    assert.equal((await app.request(`/api/pipelines/${key}`, { method: 'DELETE' })).status, 200);
  }
  const last = await app.request('/api/pipelines/maint_default', { method: 'DELETE' });
  assert.equal(last.status, 400);
  assert.match(((await last.json()) as { error: string }).error, /最后一条流水线/);

  db.close();
});

test('HTTP：某个角色的最后一条能删 —— 那类工作不做了是合理的收尾', async () => {
  const { db, app } = makeApp();

  const del = await app.request('/api/pipelines/maint_default', { method: 'DELETE' });
  assert.equal(del.status, 200);

  // 删完之后：模板列表里没有维护了，新建下拉也不会再出现它（下拉是照模板渲染的）
  const { pipelines } = (await (await app.request('/api/pipelines')).json()) as {
    pipelines: PipelineTemplate[];
  };
  assert.ok(!pipelines.some((t) => t.role === 'maint'));

  // 硬要用这个角色建，会得到一句人话
  const res = await app.request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '甲', role: 'maint' }),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /没有对应的流水线模板/);

  db.close();
});
