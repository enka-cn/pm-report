/**
 * 极简模板渲染器：只支持 `{{变量}}`、`{{#each}}`、`{{#if}}`、`{{#unless}}`。
 *
 * 为什么自己写而不引 handlebars / mustache：
 * 汇报模板是给你手改的（`config/report_templates/*.md`），需要的能力就是
 * 「遍历列表 + 条件显示 + 插值」这三样，加起来不到一百行。
 * 引一个模板引擎得多学一套语法、跟一个版本，而这个文件的每一行你都读得懂。
 *
 * 不做 HTML 转义 —— 输出是 Markdown，转义反而会把 `&`、`<` 弄坏。
 */

export class TemplateError extends Error {}

type SectionKind = 'each' | 'if' | 'unless';

type SectionNode = {
  type: 'section';
  kind: SectionKind;
  path: string;
  children: TemplateNode[];
};

type TemplateNode =
  | { type: 'text'; value: string }
  | { type: 'var'; path: string }
  | SectionNode;

const SECTION_KINDS: readonly SectionKind[] = ['each', 'if', 'unless'];

export type TemplateContext = Record<string, unknown>;

function parse(source: string, name: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const open: SectionNode[] = [];
  let current = root;
  let i = 0;

  const pushText = (value: string): void => {
    if (value) current.push({ type: 'text', value });
  };

  while (i < source.length) {
    const start = source.indexOf('{{', i);
    if (start === -1) {
      pushText(source.slice(i));
      break;
    }

    const end = source.indexOf('}}', start + 2);
    if (end === -1) throw new TemplateError(`${name}: 有未闭合的 {{`);
    const tag = source.slice(start + 2, end).trim();
    const tagEnd = end + 2;

    // 「独占一行」的区块标签要连同它那一行的缩进和换行一起去掉。
    // 没有这条规则，每个 {{#each}} 循环都会在两项之间留下一个空行，
    // 模板就没法写得干净了：
    //     {{#each items}}\n- {{x}}\n{{/each}}
    // 必须渲染成 `- 1\n- 2`，而不是 `- 1\n\n- 2`。
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const newlineAfter = source.indexOf('\n', tagEnd);
    const beforeBlank = source.slice(lineStart, start).trim() === '';
    const afterBlank = source.slice(tagEnd, newlineAfter === -1 ? source.length : newlineAfter).trim() === '';
    const isSectionTag = tag.startsWith('#') || tag.startsWith('/');
    const standalone = isSectionTag && beforeBlank && afterBlank;

    if (standalone) {
      pushText(source.slice(i, lineStart));
      i = newlineAfter === -1 ? source.length : newlineAfter + 1;
    } else {
      pushText(source.slice(i, start));
      i = tagEnd;
    }

    if (tag === '') continue;

    if (tag.startsWith('/')) {
      const closing = tag.slice(1).trim();
      const opened = open.pop();
      if (!opened) {
        throw new TemplateError(`${name}: 多了一个 {{/${closing}}}，没有对应的开标签`);
      }
      if (opened.kind !== closing) {
        throw new TemplateError(
          `${name}: {{#${opened.kind} ${opened.path}}} 被 {{/${closing}}} 关掉了，标签不匹配`,
        );
      }
      current = open.length > 0 ? open[open.length - 1]!.children : root;
      continue;
    }

    if (tag.startsWith('#')) {
      const matched = /^#(\w+)\s+(.+)$/.exec(tag);
      if (!matched) {
        throw new TemplateError(`${name}: 看不懂 {{${tag}}}。正确写法形如 {{#each 列表名}}`);
      }
      const kind = matched[1]! as SectionKind;
      if (!SECTION_KINDS.includes(kind)) {
        throw new TemplateError(
          `${name}: 不支持 #${kind}，只支持 ${SECTION_KINDS.map((k) => `#${k}`).join(' / ')}`,
        );
      }
      const node: SectionNode = { type: 'section', kind, path: matched[2]!.trim(), children: [] };
      current.push(node);
      open.push(node);
      current = node.children;
      continue;
    }

    if (tag.startsWith('^')) {
      throw new TemplateError(
        `${name}: 请改用 {{#unless ${tag.slice(1).trim()}}}，不支持 mustache 的 {{${tag}}}`,
      );
    }

    current.push({ type: 'var', path: tag });
  }

  const unclosed = open[open.length - 1];
  if (unclosed) {
    throw new TemplateError(`${name}: {{#${unclosed.kind} ${unclosed.path}}} 没有闭合`);
  }

  return root;
}

function lookup(ctx: TemplateContext, path: string): unknown {
  if (path === '.') return ctx['.'];
  let cur: unknown = ctx;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return value !== 0;
  return true;
}

/** 数组默认用「、」连接 —— 模板里九成的数组都是「列一串编号」这个用途 */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(stringify).join('、');
  return String(value);
}

function asContext(value: unknown): TemplateContext {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as TemplateContext;
  }
  return { '.': value };
}

function renderNodes(nodes: TemplateNode[], ctx: TemplateContext): string {
  let out = '';

  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
      continue;
    }
    if (node.type === 'var') {
      out += stringify(lookup(ctx, node.path));
      continue;
    }

    const value = lookup(ctx, node.path);
    if (node.kind === 'each') {
      if (Array.isArray(value)) {
        for (const item of value) out += renderNodes(node.children, asContext(item));
      } else if (value !== null && typeof value === 'object') {
        out += renderNodes(node.children, value as TemplateContext);
      }
    } else if (node.kind === 'if') {
      if (truthy(value)) out += renderNodes(node.children, ctx);
    } else if (!truthy(value)) {
      out += renderNodes(node.children, ctx);
    }
  }

  return out;
}

/**
 * 压掉多余的空白。
 *
 * 模板里 `{{#each}}` 和 `{{/each}}` 各占一行，每轮渲染都会带出一个空行，
 * 不处理的话渲染出来到处是空行。这里只把「3 个以上连续换行」压成 1 个空行，
 * 你手写的那种单个空行会原样保留。
 */
export function tidy(markdown: string): string {
  return `${markdown
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')}\n`;
}

export function renderTemplate(
  source: string,
  context: TemplateContext,
  name = 'template',
): string {
  return tidy(renderNodes(parse(source, name), context));
}
