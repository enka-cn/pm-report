# 汇报（{{period_start}} ~ {{period_end}}）

## 一、需要支援 / 风险

{{#each blockers}}
- **{{item_ref}}** — {{direction_label}} {{counterparty}} 已 {{age_days}} 天：{{need}}{{#if promise_note}}（{{promise_note}}）{{/if}}
{{/each}}
{{#unless blockers}}
- 没有未解除的阻塞
{{/unless}}

{{#if overdue_items}}
已逾期：{{#each overdue_items}}{{ref}}（{{days}} 天）{{/each}}
{{/if}}
{{#if upcoming_items}}
未来 {{lookahead_days}} 天内到期：{{#each upcoming_items}}{{ref}}（{{next_ddl}}）{{/each}}
{{/if}}

## 二、本区间进展

{{#each items_with_events}}
### {{ref}}（{{role_label}}，当前：{{current_stage}}）

{{#if transitions}}
- 阶段推进：{{transitions}}
{{/if}}
{{#if deliverables}}
- 交付物：{{deliverables}}
{{/if}}
{{#if closed_blockers}}
- 解除阻塞：{{closed_blockers}}
{{/if}}
{{#if extra}}
- {{extra}}
{{/if}}
{{#if done_todos}}
- 完成待办 {{done_todos}} 项
{{/if}}
{{#if removed_todos}}
- 删除不适用的待办 {{removed_todos}} 项
{{/if}}
{{#each notes}}
- 备注：{{.}}
{{/each}}

{{/each}}
{{#unless items_with_events}}
- 本区间没有任何进展记录
{{/unless}}

## 三、下区间计划

| 需求 | 当前阶段 | 下一阶段 | 最近 DDL |
|---|---|---|---|
{{#each active_items}}
| {{ref}} | {{current_stage}} | {{next_stage}} | {{next_ddl}} |
{{/each}}

## 四、静默与挂起

{{#each silent_items}}
- {{ref}}（{{reason}}）
{{/each}}
{{#each suspended_items}}
- [挂起 {{days}} 天] {{ref}}{{#if reason}} — {{reason}}{{/if}}
{{/each}}
{{#if no_quiet_items}}
- 无
{{/if}}
