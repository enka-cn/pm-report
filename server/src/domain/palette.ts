import type {
  BlockerDirection,
  BlockerSeverity,
  CloseReason,
  ItemViewRow,
  PaletteCandidate,
  PaletteExecuteResult,
  PaletteQueryResult,
  StageOutcome,
  StageRow,
} from '@manager/shared';
import { all, one, type Db } from '../db/index.ts';
import {
  activeStage,
  addTodo,
  advanceStage,
  closeBlocker,
  listStages,
  openBlocker,
  resumeStage,
  setStageSchedule,
  stageAdvanceBlockers,
  suspendStage,
} from './stages.ts';
import { closeItem, noteItem, resumeItem, setItemDueDate, suspendItem } from './items.ts';
import { parseDateExpr } from './dates.ts';
import { generateReport } from './reports.ts';
import { ROLE_LABELS, DIRECTION_LABELS } from './labels.ts';

/**
 * 命令面板。
 *
 * 前端面板和将来的 CLI 都调这里，**不在前端实现语法解析**（设计文档 D8）：
 * 两套实现迟早会漂移，而且所有操作必须经过服务层，否则事件日志会被绕过。
 *
 * 语法（修掉了设计文档初稿里 `@对方` 与 `@阶段` 冲突的歧义）：
 *   #xxx          -> 需求（编号或 id）
 *   @xxx          -> 阶段（key 或名字）—— @ 永远只表示阶段
 *   key:value     -> 修饰符；值含空格用双引号包起来
 *   其余          -> 位置参数
 */

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
  /** 该命令认得的修饰符；不认识的 key:value 会退回成普通文本，避免正文里的冒号被误吃 */
  modifiers: readonly string[];
  /** 是否必须能定位到一个需求 */
  needsItem: boolean;
  implemented: boolean;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'todo',
    usage: '/todo <文本> [#REQ-1] [@阶段] [due:3d|2026-03-05]',
    summary: '给需求加一条待办',
    modifiers: ['due'],
    needsItem: true,
    implemented: true,
  },
  {
    name: 'log',
    usage: '/log <文本> [#REQ-1]',
    summary: '记一条进展（写进时间线）',
    modifiers: [],
    needsItem: true,
    implemented: true,
  },
  {
    name: 'bump',
    usage: '/bump [#REQ-1] [@阶段] [outcome:skipped] [reason:原因] [force:true]',
    summary: '推进阶段',
    modifiers: ['outcome', 'reason', 'force'],
    needsItem: true,
    implemented: true,
  },
  {
    name: 'ddl',
    usage: '/ddl [#REQ-1] [@阶段] <2026-03-05|3d|today>',
    summary: '设置需求整体或某个阶段的 DDL',
    modifiers: [],
    needsItem: true,
    implemented: true,
  },
  {
    name: 'suspend',
    usage: '/suspend [#REQ-1] [@阶段] <原因>',
    summary: '挂起需求或某个阶段（不带 @阶段 就是整个需求）',
    modifiers: [],
    needsItem: true,
    implemented: true,
  },
  {
    name: 'resume',
    usage: '/resume [#REQ-1] [@阶段]',
    summary: '恢复',
    modifiers: [],
    needsItem: true,
    implemented: true,
  },
  {
    name: 'close',
    usage: '/close [#REQ-1] <done|cancelled>',
    summary: '关闭需求',
    modifiers: [],
    needsItem: true,
    implemented: true,
  },
  {
    name: 'block',
    usage: '/block [#REQ-1] to:<对方> need:<需要什么> [dir:blocked|blocking] [sev:high] [promise:3d]',
    summary: '记一条阻塞',
    modifiers: ['to', 'need', 'dir', 'sev', 'promise'],
    needsItem: true,
    implemented: true,
  },
  {
    name: 'unblock',
    usage: '/unblock <阻塞ID> [解除说明]',
    summary: '解除一条阻塞',
    modifiers: [],
    needsItem: false,
    implemented: true,
  },
  {
    name: 'help',
    usage: '/help',
    summary: '列出所有命令',
    modifiers: [],
    needsItem: false,
    implemented: true,
  },
  {
    name: 'search',
    usage: '/search <关键词>',
    summary: '在全文里搜（备注、待办、交付物、阻塞、项目说明）',
    modifiers: [],
    needsItem: false,
    implemented: true,
  },
  {
    name: 'report',
    usage: '/report',
    summary: '生成汇报草稿（接着上一次定稿到现在）',
    modifiers: [],
    needsItem: false,
    implemented: true,
  },
];

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export interface ParsedPalette {
  raw: string;
  mode: 'search' | 'command';
  /** 以 > 开头 = 按编号精确跳转 */
  exact: boolean;
  command: string | null;
  spec: CommandSpec | null;
  unknownCommand: boolean;
  positional: string[];
  /** 位置参数拼成的文本 */
  text: string;
  itemRef: string | null;
  stageRef: string | null;
  modifiers: Record<string, string>;
  /**
   * 正在输入的**最后一段**（以空白分隔）。Tab 补全就是补它。
   * 输入以空白结尾时为空串 —— 那表示「这一段敲完了」，没什么可补的。
   */
  lastToken: string;
}

/**
 * 逐字符扫描的分词器。
 *
 * 不能用 /"([^"]*)"|\S+/ 这种按 token 匹配的写法：`to:"隔壁模块 张三"` 里的引号
 * 不在 token 边界上，会被空格切成两段，引号也剥不掉 —— 于是「值含空格用引号」
 * 这条语法就是假的。这里让引号在任何位置都能开启一段引用，并吃掉空格。
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let touched = false; // 见过引号（哪怕是空串 "" 也要算一个 token）

  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      touched = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (touched || current.length > 0) {
        out.push(current);
        current = '';
        touched = false;
      }
      continue;
    }
    current += ch;
  }

  if (touched || current.length > 0) out.push(current);
  return out;
}

export function parsePalette(input: string): ParsedPalette {
  const trimmed = input.trim();
  const exact = trimmed.startsWith('>');
  const body = exact ? trimmed.slice(1).trim() : trimmed;
  const tokens = tokenize(body);

  const first = tokens[0];
  const command = first !== undefined && first.startsWith('/') ? first.slice(1).toLowerCase() : null;
  const spec = command === null ? null : (COMMANDS.find((c) => c.name === command) ?? null);
  const unknownCommand = command !== null && spec === null;
  const allowed = new Set(spec?.modifiers ?? []);

  let itemRef: string | null = null;
  let stageRef: string | null = null;
  const modifiers: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = command === null ? 0 : 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith('#')) {
      itemRef = tok.slice(1);
      continue;
    }
    if (tok.startsWith('@')) {
      stageRef = tok.slice(1);
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(tok);
    if (kv && allowed.has(kv[1]!.toLowerCase())) {
      modifiers[kv[1]!.toLowerCase()] = kv[2]!;
      continue;
    }
    positional.push(tok);
  }

  return {
    raw: trimmed,
    mode: command === null ? 'search' : 'command',
    exact,
    command,
    spec,
    unknownCommand,
    positional,
    text: positional.join(' '),
    itemRef,
    stageRef,
    modifiers,
    // 用**没 trim 过**的 input 判断末尾有没有空格：那决定「这一段是不是敲完了」。
    // 用 trimmed 的话 `/todo ` 会被当成正在敲 `/todo`，Tab 补全就会一直粘着命令名不放。
    lastToken: /\s$/.test(input) ? '' : (tokens[tokens.length - 1] ?? ''),
  };
}

// ---------------------------------------------------------------------------
// 上下文与解析目标
// ---------------------------------------------------------------------------

export interface PaletteContext {
  /** 界面当前打开的需求，供不带 #REQ 的命令使用 */
  currentItemId?: number | null;
}

function resolveItem(db: Db, ref: string | null, ctx: PaletteContext): ItemViewRow {
  if (ref === null) {
    if (ctx.currentItemId == null) {
      throw new Error('没指明是哪个需求。用 #REQ-1 指定，或先在界面上打开一个需求');
    }
    const item = one<ItemViewRow>(db, 'SELECT * FROM v_item WHERE id = ?', ctx.currentItemId);
    if (!item) throw new Error(`当前需求不存在: ${ctx.currentItemId}`);
    return item;
  }

  // 空引用必须在这里挡住：LIKE '%%' 会匹配到所有需求，然后报出
  // 「匹配到多个需求」这种让人摸不着头脑的错。
  if (!ref.trim()) throw new Error('「#」后面没写需求编号。用法：#REQ-1');

  if (/^\d+$/.test(ref)) {
    const byId = one<ItemViewRow>(db, 'SELECT * FROM v_item WHERE id = ?', Number(ref));
    if (byId) return byId;
  }

  const byCode = one<ItemViewRow>(db, 'SELECT * FROM v_item WHERE code = ? COLLATE NOCASE', ref);
  if (byCode) return byCode;

  const fuzzy = all<ItemViewRow>(
    db,
    'SELECT * FROM v_item WHERE code LIKE ? OR title LIKE ? ORDER BY id LIMIT 6',
    `%${ref}%`,
    `%${ref}%`,
  );
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) {
    throw new Error(
      `「${ref}」匹配到多个需求：${fuzzy.map((i) => `${i.code} ${i.title}`).join('、')}。请用编号指明。`,
    );
  }
  throw new Error(`找不到需求「${ref}」`);
}

function resolveStage(db: Db, itemId: number, ref: string): StageRow {
  // 同理：includes('') 恒为真，空引用会「匹配到全部阶段」
  if (!ref.trim()) throw new Error('「@」后面没写阶段名。用法：@开发');

  const stages = listStages(db, itemId);
  const lower = ref.toLowerCase();

  const exact = stages.filter((s) => s.key.toLowerCase() === lower || s.name === ref);
  if (exact.length === 1) return exact[0]!;

  const fuzzy = stages.filter((s) => s.name.includes(ref) || s.key.toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) {
    throw new Error(`阶段「${ref}」匹配到多个：${fuzzy.map((s) => s.name).join('、')}`);
  }
  throw new Error(
    `需求里没有叫「${ref}」的阶段。可选：${stages.map((s) => s.name).join('、')}`,
  );
}

/** 取命令作用的阶段：显式 @ 优先，否则当前进行中的阶段 */
function targetStage(db: Db, itemId: number, ref: string | null, required: boolean): StageRow | null {
  if (ref !== null) return resolveStage(db, itemId, ref);
  const active = activeStage(db, itemId) ?? null;
  if (required && active === null) {
    throw new Error('这个需求当前没有进行中的阶段（可能已全部结束），请用 @阶段 指明');
  }
  return active;
}

function requireText(parsed: ParsedPalette, what: string): string {
  if (!parsed.text.trim()) throw new Error(`缺少${what}。用法：${parsed.spec?.usage ?? ''}`);
  return parsed.text.trim();
}

// ---------------------------------------------------------------------------
// 计划：先算清要做什么，再描述、再执行 —— 保证「预览」和「执行」是同一件事
// ---------------------------------------------------------------------------

export type PalettePlan =
  | { kind: 'todo'; item: ItemViewRow; stage: StageRow | null; text: string; dueAt: string | null }
  | { kind: 'log'; item: ItemViewRow; text: string }
  | {
      kind: 'bump';
      item: ItemViewRow;
      stage: StageRow;
      outcome: StageOutcome;
      forced: boolean;
      reason: string | null;
      /** 会挡住推进的事项；预览要提前说出来，而不是等执行才报错 */
      pending: string[];
    }
  | { kind: 'ddl'; item: ItemViewRow; stage: StageRow | null; date: string }
  | { kind: 'suspend'; item: ItemViewRow; stage: StageRow | null; reason: string }
  | { kind: 'resume'; item: ItemViewRow; stage: StageRow | null }
  | { kind: 'close'; item: ItemViewRow; reason: CloseReason }
  | {
      kind: 'block';
      item: ItemViewRow;
      stage: StageRow | null;
      direction: BlockerDirection;
      counterparty: string;
      need: string;
      severity: BlockerSeverity;
      promisedAt: string | null;
    }
  | { kind: 'unblock'; blockerId: number; resolution: string }
  | { kind: 'search'; query: string }
  | { kind: 'report' }
  | { kind: 'help' };

const SEVERITIES: readonly BlockerSeverity[] = ['low', 'medium', 'high'];

function parseDirection(value: string | undefined): BlockerDirection {
  if (value === undefined || value === 'blocked' || value === 'in') return 'blocked_by_others';
  if (value === 'blocking' || value === 'out') return 'blocking_others';
  throw new Error(`dir 只能是 blocked（我被阻塞，默认）或 blocking（我阻塞别人），收到「${value}」`);
}

function parseSeverity(value: string | undefined): BlockerSeverity {
  if (value === undefined) return 'medium';
  if ((SEVERITIES as readonly string[]).includes(value)) return value as BlockerSeverity;
  throw new Error(`sev 只能是 ${SEVERITIES.join(' / ')}，收到「${value}」`);
}

function parseCloseReason(value: string | undefined): CloseReason {
  if (value === 'done' || value === '完成') return 'done';
  if (value === 'cancelled' || value === 'canceled' || value === '取消') return 'cancelled';
  if (value === undefined) {
    throw new Error('关闭需求必须说明是完成还是取消：/close #REQ-1 done|cancelled');
  }
  throw new Error(`关闭原因只能是 done（完成）或 cancelled（取消），收到「${value}」`);
}

export function planCommand(db: Db, parsed: ParsedPalette, ctx: PaletteContext = {}): PalettePlan {
  const spec = parsed.spec;
  if (!spec) throw new Error(`没有 /${parsed.command} 这个命令`);
  if (!spec.implemented) throw new Error(`/${spec.name} 还没实现（排在后面的迭代）`);

  const m = parsed.modifiers;
  if (spec.name === 'help') return { kind: 'help' };
  if (spec.name === 'report') return { kind: 'report' };

  if (spec.name === 'search') {
    const query = parsed.text.trim();
    if (!query) throw new Error(`要搜什么？用法：${spec.usage}`);
    return { kind: 'search', query };
  }

  if (spec.name === 'unblock') {
    const raw = parsed.positional[0];
    if (!raw || !/^\d+$/.test(raw)) throw new Error(`缺少阻塞 ID。用法：${spec.usage}`);
    return { kind: 'unblock', blockerId: Number(raw), resolution: parsed.positional.slice(1).join(' ') || '已解除' };
  }

  const item = resolveItem(db, parsed.itemRef, ctx);

  switch (spec.name) {
    case 'todo': {
      const text = requireText(parsed, '待办内容');
      const due = m['due'];
      return {
        kind: 'todo',
        item,
        stage: targetStage(db, item.id, parsed.stageRef, false),
        text,
        dueAt: due === undefined ? null : parseDateExpr(due),
      };
    }
    case 'log':
      return { kind: 'log', item, text: requireText(parsed, '要记录的内容') };

    case 'bump': {
      const outcome = (m['outcome'] ?? 'completed') as StageOutcome;
      if (outcome !== 'completed' && outcome !== 'skipped') {
        throw new Error(`outcome 只能是 completed 或 skipped，收到「${outcome}」`);
      }
      const reason = m['reason'] ?? null;
      if (outcome === 'skipped' && reason === null) throw new Error('跳过阶段必须写原因：reason:为什么跳过');
      const stage = targetStage(db, item.id, parsed.stageRef, true)!;
      return {
        kind: 'bump',
        item,
        stage,
        outcome,
        forced: m['force'] === 'true',
        reason,
        pending: stageAdvanceBlockers(db, stage.id),
      };
    }
    case 'ddl': {
      const raw = parsed.positional[0];
      if (raw === undefined) throw new Error(`缺少日期。用法：${spec.usage}`);
      const date = parseDateExpr(raw);
      return {
        kind: 'ddl',
        item,
        // 不带 @ 就是改需求整体 DDL —— 这里**不能**回退到当前阶段，
        // 否则 /ddl 永远只改阶段，需求整体 DDL 就没法用命令改了。
        stage: parsed.stageRef === null ? null : resolveStage(db, item.id, parsed.stageRef),
        date,
      };
    }
    case 'suspend':
      return {
        kind: 'suspend',
        item,
        stage: parsed.stageRef === null ? null : resolveStage(db, item.id, parsed.stageRef),
        reason: requireText(parsed, '挂起原因'),
      };
    case 'resume':
      return {
        kind: 'resume',
        item,
        stage: parsed.stageRef === null ? null : resolveStage(db, item.id, parsed.stageRef),
      };
    case 'close':
      return { kind: 'close', item, reason: parseCloseReason(parsed.positional[0]) };

    case 'block': {
      const counterparty = m['to'] ?? parsed.positional[0];
      const need = m['need'] ?? parsed.positional.slice(1).join(' ');
      if (!counterparty?.trim()) throw new Error(`缺少对方是谁：to:张三。用法：${spec.usage}`);
      if (!need?.trim()) throw new Error(`缺需要什么：need:接口定义。用法：${spec.usage}`);
      const promise = m['promise'];
      return {
        kind: 'block',
        item,
        stage: targetStage(db, item.id, parsed.stageRef, false),
        direction: parseDirection(m['dir']),
        counterparty: counterparty.trim(),
        need: need.trim(),
        severity: parseSeverity(m['sev']),
        promisedAt: promise === undefined ? null : parseDateExpr(promise),
      };
    }
    default:
      throw new Error(`没有 /${spec.name} 这个命令`);
  }
}

function stageNameOf(stage: StageRow | null): string {
  return stage ? `「${stage.name}」` : '';
}

export function describePlan(plan: PalettePlan): string {
  switch (plan.kind) {
    case 'todo':
      return `给 ${plan.item.code} ${stageNameOf(plan.stage)}加待办：${plan.text}${plan.dueAt ? `（截止 ${plan.dueAt}）` : ''}`;
    case 'log':
      return `在 ${plan.item.code} 上记一条进展：${plan.text}`;
    case 'bump': {
      const head = `推进 ${plan.item.code} 的${stageNameOf(plan.stage)}：${plan.outcome === 'skipped' ? '跳过' : '标记完成'}${plan.reason ? `（${plan.reason}）` : ''}`;
      if (plan.pending.length === 0) return head;
      if (plan.forced) return `${head}；⚠ ${plan.pending.join('；')}（已 force，会被记进事件日志）`;
      return `${head}；⚠ ${plan.pending.join('；')} —— 执行会被拒绝，要强推请加 force:true reason:...`;
    }
    case 'ddl':
      return plan.stage
        ? `把 ${plan.item.code} 的${stageNameOf(plan.stage)}截止日期设为 ${plan.date}`
        : `把 ${plan.item.code} 的整体交付 DDL 设为 ${plan.date}`;
    case 'suspend':
      return `挂起 ${plan.item.code}${plan.stage ? stageNameOf(plan.stage) + '阶段' : ''}：${plan.reason}`;
    case 'resume':
      return `恢复 ${plan.item.code}${plan.stage ? stageNameOf(plan.stage) + '阶段' : ''}`;
    case 'close':
      return `${plan.item.code} 标记为${plan.reason === 'done' ? '完成' : '取消'}`;
    case 'block':
      return `在 ${plan.item.code} 上记一条阻塞：${DIRECTION_LABELS[plan.direction]} —— ${plan.counterparty}：${plan.need}（${plan.severity}）`;
    case 'unblock':
      return `解除阻塞 #${plan.blockerId}：${plan.resolution}`;
    case 'search':
      return `在全文里搜「${plan.query}」（备注、待办、交付物、阻塞、项目说明）`;
    case 'report':
      return '生成汇报草稿（区间从上次定稿的那一刻开始）';
    case 'help':
      return '列出所有命令';
  }
}

// ---------------------------------------------------------------------------
// 查询（命令面板的候选列表）
// ---------------------------------------------------------------------------

export function helpText(): string {
  return COMMANDS.map(
    (c) => `${c.usage}${c.implemented ? '' : '（未实现）'}\n    ${c.summary}`,
  ).join('\n');
}

function itemDetail(db: Db, item: ItemViewRow): string {
  const stage = item.active_stage_id
    ? one<{ name: string }>(db, 'SELECT name FROM stage WHERE id = ?', item.active_stage_id)?.name
    : null;
  return [ROLE_LABELS[item.role], stage ?? '无进行中阶段', item.condition].join(' · ');
}

function toJumpCandidate(db: Db, item: ItemViewRow): PaletteCandidate {
  return {
    kind: 'jump',
    label: `${item.code}  ${item.title}`,
    detail: itemDetail(db, item),
    // Tab 补全时插入精确引用 —— 把「模糊搜索」变成「指名道姓」
    insert: `#${item.code}`,
    itemId: item.id,
    itemCode: item.code,
  };
}

// ---------------------------------------------------------------------------
// Tab 补全
//
// 补的是「正在输入的最后一段」。查询期间**不能急着报错** ——
// 输入 `#REQ` 时该给候选，而不是骂一句「匹配到多个需求，请用编号指明」。
// 报错留给执行阶段（回车那一刻）。
// ---------------------------------------------------------------------------

/** 只补这些枚举值的修饰符；日期、文本之类的没法补，也不该猜 */
const ENUM_MODIFIERS: Record<string, readonly string[]> = {
  dir: ['blocked', 'blocking'],
  sev: ['low', 'medium', 'high'],
  outcome: ['completed', 'skipped'],
};

export function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const value of values) {
    while (prefix !== '' && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix === '') return '';
  }
  return prefix;
}

function targetItemForCompletion(
  db: Db,
  parsed: ParsedPalette,
  ctx: PaletteContext,
): ItemViewRow | null {
  if (parsed.itemRef !== null) {
    try {
      return resolveItem(db, parsed.itemRef, { currentItemId: null });
    } catch {
      return null; // 定位不了就先别补阶段，属于正常情况
    }
  }
  if (ctx.currentItemId != null) {
    return one<ItemViewRow>(db, 'SELECT * FROM v_item WHERE id = ?', ctx.currentItemId) ?? null;
  }
  return null;
}

function completionsFor(
  db: Db,
  parsed: ParsedPalette,
  ctx: PaletteContext,
): PaletteCandidate[] | null {
  const token = parsed.lastToken;
  if (!token) return null;

  // ① 命令名
  if (token.startsWith('/')) {
    const prefix = token.slice(1).toLowerCase();
    const matches = COMMANDS.filter((c) => c.name.startsWith(prefix));
    if (matches.length === 0) return null;
    return matches.map((c) => ({
      kind: 'command' as const,
      label: `/${c.name}`,
      detail: c.summary + (c.implemented ? '' : '（未实现）'),
      // 命令补全后必定还要接参数，所以带一个尾随空格
      insert: `/${c.name} `,
      command: c.name,
    }));
  }

  // ② 需求引用：#REQ → 列出匹配到的需求，补成 #REQ-1
  if (token.startsWith('#')) {
    const q = token.slice(1).trim();
    if (!q) return null;
    const items = all<ItemViewRow>(
      db,
      `SELECT * FROM v_item
        WHERE code LIKE ? OR title LIKE ?
        ORDER BY (closed_at IS NOT NULL), (priority_override IS NULL), priority_override DESC, id
        LIMIT 12`,
      `%${q}%`,
      `%${q}%`,
    );
    if (items.length === 0) return null;
    return items.map((i) => toJumpCandidate(db, i));
  }

  // ③ 阶段引用：得先知道是哪个需求
  if (token.startsWith('@')) {
    const q = token.slice(1).trim().toLowerCase();
    const item = targetItemForCompletion(db, parsed, ctx);
    if (!item) return null;
    const stages = listStages(db, item.id).filter(
      // 名字按子串匹配（中文名一般会连着打），key 只按**前缀**匹配。
      // key 用子串的话 `@D` 会因为 `coding` 里有个 d 而匹配到「开发」，
      // 公共前缀退化成一个 `@`，Tab 就彻底没用了。
      (s) => !q || s.name.toLowerCase().includes(q) || s.key.toLowerCase().startsWith(q),
    );
    if (stages.length === 0) return null;
    return stages.map((s) => ({
      kind: 'command' as const,
      label: `@${s.name}`,
      detail: `第 ${s.seq} 阶段 · ${s.key}`,
      insert: `@${s.name}`,
    }));
  }

  // ④ 枚举修饰符：dir:/sev:/outcome:
  const kv = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(token);
  if (kv) {
    const key = kv[1]!.toLowerCase();
    const values = ENUM_MODIFIERS[key];
    if (!values) return null;
    const matched = values.filter((v) => v.startsWith(kv[2]!));
    if (matched.length === 0) return null;
    return matched.map((v) => ({
      kind: 'command' as const,
      label: `${key}:${v}`,
      detail: '',
      insert: `${key}:${v}`,
    }));
  }

  return null;
}

export function queryPalette(db: Db, input: string, ctx: PaletteContext = {}): PaletteQueryResult {
  // 注意：把**原样的输入**交给 parsePalette —— 末尾空格是有意义的信息。
  const parsed = parsePalette(input);
  const raw = parsed.raw;

  // ① 正在敲某一段 → 给补全候选。
  //    查询期间**不报错**：输入 `#REQ` 时该列出候选让你 Tab，
  //    而不是骂一句「匹配到多个需求，请用编号指明」—— 报错留给回车那一刻。
  const completions = completionsFor(db, parsed, ctx);
  if (completions) {
    const result: PaletteQueryResult = {
      mode: parsed.mode,
      candidates: completions,
      completion: {
        token: parsed.lastToken,
        commonPrefix: longestCommonPrefix(completions.map((c) => c.insert ?? '')),
      },
    };

    // 只有一个候选 = 这一段其实已经确定了，可以放行到命令规划，把真正的错误或预览照实说出来。
    //
    // 有多个候选时你正在挑，报错只会变成噪音 ——
    // 「`#REQ` 匹配到多个需求，请用编号指明」就是这种噪音：候选列表本身就回答了这个问题。
    // 但「关闭需求必须说清是完成还是取消」不能吞，它说的是**别处**缺东西，候选列表回答不了。
    //
    // 命令名本身没敲完（unknownCommand）时不规划：补全就能解决，此刻报「没有 /to 这个命令」纯属添乱。
    if (parsed.mode === 'command' && !parsed.unknownCommand && completions.length === 1) {
      try {
        result.preview = describePlan(planCommand(db, parsed, ctx));
      } catch (err) {
        result.error = (err as Error).message;
      }
    }

    return result;
  }

  if (parsed.mode === 'command') {
    if (parsed.unknownCommand) {
      return {
        mode: 'command',
        candidates: [],
        error: `没有 /${parsed.command} 这个命令`,
        help: helpText(),
      };
    }
    try {
      const plan = planCommand(db, parsed, ctx);
      return {
        mode: 'command',
        candidates: [
          {
            kind: 'command',
            label: parsed.spec!.usage,
            detail: parsed.spec!.summary,
            command: parsed.command!,
          },
        ],
        preview: describePlan(plan),
      };
    } catch (err) {
      return { mode: 'command', candidates: [], error: (err as Error).message };
    }
  }

  if (raw === '') {
    return {
      mode: 'search',
      candidates: all<ItemViewRow>(
        db,
        'SELECT * FROM v_item WHERE closed_at IS NULL ORDER BY id DESC LIMIT 12',
      ).map((i) => toJumpCandidate(db, i)),
    };
  }

  if (parsed.exact) {
    // >REQ-1：精确跳转，宁可不给候选也不猜
    const exact = one<ItemViewRow>(
      db,
      'SELECT * FROM v_item WHERE code = ? COLLATE NOCASE OR id = ? LIMIT 1',
      raw.slice(1),
      Number(raw.slice(1)) || -1,
    );
    return {
      mode: 'search',
      candidates: exact ? [toJumpCandidate(db, exact)] : [],
      error: exact ? undefined : `找不到编号为「${raw.slice(1)}」的需求`,
    };
  }

  const q = `%${raw}%`;
  const items = all<ItemViewRow>(
    db,
    `SELECT * FROM v_item
      WHERE code LIKE ? OR title LIKE ? OR IFNULL(description, '') LIKE ?
      ORDER BY (closed_at IS NOT NULL), (priority_override IS NULL), priority_override DESC, id DESC
      LIMIT 12`,
    q,
    q,
    q,
  );

  const candidates = items.map((i) => toJumpCandidate(db, i));

  // 顺便提示同名的命令，省得记住有哪些
  if (/^[a-z]+$/i.test(raw)) {
    for (const c of COMMANDS.filter((c) => c.name.startsWith(raw.toLowerCase()))) {
      candidates.push({
        kind: 'command',
        label: c.usage,
        detail: c.summary,
        insert: `/${c.name} `,
        command: c.name,
      });
    }
  }

  // 垫底一条：把当前输入直接丢给全文检索。
  // 面板本身只搜编号/标题/说明；备注、待办、交付物、阻塞里的内容得走全文检索。
  candidates.push({
    kind: 'command',
    label: `在全文里搜「${raw}」`,
    detail: '备注、待办、交付物、阻塞、项目说明',
    run: `/search ${raw}`,
  });

  return {
    mode: 'search',
    candidates,
    error:
      items.length === 0 ? `没有匹配「${raw}」的需求（按 ↓ 可以丢给全文检索）` : undefined,
  };
}
// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

export function executePalette(
  db: Db,
  input: string,
  ctx: PaletteContext = {},
): PaletteExecuteResult {
  const parsed = parsePalette(input);

  // 搜索模式下执行 = 跳转
  if (parsed.mode === 'search') {
    const result = queryPalette(db, input, ctx);
    const jump = result.candidates.find((c) => c.kind === 'jump');
    if (!jump || jump.itemId === undefined) {
      throw new Error(result.error ?? `没有匹配「${input}」的需求`);
    }
    return {
      message: `跳转到 ${jump.label}`,
      itemId: jump.itemId,
      navigate: { kind: 'item', itemId: jump.itemId },
    };
  }

  const plan = planCommand(db, parsed, ctx);

  switch (plan.kind) {
    case 'todo': {
      const todo = addTodo(db, {
        itemId: plan.item.id,
        stageId: plan.stage?.id ?? null,
        text: plan.text,
        dueAt: plan.dueAt,
      });
      return {
        message: `已给 ${plan.item.code} ${stageNameOf(plan.stage)}加待办：${plan.text}`,
        itemId: plan.item.id,
        navigate: { kind: 'item', itemId: plan.item.id, stageId: todo.stage_id },
      };
    }
    case 'log': {
      const eventId = noteItem(db, plan.item.id, plan.text);
      return {
        message: `已记录 ${plan.item.code}：${plan.text}（事件 #${eventId}）`,
        itemId: plan.item.id,
        navigate: { kind: 'item', itemId: plan.item.id },
      };
    }
    case 'bump': {
      const r = advanceStage(db, {
        itemId: plan.item.id,
        stageId: plan.stage.id,
        outcome: plan.outcome,
        skipReason: plan.outcome === 'skipped' ? (plan.reason ?? undefined) : undefined,
        forced: plan.forced,
        reason: plan.reason ?? undefined,
      });
      const to = r.toStageName ? `→ ${r.toStageName}` : '（已是最后一个阶段）';
      return {
        message: `${plan.item.code} ${r.fromStageName} ${to}${r.closedBlockerIds.length ? `，顺带解除 ${r.closedBlockerIds.length} 条阻塞` : ''}`,
        itemId: plan.item.id,
        navigate: { kind: 'item', itemId: plan.item.id },
      };
    }
    case 'ddl': {
      if (plan.stage) {
        setStageSchedule(db, plan.stage.id, { plannedEnd: plan.date });
        return {
          message: `${plan.item.code} 的${stageNameOf(plan.stage)}截止日期已设为 ${plan.date}`,
          itemId: plan.item.id,
          navigate: { kind: 'item', itemId: plan.item.id, stageId: plan.stage.id },
        };
      }
      setItemDueDate(db, plan.item.id, plan.date);
      return {
        message: `${plan.item.code} 的整体交付 DDL 已设为 ${plan.date}`,
        itemId: plan.item.id,
        navigate: { kind: 'item', itemId: plan.item.id },
      };
    }
    case 'suspend': {
      if (plan.stage) suspendStage(db, plan.stage.id, plan.reason);
      else suspendItem(db, plan.item.id, plan.reason);
      return {
        message: `已挂起 ${plan.item.code}${plan.stage ? stageNameOf(plan.stage) + '阶段' : ''}：${plan.reason}`,
        itemId: plan.item.id,
        navigate: { kind: 'item', itemId: plan.item.id },
      };
    }
    case 'resume': {
      if (plan.stage) resumeStage(db, plan.stage.id);
      else resumeItem(db, plan.item.id);
      return {
        message: `已恢复 ${plan.item.code}${plan.stage ? stageNameOf(plan.stage) + '阶段' : ''}`,
        itemId: plan.item.id,
        navigate: { kind: 'item', itemId: plan.item.id },
      };
    }
    case 'close': {
      closeItem(db, plan.item.id, { reason: plan.reason });
      return {
        message: `${plan.item.code} 已标记为${plan.reason === 'done' ? '完成' : '取消'}`,
        itemId: plan.item.id,
        navigate: { kind: 'item', itemId: plan.item.id },
      };
    }
    case 'block': {
      const blockerId = openBlocker(db, {
        itemId: plan.item.id,
        stageId: plan.stage?.id ?? null,
        direction: plan.direction,
        counterparty: plan.counterparty,
        need: plan.need,
        severity: plan.severity,
        promisedAt: plan.promisedAt,
      });
      return {
        message: `已记下阻塞 #${blockerId}：${DIRECTION_LABELS[plan.direction]} —— ${plan.counterparty}：${plan.need}`,
        itemId: plan.item.id,
        navigate: { kind: 'item', itemId: plan.item.id },
      };
    }
    case 'unblock': {
      closeBlocker(db, plan.blockerId, plan.resolution);
      return { message: `阻塞 #${plan.blockerId} 已解除`, itemId: null };
    }
    case 'search':
      return {
        message: `在全文里搜「${plan.query}」`,
        itemId: null,
        navigate: { kind: 'search', q: plan.query },
      };
    case 'report': {
      const report = generateReport(db);
      return {
        message: `汇报草稿已生成：${report.title}`,
        itemId: null,
        navigate: { kind: 'reports', reportId: report.id },
      };
    }
    case 'help':
      return { message: helpText(), itemId: null };
  }
}
