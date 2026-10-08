import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PipelineStageDef, PipelineTemplate, Role, StageKind } from '@manager/shared';
import { PIPELINES_DIR } from '../config.ts';

const VALID_ROLES: readonly Role[] = ['se', 'dev', 'test', 'maint'];
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
