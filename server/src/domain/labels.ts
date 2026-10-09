import type {
  BlockerDirection,
  BlockerSeverity,
  DeliverableCategory,
  ItemCondition,
  MetaLabels,
  ProjectKind,
  Role,
  SearchKind,
  StageKind,
  StageOutcome,
} from '@manager/shared';

/**
 * 中文标签的唯一来源。
 *
 * 不放进 @manager/shared：那个包只导出类型（没有运行时代码），
 * 前端通过 GET /api/meta 取这些映射，避免同一个词在前后端各写一份然后漂移。
 */

export const ROLE_LABELS: Record<Role, string> = {
  se: 'SE',
  dev: '开发',
  maint: '维护',
};

export const CONDITION_LABELS: Record<ItemCondition, string> = {
  normal: '正常',
  blocked: '阻塞',
  suspended: '挂起',
  closed: '结束',
};

export const STAGE_KIND_LABELS: Record<StageKind, string> = {
  work: '实施',
  review: '评审',
  wait: '等待',
  milestone: '里程碑',
};

export const STAGE_OUTCOME_LABELS: Record<StageOutcome, string> = {
  completed: '完成',
  skipped: '跳过',
};

export const DIRECTION_LABELS: Record<BlockerDirection, string> = {
  blocked_by_others: '我被阻塞',
  blocking_others: '我阻塞别人',
};

export const SEVERITY_LABELS: Record<BlockerSeverity, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export const CATEGORY_LABELS: Record<DeliverableCategory, string> = {
  doc: '文档',
  design: '设计',
  screenshot: '截图',
  log: '日志',
  review_record: '评审记录',
  other: '其他',
};

export const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  delivery: '交付型',
  caretaking: '看护型',
};

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  item: '需求',
  note: '备注',
  todo: '待办',
  blocker: '阻塞',
  deliverable: '交付物',
  project: '项目',
  link: '链接',
};

export function meta(): MetaLabels {
  return {
    roles: ROLE_LABELS,
    conditions: CONDITION_LABELS,
    stageKinds: STAGE_KIND_LABELS,
    stageOutcomes: STAGE_OUTCOME_LABELS,
    directions: DIRECTION_LABELS,
    severities: SEVERITY_LABELS,
    categories: CATEGORY_LABELS,
    projectKinds: PROJECT_KIND_LABELS,
    searchKinds: SEARCH_KIND_LABELS,
  };
}
