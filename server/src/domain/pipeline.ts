import fs from 'node:fs';
import path from 'node:path';
import { Document, YAMLSeq, parse as parseYaml, parseDocument, stringify } from 'yaml';
import type { PipelineStageDef, PipelineTemplate, Role, StageKind } from '@manager/shared';
import { PIPELINES_DIR } from '../config.ts';

const VALID_ROLES: readonly Role[] = ['se', 'dev', 'maint'];
const VALID_KINDS: readonly StageKind[] = ['work', 'review', 'wait', 'milestone'];

export class PipelineError extends Error {}

function needString(v: unknown, what: string, file: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new PipelineError(`${file}: ${what} 必须是非空字符串`);
  }
  return v;
}

function validateStage(raw: unknown, file: string, index: number): PipelineStageDef {
  if (typeof raw !== 'object' || raw === null) {
    throw new PipelineError(`${file}: stages[${index}] 必须是对象`);
  }
  const s = raw as Record<string, unknown>;
  const key = needString(s['key'], `stages[${index}].key`, file);
  const name = needString(s['name'], `stages[${index}].name`, file);
  const kind = (s['kind'] ?? 'work') as StageKind;
  if (!VALID_KINDS.includes(kind)) {
    throw new PipelineError(`${file}: stages[${index}].kind 非法（${String(kind)}），可选 ${VALID_KINDS.join(' / ')}`);
  }

  const todosRaw = s['todos'];
  let todos: string[] = [];
  if (todosRaw !== undefined && todosRaw !== null) {
    if (!Array.isArray(todosRaw)) throw new PipelineError(`${file}: stages[${index}].todos 必须是数组`);
    todos = todosRaw.map((t, ti) => needString(t, `stages[${index}].todos[${ti}]`, file));
  }

  const out: PipelineStageDef = { key, name, kind, todos };

  if (kind === 'wait') {
    // 没有这两个字段，进入该阶段时自动建不出阻塞单（D6），所以是硬性要求
    out.wait_counterparty = needString(
      s['wait_counterparty'],
      `stages[${index}].wait_counterparty（kind=wait 时必填：在等谁）`,
      file,
    );
    out.wait_for = needString(
      s['wait_for'],
      `stages[${index}].wait_for（kind=wait 时必填：等什么）`,
      file,
    );
  } else {
    if (s['wait_counterparty'] !== undefined) out.wait_counterparty = String(s['wait_counterparty']);
    if (s['wait_for'] !== undefined) out.wait_for = String(s['wait_for']);
  }

  return out;
}

export function validateTemplate(raw: unknown, file: string): PipelineTemplate {
  if (typeof raw !== 'object' || raw === null) {
    throw new PipelineError(`${file}: 顶层必须是对象`);
  }
  const t = raw as Record<string, unknown>;
  const key = needString(t['key'], 'key', file);
  const name = needString(t['name'], 'name', file);
  const role = t['role'] as Role;
  if (!VALID_ROLES.includes(role)) {
    throw new PipelineError(`${file}: role 非法（${String(role)}），可选 ${VALID_ROLES.join(' / ')}`);
  }

  const stagesRaw = t['stages'];
  if (!Array.isArray(stagesRaw) || stagesRaw.length === 0) {
    throw new PipelineError(`${file}: stages 必须是非空数组`);
  }
  const stages = stagesRaw.map((s, i) => validateStage(s, file, i));

  const seen = new Set<string>();
  for (const s of stages) {
    if (seen.has(s.key)) throw new PipelineError(`${file}: 阶段 key 重复 —— ${s.key}`);
    seen.add(s.key);
  }

  return { key, name, role, stages };
}

/** 从 config/pipelines/*.yaml 读取全部模板。文件系统是模板的真相源。 */
export function loadPipelines(dir: string = PIPELINES_DIR): PipelineTemplate[] {
  if (!fs.existsSync(dir)) {
    throw new PipelineError(`流水线模板目录不存在: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const templates: PipelineTemplate[] = [];
  const keys = new Set<string>();

  for (const file of files) {
    const full = path.join(dir, file);
    const parsed: unknown = parseYaml(fs.readFileSync(full, 'utf8'));
    const template = validateTemplate(parsed, file);
    if (keys.has(template.key)) {
      throw new PipelineError(`流水线 key 重复: ${template.key}（来自 ${file}）`);
    }
    keys.add(template.key);
    templates.push(template);
  }

  if (templates.length === 0) {
    throw new PipelineError(`流水线模板目录里没有 .yaml 文件: ${dir}`);
  }
  return templates;
}

/**
 * 选定模板：显式 key 优先，否则取该角色的第一个模板。
 */
export function resolvePipeline(
  templates: PipelineTemplate[],
  role: Role,
  key?: string | null,
): PipelineTemplate {
  if (key) {
    const byKey = templates.find((t) => t.key === key);
    if (!byKey) throw new PipelineError(`找不到流水线模板: ${key}`);
    return byKey;
  }
  const byRole = templates.find((t) => t.role === role);
  if (!byRole) {
    throw new PipelineError(
      `角色 ${role} 没有对应的流水线模板。已有模板: ${templates.map((t) => `${t.key}(${t.role})`).join(', ')}`,
    );
  }
  return byRole;
}

// ---------------------------------------------------------------------------
// 写回文件（驾驶舱里的「流水线定制」页面用）
//
// 模板的真相源始终是 `config/pipelines/*.yaml` —— 界面只是它的一个编辑器，
// 不是另一份存储。所以这儿只做「把这份对象写回那个文件」，不碰数据库。
// ---------------------------------------------------------------------------

/** 界面上能选的角色。角色目前还是代码侧的枚举（见 docs/design.md §5.0 的限制说明）。 */
export const PIPELINE_ROLES: readonly Role[] = VALID_ROLES;

/**
 * key 会变成文件名，所以必须是安全的 slug。
 *
 * 中文名放 `name` 里 —— 那个是给人看的；key 是给文件名和事件 payload 用的，
 * 它还得能出现在命令行里。两者混起来（拿中文当文件名）以后会很难受。
 */
export function assertTemplateKey(key: string): string {
  const clean = key.trim();
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(clean)) {
    throw new PipelineError(
      `流水线 key 只能用小写字母、数字、下划线，字母开头、2–40 位（收到 ${JSON.stringify(key)}）。` +
        `「${key}」如果是个名字，请写进「名称」里`,
    );
  }
  return clean;
}

export function pipelineFilePath(dir: string, key: string): string {
  return path.join(dir, `${assertTemplateKey(key)}.yaml`);
}

/** 新建的文件自带一段说明 —— 保住注释的前提是先有注释 */
const NEW_FILE_HEADER = `# 这条流水线是在界面上建的（驾驶舱 → 流水线定制）。
#
# 这个文件是真相源：直接改它也生效。界面写回时会尽量保住注释，
# 但挂在**被删掉的阶段**上的注释会跟着走，这是没办法的。
`;

/** 先写临时文件再改名：中途失败不会留下半截 YAML（那会让整个服务起不来） */
function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
}

/**
 * 取出某个路径上的**序列节点**。
 *
 * 注意：yaml 库的 `doc.get('stages')` 返回的是 `YAMLSeq` 节点，不是 JS 数组 ——
 * `Array.isArray()` 对它永远是 false。想拿长度必须走 `.items`。
 * （第一版就是栽在这儿：长度永远是 0，于是「就地改」变成了一路往后追加。）
 */
function seqAt(doc: Document, at: (string | number)[]): YAMLSeq | undefined {
  const node = doc.getIn(at, true);
  return node instanceof YAMLSeq ? node : undefined;
}

/**
 * 就地改一组待办。
 *
 * 按索引改**已有的节点**，而不是整个数组换掉 —— 换掉的话 yaml 库会把注释
 * 连同旧节点一起丢掉。
 */
function writeTodos(doc: Document, at: (string | number)[], todos: string[]): void {
  const seq = seqAt(doc, at);
  if (!seq) {
    // 这个阶段原本没有 todos。新建节点，没有注释要保
    if (todos.length > 0) doc.setIn(at, doc.createNode(todos));
    return;
  }

  const oldLen = seq.items.length;
  for (let i = 0; i < todos.length; i++) {
    const text = todos[i]!;
    if (i < oldLen) doc.setIn([...at, i], text);
    else seq.add(doc.createNode(text));
  }
  // 从后往前删，免得索引错位
  for (let i = oldLen - 1; i >= todos.length; i--) doc.deleteIn([...at, i]);

  if (todos.length === 0) doc.deleteIn(at);
}

/** 就地改阶段列表。同上：保住挂在存活阶段上的注释。 */
function writeStages(doc: Document, stages: PipelineStageDef[]): void {
  const seq = seqAt(doc, ['stages']);
  if (!seq) {
    // 新文件：没有注释要保，整段设进去。
    // 注意别用 addIn —— 路径不存在时它会把对象合并成 map，而不是建数组
    doc.setIn(['stages'], doc.createNode(stages));
    return;
  }

  const oldLen = seq.items.length;
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!;
    if (i < oldLen) {
      doc.setIn(['stages', i, 'key'], s.key);
      doc.setIn(['stages', i, 'name'], s.name);
      doc.setIn(['stages', i, 'kind'], s.kind);
      writeTodos(doc, ['stages', i, 'todos'], s.todos ?? []);
      if (s.kind === 'wait') {
        doc.setIn(['stages', i, 'wait_counterparty'], s.wait_counterparty ?? '');
        doc.setIn(['stages', i, 'wait_for'], s.wait_for ?? '');
      } else {
        // 不是等待阶段就别留着这两个字段，下次读会当成脏数据
        doc.deleteIn(['stages', i, 'wait_counterparty']);
        doc.deleteIn(['stages', i, 'wait_for']);
      }
    } else {
      seq.add(doc.createNode(s));
    }
  }
  for (let i = oldLen - 1; i >= stages.length; i--) doc.deleteIn(['stages', i]);
}

/**
 * 按 key 找到它**真正所在的文件**。
 *
 * key 和文件名**不一定一致**：新建的模板按 `<key>.yaml` 命名，但手写的文件可以叫任何名字
 * （仓库里的 `maint.yaml` 装的就是 key 为 `maint_default` 的模板）。
 *
 * 这个区别不是学究：按 key 拼文件名的话，编辑 `maint.yaml` 会**另建**一个
 * `maint_default.yaml`，于是同一个 key 出现两次 —— `loadPipelines` 直接抛
 * 「key 重复」，服务起不来。删除也会报「文件不存在」。
 */
export function findTemplateFile(dir: string, key: string): string | null {
  if (!fs.existsSync(dir)) return null;

  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
    const full = path.join(dir, name);
    try {
      const parsed: unknown = parseYaml(fs.readFileSync(full, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>)['key'] === key) {
        return full;
      }
    } catch {
      // 解析不了的文件跳过（可能是别人正在写的半截文件），不该拖累查找
    }
  }
  return null;
}

/**
 * 把一份模板写回去。
 *
 * 已经存在的文件走 `parseDocument`，**注释能保住**；新文件按 `<key>.yaml` 建，带一段说明头。
 * 存之前用和读的时候同一套规则验一遍 —— 界面能存进去、服务却读不出来是最糟的。
 */
export function saveTemplate(dir: string, template: PipelineTemplate): void {
  assertTemplateKey(template.key);
  validateTemplate(template, `${template.key}.yaml`); // 存进去的必须读得出来

  const existing = findTemplateFile(dir, template.key);
  const file = existing ?? pipelineFilePath(dir, template.key);
  const doc = existing
    ? parseDocument(fs.readFileSync(existing, 'utf8'))
    : new Document({ key: template.key });

  doc.setIn(['key'], template.key);
  doc.setIn(['name'], template.name);
  doc.setIn(['role'], template.role);
  writeStages(doc, template.stages);

  writeFileAtomic(file, (existing ? '' : NEW_FILE_HEADER) + stringify(doc, { lineWidth: 0 }));
}

/** 删掉一个模板文件。目录里至少得留一条 —— 全删光服务就起不来了。 */
export function deleteTemplate(dir: string, key: string): void {
  const file = findTemplateFile(dir, key);
  if (!file) throw new PipelineError(`找不到流水线模板文件: ${key}`);

  const rest = loadPipelines(dir).filter((t) => t.key !== key);
  if (rest.length === 0) {
    throw new PipelineError('这是最后一条流水线，删掉就没得选了 —— 至少留一条');
  }

  fs.rmSync(file);
}

