import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { listTimeline } from '../src/domain/events.ts';
import { createItem, getItem, listItems } from '../src/domain/items.ts';
import { listTodos } from '../src/domain/stages.ts';
import { executePalette, longestCommonPrefix, parsePalette, queryPalette } from '../src/domain/palette.ts';
import { shiftDays, todayIso } from '../src/domain/dates.ts';
import { advanceUntil, completeStageTodos, freshDb } from './helpers.ts';

const TEMPLATES = loadPipelines();

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

test('解析：# 是需求，@ 永远是阶段，key:value 是修饰符', () => {
  const p = parsePalette('/todo 写接口文档 #REQ-1 @开发 due:3d');
  assert.equal(p.mode, 'command');
  assert.equal(p.command, 'todo');
  assert.equal(p.itemRef, 'REQ-1');
  assert.equal(p.stageRef, '开发');
  assert.equal(p.modifiers['due'], '3d');
  assert.equal(p.text, '写接口文档');
});

test('修饰符带空格时用引号包起来', () => {
  const p = parsePalette('/block #REQ-1 to:"隔壁模块 张三" need:接口定义');
  assert.equal(p.modifiers['to'], '隔壁模块 张三');
  assert.equal(p.modifiers['need'], '接口定义');
});

test('不认识或该命令不支持的 key:value 会退回成普通文本，不会吃掉正文', () => {
  // /log 不接受任何修饰符，所以正文里的冒号不会被误吃
  const p1 = parsePalette('/log 修复 bug:空指针');
  assert.equal(p1.text, '修复 bug:空指针');
  assert.deepEqual(p1.modifiers, {});

  // /todo 只认 due，别的 key 一样退回文本
  const p2 = parsePalette('/todo 排查 note:临时记录');
  assert.equal(p2.text, '排查 note:临时记录');
});

test('以 > 开头是精确跳转模式', () => {
  const p = parsePalette('>REQ-12');
  assert.equal(p.mode, 'search');
  assert.equal(p.exact, true);
  assert.equal(p.raw, '>REQ-12');
});

// ---------------------------------------------------------------------------
// 补全与跳转
// ---------------------------------------------------------------------------

test('命令名没敲完时给补全候选，而不是报错', () => {
  const db = freshDb();
  const r = queryPalette(db, '/to');
  assert.equal(r.mode, 'command');
  assert.equal(r.error, undefined);
  assert.deepEqual(
    r.candidates.map((c) => c.command),
    ['todo'],
  );

  const all = queryPalette(db, '/');
  assert.ok(all.candidates.length >= 8, '/ 应列出全部命令');
  db.close();
});

test('搜索需求并跳转', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '接口鉴权改造', role: 'dev' });
  createItem(db, TEMPLATES, { title: '计费重构', role: 'dev' });

  const r = queryPalette(db, '鉴权');
  const jump = r.candidates.find((c) => c.kind === 'jump');
  assert.ok(jump);
  assert.equal(jump.itemId, a.item.id);
  assert.match(jump.label, /REQ-\d+\s+接口鉴权改造/);
  assert.match(jump.detail, /开发 · 需求反串讲 · normal/);

  const nav = executePalette(db, '鉴权');
  assert.equal(nav.navigate?.kind === 'item' ? nav.navigate.itemId : null, a.item.id);

  assert.equal(queryPalette(db, '不存在的关键词').candidates.filter((c) => c.kind === 'jump').length, 0);
  db.close();
});

test('面板搜不到时垫一条「在全文里搜」', () => {
  const db = freshDb();
  createItem(db, TEMPLATES, { title: '接口鉴权改造', role: 'dev' });

  // 面板只搜编号/标题/说明；正文里的东西（备注、待办）得走全文检索
  const r = queryPalette(db, '排期');
  assert.match(r.error!, /没有匹配「排期」的需求/);

  const fallback = r.candidates.at(-1)!;
  assert.match(fallback.label, /在全文里搜「排期」/);
  assert.equal(fallback.run, '/search 排期', '选中它直接跑全文检索，不是补全');
  assert.equal(fallback.insert, undefined, '它不是补全候选，Tab 不该动它');

  const nav = executePalette(db, '/search 测试组排期');
  assert.deepEqual(nav.navigate, { kind: 'search', q: '测试组排期' });

  assert.throws(() => executePalette(db, '/search'), /要搜什么/);
  db.close();
});

test('>编号 精确跳转，找不到就明确报错', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const hit = queryPalette(db, `>${a.item.code}`);
  assert.equal(hit.candidates.length, 1);
  assert.match(hit.candidates[0]!.label, /甲/);

  const miss = queryPalette(db, '>REQ-9999');
  assert.equal(miss.candidates.length, 0);
  assert.match(miss.error!, /找不到编号/);
  db.close();
});

test('命令预览和执行是同一件事', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const q = queryPalette(db, `/todo 写文档 #${a.item.code} @开发`);
  assert.equal(q.error, undefined);
  assert.match(q.preview!, /给 REQ-\d+ 「开发」加待办：写文档/);
  // 只是预览，不该有任何副作用（模板自带 15 条待办）
  assert.equal(listTodos(db, a.item.id).length, 15);

  const r = executePalette(db, `/todo 写文档 #${a.item.code} @开发`);
  assert.match(r.message, /已给 REQ-\d+ 「开发」加待办：写文档/);
  assert.equal(listTodos(db, a.item.id).length, 16);
  db.close();
});

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

test('/log 写一条 note 事件', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  executePalette(db, `/log 与架构师对齐了鉴权协议 #${a.item.code}`);

  const events = listTimeline(db, a.item.id);
  const note = events.find((e) => e.type === 'note')!;
  assert.equal(note.note, '与架构师对齐了鉴权协议');
  db.close();
});

test('/todo 不给 #REQ 时用界面当前打开的需求', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const r = executePalette(db, '/todo 补单元测试', { currentItemId: a.item.id });
  assert.equal(r.itemId, a.item.id);
  assert.ok(listTodos(db, a.item.id).some((t) => t.text === '补单元测试'));

  assert.throws(() => executePalette(db, '/todo 没有上下文'), /没指明是哪个需求/);
  db.close();
});

test('/bump 推进阶段；待办没勾完时要 force 加 reason', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const s1 = a.stages[0]!;
  completeStageTodos(db, s1.id);

  const r = executePalette(db, `/bump #${a.item.code}`);
  assert.match(r.message, /需求反串讲 → 开发/);
  assert.equal(getItem(db, a.item.id)!.item.active_stage_id, a.stages[1]!.id);

  // 第二阶段的待办没勾：预览就要提前警告，而不是等按下回车才报错
  const q = queryPalette(db, `/bump #${a.item.code}`);
  assert.equal(q.error, undefined);
  assert.match(q.preview!, /3 项待办未完成/);
  assert.match(q.preview!, /执行会被拒绝/);
  assert.throws(() => executePalette(db, `/bump #${a.item.code}`), /还不能推进/);

  // 带 force 的预览改成另一种说法
  const qf = queryPalette(db, `/bump #${a.item.code} force:true reason:"急着上线"`);
  assert.match(qf.preview!, /已 force/);

  const forced = executePalette(db, `/bump #${a.item.code} force:true reason:"急着上线"`);
  assert.match(forced.message, /开发 → DT/);

  const exit = listTimeline(db, a.item.id).filter((e) => e.type === 'stage_exit').at(-1)!;
  assert.equal(JSON.parse(exit.payload!).forced, true);
  db.close();
});

test('/bump outcome:skipped 必须带 reason', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  completeStageTodos(db, a.stages[0]!.id);

  const bad = queryPalette(db, `/bump #${a.item.code} outcome:skipped`);
  assert.match(bad.error!, /跳过阶段必须写原因/);

  executePalette(db, `/bump #${a.item.code} outcome:skipped reason:"需求已取消"`);
  const s1 = getItem(db, a.item.id)!.stages[0]!;
  assert.equal(s1.outcome, 'skipped');
  assert.equal(s1.skip_reason, '需求已取消');
  db.close();
});

test('/ddl 不带 @ 改需求整体 DDL，带 @ 改阶段 DDL', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  const today = todayIso();

  executePalette(db, `/ddl #${a.item.code} 2026-03-05`);
  assert.equal(getItem(db, a.item.id)!.item.due_at, '2026-03-05');

  executePalette(db, `/ddl #${a.item.code} @开发 3d`);
  const coding = getItem(db, a.item.id)!.stages.find((s) => s.key === 'coding')!;
  assert.equal(coding.planned_end, shiftDays(today, 3));

  // 日期表达式写错要报清楚
  assert.match(queryPalette(db, `/ddl #${a.item.code} 下个月`).error!, /看不懂的日期/);

  const changes = listTimeline(db, a.item.id).filter((e) => e.type === 'ddl_change');
  assert.equal(changes.length, 2);
  assert.equal(JSON.parse(changes[0]!.payload!).scope, 'item');
  assert.equal(JSON.parse(changes[1]!.payload!).scope, 'stage');
  db.close();
});

test('/block 建阻塞并让需求变成阻塞态；/unblock 解除', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const r = executePalette(
    db,
    `/block #${a.item.code} to:"隔壁模块" need:"接口定义冻结" sev:high promise:3d`,
  );
  assert.match(r.message, /我被阻塞 —— 隔壁模块：接口定义冻结/);

  const detail = getItem(db, a.item.id)!;
  assert.equal(detail.item.condition, 'blocked');
  const blocker = detail.blockers[0]!;
  assert.equal(blocker.counterparty, '隔壁模块');
  assert.equal(blocker.need, '接口定义冻结');
  assert.equal(blocker.severity, 'high');
  assert.equal(blocker.promised_at, shiftDays(todayIso(), 3));

  executePalette(db, `/unblock ${blocker.id} 对方已给出接口`);
  assert.equal(getItem(db, a.item.id)!.item.condition, 'normal');
  assert.equal(getItem(db, a.item.id)!.blockers[0]!.resolution, '对方已给出接口');
  db.close();
});

test('/block dir:blocking 记「我阻塞别人」，需求状况不受影响', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  executePalette(db, `/block #${a.item.code} to:网关模块 need:接口定义 dir:blocking`);

  const detail = getItem(db, a.item.id)!;
  assert.equal(detail.blockers[0]!.direction, 'blocking_others');
  assert.equal(detail.item.condition, 'normal', '别人在等我，不是我动不了');

  assert.match(
    queryPalette(db, `/block #${a.item.code} to:x need:y dir:乱写`).error!,
    /dir 只能是/,
  );
  db.close();
});

test('/suspend 与 /resume：不带 @ 挂整个需求，带 @ 挂某个阶段', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  executePalette(db, `/suspend #${a.item.code} 人力被抽走`);
  assert.equal(getItem(db, a.item.id)!.item.condition, 'suspended');

  executePalette(db, `/resume #${a.item.code}`);
  assert.equal(getItem(db, a.item.id)!.item.condition, 'normal');

  executePalette(db, `/suspend #${a.item.code} @需求反串讲 等对方给材料`);
  const detail = getItem(db, a.item.id)!;
  assert.equal(detail.item.suspended_at, null, '需求本身没挂');
  assert.equal(detail.stages[0]!.suspended_at !== null, true, '挂的是阶段');
  assert.equal(detail.item.condition, 'suspended', '阶段挂起同样投影成挂起');
  db.close();
});

test('/close 必须说清是完成还是取消', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const bad = queryPalette(db, `/close #${a.item.code}`);
  assert.match(bad.error!, /必须说明是完成还是取消/);

  executePalette(db, `/close #${a.item.code} cancelled`);
  const detail = getItem(db, a.item.id)!;
  assert.equal(detail.item.close_reason, 'cancelled');
  assert.equal(detail.item.condition, 'closed');
  assert.equal(listItems(db).length, 0, '关闭后默认不出现在列表里');
  db.close();
});

test('/help 列出全部命令；敲错命令给出明确提示', () => {
  const db = freshDb();
  const help = executePalette(db, '/help');
  assert.match(help.message, /\/todo/);
  assert.match(help.message, /\/bump/);

  // /report 现在真的会生成草稿
  const report = queryPalette(db, '/report');
  assert.equal(report.error, undefined);
  assert.match(report.preview!, /生成汇报草稿/);

  assert.match(queryPalette(db, '/nonsense').error!, /没有 \/nonsense 这个命令/);
  db.close();
});

test('定位不到需求或阶段时报人话，而不是抛栈', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  assert.match(queryPalette(db, '/todo 写文档 #REQ-9999').error!, /找不到需求/);
  assert.match(queryPalette(db, `/bump #${a.item.code} @不存在的阶段`).error!, /没有叫「不存在的阶段」的阶段/);
  assert.match(queryPalette(db, '/todo 写文档 #').error!, /「#」后面没写需求编号/);
  db.close();
});

test('模糊匹配到多个需求时给候选，而不是骂人', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '接口鉴权改造', role: 'dev' });
  createItem(db, TEMPLATES, { title: '接口限流改造', role: 'dev' });

  // 这正是「输入 #REQ 却被告知请用编号指明」那个恼人场景
  const r = queryPalette(db, `/log 对齐一下 #接口`);
  assert.equal(r.error, undefined, '正在挑的时候不该报错');
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(
    r.candidates.map((c) => c.insert).sort(),
    [`#${a.item.code}`, '#REQ-2'].sort(),
  );
  assert.deepEqual(
    r.completion,
    { token: '#接口', commonPrefix: '#REQ-' },
    '公共前缀是 #REQ-，但它并不以 token 开头 —— 客户端只有在能真正延长时才应用它',
  );

  db.close();
});

test('推进到没有下一个阶段时提示已是最后一个', () => {
  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  advanceUntil(db, a.item.id, 'merge');
  completeStageTodos(db, getItem(db, a.item.id)!.item.active_stage_id!);

  const r = executePalette(db, `/bump #${a.item.code}`);
  assert.match(r.message, /（已是最后一个阶段）/);
  assert.equal(getItem(db, a.item.id)!.item.active_stage_id, null);
  db.close();
});

test('命令执行全部经过事件写入，时间线可完整复盘', () => {  const db = freshDb();
  const a = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  executePalette(db, `/log 开始看代码 #${a.item.code}`);
  executePalette(db, `/todo 补设计文档 #${a.item.code}`);
  executePalette(db, `/ddl #${a.item.code} 3d`);
  executePalette(db, `/block #${a.item.code} to:张三 need:环境`);
  executePalette(db, `/suspend #${a.item.code} 等环境`);

  const types = listTimeline(db, a.item.id).map((e) => e.type);
  assert.deepEqual(types, [
    'item_created',
    'stage_enter',
    'note',
    'todo_added',
    'ddl_change',
    'blocker_open',
    'suspend',
  ]);
  db.close();
});

// ---------------------------------------------------------------------------
// Tab 补全
// ---------------------------------------------------------------------------

test('补全：命令名', () => {
  const db = freshDb();

  const partial = queryPalette(db, '/to');
  assert.deepEqual(
    partial.candidates.map((c) => c.insert),
    ['/todo '],
    '命令补全带尾随空格，好接着敲参数',
  );
  assert.deepEqual(partial.completion, { token: '/to', commonPrefix: '/todo ' });

  const multi = queryPalette(db, '/re');
  assert.deepEqual(multi.candidates.map((c) => c.insert), ['/resume ', '/report ']);
  assert.deepEqual(multi.completion, { token: '/re', commonPrefix: '/re' }, '公共前缀就是原样，没得补');

  const slash = queryPalette(db, '/');
  assert.ok(slash.candidates.length >= 8);
  assert.equal(slash.completion!.commonPrefix, '/', '全都是 / 开头，公共前缀只有 /');

  assert.equal(queryPalette(db, '/todo ').completion, undefined, '敲完命令加了空格就没什么可补的');
  db.close();
});

test('补全：需求编号 —— 补到第一个不一样的字符', () => {
  const db = freshDb();
  createItem(db, TEMPLATES, { title: '甲', role: 'dev' });
  createItem(db, TEMPLATES, { title: '乙', role: 'dev' });
  createItem(db, TEMPLATES, { title: '丙', role: 'dev' });

  const r = queryPalette(db, '/todo 增加内容 #REQ');
  assert.equal(r.error, undefined, '正在挑的时候不报错');
  assert.deepEqual(r.candidates.map((c) => c.insert), ['#REQ-1', '#REQ-2', '#REQ-3']);
  assert.deepEqual(
    r.completion,
    { token: '#REQ', commonPrefix: '#REQ-' },
    '公共前缀是 #REQ- —— 补到第一个不一样的地方',
  );

  // 唯一的候选可以一次补完
  const one = queryPalette(db, '/todo 增加内容 #REQ-2');
  assert.deepEqual(one.candidates.map((c) => c.insert), ['#REQ-2']);
  assert.deepEqual(one.completion, { token: '#REQ-2', commonPrefix: '#REQ-2' });

  assert.equal(queryPalette(db, '/todo 写文档 #').completion, undefined, '只敲了个 # 没有可补的');
  db.close();
});

test('补全：阶段名要能定位到需求', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const noTarget = queryPalette(db, '/bump @开');
  assert.equal(noTarget.completion, undefined, '不知道是哪个需求，不能瞎补阶段');

  const byRef = queryPalette(db, `/bump #${item.item.code} @开`);
  assert.deepEqual(byRef.candidates.map((c) => c.insert), ['@开发']);

  const byContext = queryPalette(db, '/bump @D', { currentItemId: item.item.id });
  assert.deepEqual(byContext.candidates.map((c) => c.insert), ['@DT', '@DTS 解单']);

  const all = queryPalette(db, `/suspend #${item.item.code} @`);
  assert.equal(all.candidates.length, 7, '只敲了 @ 就把全部阶段列出来 —— 这比报错有用');
  assert.equal(all.error, undefined);
  db.close();
});

test('补全：枚举修饰符', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const dir = queryPalette(db, `/block #${item.item.code} to:x need:y dir:`);
  assert.deepEqual(dir.candidates.map((c) => c.insert), ['dir:blocked', 'dir:blocking']);

  const sev = queryPalette(db, `/block #${item.item.code} to:x need:y sev:h`);
  assert.deepEqual(sev.candidates.map((c) => c.insert), ['sev:high']);

  // 不认识的 key 不猜
  assert.equal(queryPalette(db, '/todo x due:3').completion, undefined, '日期没法补，也不该猜');
  db.close();
});

test('补全：这一段已经确定了才报命令的错，正在挑候选时不报', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  // 唯一候选 → 放行到规划，把「别处缺东西」如实说出来。
  // 注意 `/close` 单独敲出来时，第一个缺的是「哪个需求」—— 那才是该报的错。
  const noItem = queryPalette(db, '/close');
  assert.deepEqual(noItem.candidates.map((c) => c.insert), ['/close ']);
  assert.match(noItem.error!, /没指明是哪个需求/);

  const close = queryPalette(db, `/close #${item.item.code}`);
  assert.match(close.error!, /必须说明是完成还是取消/);

  const skipped = queryPalette(db, `/bump #${item.item.code} outcome:skipped`);
  assert.deepEqual(skipped.candidates.map((c) => c.insert), ['outcome:skipped']);
  assert.match(skipped.error!, /跳过阶段必须写原因/);

  // 多个候选 → 别插嘴
  createItem(db, TEMPLATES, { title: '乙', role: 'dev' });
  const ambiguous = queryPalette(db, '/log 对齐 #REQ');
  assert.equal(ambiguous.error, undefined);
  assert.ok(ambiguous.candidates.length > 1);
  db.close();
});

test('补全：唯一候选且能规划时，预览照常给出（预览即承诺）', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, { title: '甲', role: 'dev' });

  const r = queryPalette(db, `/bump #${item.item.code}`);
  assert.equal(r.candidates.length, 1);
  assert.match(r.preview!, /执行会被拒绝/);

  db.close();
});

test('longestCommonPrefix 的边界', () => {
  assert.equal(longestCommonPrefix([]), '');
  assert.equal(longestCommonPrefix(['#REQ-1']), '#REQ-1');
  assert.equal(longestCommonPrefix(['#REQ-1', '#REQ-2']), '#REQ-');
  assert.equal(longestCommonPrefix(['abc', 'abd']), 'ab');
  assert.equal(longestCommonPrefix(['abc', 'xyz']), '');
  assert.equal(longestCommonPrefix(['', 'abc']), '');
});

test('搜索模式下跳到某条时，insert 是精确引用', () => {
  const db = freshDb();
  const item = createItem(db, TEMPLATES, { title: '接口鉴权改造', role: 'dev' });

  const r = queryPalette(db, '鉴权');
  const jump = r.candidates.find((c) => c.kind === 'jump')!;
  assert.equal(jump.insert, `#${item.item.code}`);
  assert.equal(r.completion, undefined, '纯搜索没有「正在补的那一段」，Tab 会整体替换');

  db.close();
});
