import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateError, renderTemplate, tidy } from '../src/domain/template.ts';

test('变量插值；缺失的变量渲染成空字符串，不留下 {{}}', () => {
  const out = renderTemplate('你好 {{name}}，{{missing}}结束', { name: '世界' });
  assert.equal(out, '你好 世界，结束\n');
});

test('数组默认用「、」连接', () => {
  assert.equal(renderTemplate('{{codes}}', { codes: ['REQ-1', 'REQ-2', 'REQ-3'] }), 'REQ-1、REQ-2、REQ-3\n');
});

test('each 遍历对象数组；独占一行的区块标签不会留下空行', () => {
  const tpl = ['{{#each items}}', '- {{code}} {{title}}', '{{/each}}'].join('\n');
  assert.equal(
    renderTemplate(tpl, {
      items: [
        { code: 'REQ-1', title: '甲' },
        { code: 'REQ-2', title: '乙' },
      ],
    }),
    '- REQ-1 甲\n- REQ-2 乙\n',
    '两项之间不能出现空行',
  );

  assert.equal(renderTemplate(tpl, { items: [] }), '\n');
});

test('区块标签前后有别的字符时不当「独占一行」处理', () => {
  assert.equal(renderTemplate('前缀 {{#if a}}内容{{/if}} 后缀', { a: true }), '前缀 内容 后缀\n');
  assert.equal(renderTemplate('前缀 {{#if a}}内容{{/if}} 后缀', { a: false }), '前缀  后缀\n');
});

test('if 与 unless：空数组、空串、false、0 都算「没有」', () => {
  const tpl = '{{#if list}}有{{/if}}{{#unless list}}无{{/unless}}';
  assert.equal(renderTemplate(tpl, { list: ['x'] }), '有\n');
  assert.equal(renderTemplate(tpl, { list: [] }), '无\n');
  assert.equal(renderTemplate(tpl, { list: undefined }), '无\n');
  assert.equal(renderTemplate(tpl, { list: '' }), '无\n');
  assert.equal(renderTemplate(tpl, { list: false }), '无\n');
  assert.equal(renderTemplate(tpl, { list: 0 }), '无\n');
  assert.equal(renderTemplate(tpl, { list: '  ' }), '无\n');
});

test('嵌套：each 里套 each 与 unless，上下文正确切换', () => {
  const tpl = [
    '{{#each items}}',
    '### {{code}}',
    '{{#unless notes}}',
    '（无备注）',
    '{{/unless}}',
    '{{#each notes}}',
    '- {{.}}',
    '{{/each}}',
    '{{/each}}',
  ].join('\n');

  const out = renderTemplate(tpl, {
    items: [
      { code: 'REQ-1', notes: ['甲', '乙'] },
      { code: 'REQ-2', notes: [] },
    ],
  });

  // 两项之间有没有空行，由模板里有没有空行决定 —— 这里模板里没写，所以紧挨着
  assert.equal(out, '### REQ-1\n- 甲\n- 乙\n### REQ-2\n（无备注）\n');
});

test('模板里写的空行会被保留（用来分隔每一块）', () => {
  const tpl = ['{{#each items}}', '### {{code}}', '- {{n}}', '', '{{/each}}'].join('\n');
  const out = renderTemplate(tpl, {
    items: [
      { code: 'A', n: 1 },
      { code: 'B', n: 2 },
    ],
  });
  assert.equal(out, '### A\n- 1\n\n### B\n- 2\n');
});

test('each 遍历对象（非数组）时把对象当上下文渲染一次', () => {
  assert.equal(renderTemplate('{{#each o}}{{a}}-{{b}}{{/each}}', { o: { a: 1, b: 2 } }), '1-2\n');
});

test('tidy：压掉连续空行，但保留你手写的单个空行', () => {
  assert.equal(tidy('a\n\n\n\nb\n'), 'a\n\nb\n');
  assert.equal(tidy('a\n\nb\n'), 'a\n\nb\n');
  assert.equal(tidy('\n\n\na\n'), 'a\n');
  assert.equal(tidy('a   \nb\t\n'), 'a\nb\n');
});

test('模板写错时报清楚的错，而不是静默渲染出半成品', () => {
  assert.throws(() => renderTemplate('{{#each x}}没有闭合', { x: [] }), (e: unknown) => {
    assert.ok(e instanceof TemplateError);
    assert.match(e.message, /没有闭合/);
    return true;
  });

  assert.throws(() => renderTemplate('{{/each}}', {}), /没有对应的开标签/);
  assert.throws(() => renderTemplate('{{#each x}}{{/if}}', { x: [] }), /标签不匹配/);
  assert.throws(() => renderTemplate('{{#with x}}{{/with}}', {}), /不支持 #with/);
  assert.throws(() => renderTemplate('{{#each}}', {}), /看不懂/);
  assert.throws(() => renderTemplate('{{#each x}}abc{{y', {}), /未闭合的 \{\{/);
  assert.throws(() => renderTemplate('{{^x}}', {}), /请改用 \{\{#unless x\}\}/);
});

test('渲染 Markdown 不做 HTML 转义（转义会把 & 和 < 弄坏）', () => {
  assert.equal(renderTemplate('{{v}}', { v: 'A & B < C' }), 'A & B < C\n');
});
