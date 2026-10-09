/**
 * 前后端共享的领域类型。
 *
 * 本包**只导出类型**，不含任何运行时代码：`import type` 会被 Node 的类型剥离
 * 与 Vite 完全擦除，因此共享层不需要构建步骤，也不需要运行时解析。
 * 需要运行时常量请放到各自的包里（server/src/domain/constants.ts 等）。
 */

export type Role = 'se' | 'dev' | 'test' | 'maint';

/** 阶段类型：wait 类型的阶段进入时自动创建一条阻塞（D6） */
export type StageKind = 'work' | 'review' | 'wait' | 'milestone';

export type StageOutcome = 'completed' | 'skipped';

/**
 * 需求状况 —— 不是数据库字段，而是由事实投影出来的（D2）。
 * 优先级：closed > suspended > blocked > normal
 */
export type ItemCondition = 'normal' | 'blocked' | 'suspended' | 'closed';

export type CloseReason = 'done' | 'cancelled';

export type BlockerDirection = 'blocked_by_others' | 'blocking_others';
export type BlockerSeverity = 'low' | 'medium' | 'high';

export type DeliverableCategory =
  | 'doc'
  | 'design'
  | 'screenshot'
  | 'log'
  | 'review_record'
  | 'other';

export type TodoSource = 'manual' | 'template';

export type PipelineRole = Role;

export type EventType =
  | 'item_created'
  | 'stage_enter'
  | 'stage_exit'
  | 'todo_added'
  | 'todo_done'
  | 'todo_reopened'
  | 'todo_removed'
  | 'deliverable_added'
  | 'deliverable_removed'
  | 'deliverable_restored'
  | 'blocker_open'
  | 'blocker_close'
  | 'suspend'
  | 'resume'
  | 'item_close'
  | 'item_reopen'
  | 'ddl_change'
  | 'role_change'
  | 'note'
  | 'link_added'
  | 'link_removed'
  // 项目级
  | 'project_created'
  | 'project_updated'
  | 'project_handoff'
  | 'project_handoff_accepted'
  | 'project_reclaim'
  | 'project_archived'
  | 'project_unarchived';

// ---------------------------------------------------------------------------
// 行类型（与 SQLite 表的列一一对应）
// ---------------------------------------------------------------------------

/** 项目类型。这是「这是哪种东西」的分类，不是「它现在什么状态」——不违反 D2。 */
export type ProjectKind = 'delivery' | 'caretaking';

/** 拖进来的一个文件最后怎么处理的 */
export type DropAction = 'created' | 'versioned' | 'unchanged' | 'failed';

export interface DropFileResult {
  /** 拖进来的原始文件名 */
  filename: string;
  /** 归到了哪个交付物名下 */
  deliverableName: string;
  action: DropAction;
  /** action === 'failed' 时才有 */
  error?: string;
  deliverable?: DeliverableWithVersions;
}

export interface ProjectRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  due_at: string | null;
  is_default: number;
  archived_at: string | null;
  kind: ProjectKind;
  /** 责任人。交接就是改它。 */
  owner: string;
  /** 看护条件：等什么会触发下一次动作（看护型才有意义） */
  watch_for: string | null;
  /**
   * 接手方确认接手的时间。NULL 且 owner 不是我 = **待接收**：
   * 已经交出去了但对方还没接，这段真空期我还在兜底。
   */
  handoff_accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemRow {
  id: number;
  code: string;
  project_id: number;
  title: string;
  description: string | null;
  role: Role;
  criticality: number;
  due_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  closed_at: string | null;
  close_reason: CloseReason | null;
  priority_override: number | null;
  owner: string;
  created_at: string;
  updated_at: string;
}

/** v_item：在 item 之上附加投影出的 condition 与当前阶段 */
export interface ItemViewRow extends ItemRow {
  active_stage_id: number | null;
  condition: ItemCondition;
}

export interface StageRow {
  id: number;
  item_id: number;
  seq: number;
  key: string;
  name: string;
  kind: StageKind;
  planned_start: string | null;
  planned_end: string | null;
  actual_start_at: string | null;
  actual_end_at: string | null;
  outcome: StageOutcome | null;
  skip_reason: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  wait_counterparty: string | null;
  wait_for: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TodoRow {
  id: number;
  item_id: number;
  stage_id: number | null;
  text: string;
  done: number;
  done_at: string | null;
  due_at: string | null;
  seq: number;
  source: TodoSource;
  created_at: string;
}

export interface DeliverableRow {
  id: number;
  item_id: number;
  /** 在流程里的位置（决定阶段卡点）。和 folder_id 正交，互不干涉 */
  stage_id: number | null;
  /** 你自己怎么归置。NULL = 根目录 */
  folder_id: number | null;
  name: string;
  category: DeliverableCategory;
  required: number;
  current_version_id: number | null;
  /**
   * 「移除」的时间。软删除 —— 行留着，界面各处都不再显示它。
   * 字节的回收是**另一步**（见 purgeFiles）：记录和文件是两件事。
   */
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliverableVersionRow {
  id: number;
  deliverable_id: number;
  version_no: number;
  sha256: string;
  rel_path: string;
  original_filename: string;
  size_bytes: number;
  mime: string | null;
  note: string | null;
  uploaded_at: string;
}

export interface BlockerRow {
  id: number;
  item_id: number;
  stage_id: number | null;
  direction: BlockerDirection;
  counterparty: string;
  need: string;
  severity: BlockerSeverity;
  opened_at: string;
  promised_at: string | null;
  closed_at: string | null;
  resolution: string | null;
}

export interface EventRow {
  id: number;
  type: EventType;
  item_id: number | null;
  stage_id: number | null;
  deliverable_id: number | null;
  blocker_id: number | null;
  /** 项目级事件（建项目、交接…）挂在这里 */
  project_id: number | null;
  payload: string | null;
  note: string | null;
  actor: string;
  occurred_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

export interface ReportRow {
  id: number;
  title: string;
  period_start: string;
  period_end: string;
  generated_md: string | null;
  content_md: string | null;
  finalized_at: string | null;
  template_key: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// 流水线模板（config/pipelines/*.yaml）
// ---------------------------------------------------------------------------

export interface PipelineStageDef {
  key: string;
  name: string;
  kind: StageKind;
  todos?: string[];
  wait_counterparty?: string;
  wait_for?: string;
}

export interface PipelineTemplate {
  key: string;
  name: string;
  role: Role;
  stages: PipelineStageDef[];
}

// ---------------------------------------------------------------------------
// 驾驶舱
// ---------------------------------------------------------------------------

export type DashboardBucketKey =
  | 'overdue'
  | 'due_soon'
  | 'blocked_by_others'
  | 'blocking_others'
  | 'stale'
  | 'no_ddl'
  | 'suspended';

export interface DashboardCard {
  itemId: number;
  code: string;
  title: string;
  role: Role;
  condition: ItemCondition;
  criticality: number;
  currentStage: string | null;
  nextDdl: string | null;
  /** 桶内打分，越高越靠前 */
  score: number;
  /** 该行落在本桶的原因，直接显示给用户 */
  reason: string;
  /** 桶特有的排序数值（超期天数 / 等待天数 / 停滞天数 …） */
  metric: number;
  /** 手动置顶/置底。非 null 时永远覆盖自动排序。 */
  pinned: 'top' | 'bottom' | null;
}

export interface DashboardSection {
  key: DashboardBucketKey;
  title: string;
  /** 该桶的排序方向说明，便于 UI 显示 */
  sortHint: string;
  cards: DashboardCard[];
}

// ---- 仪表盘：焦点列表与甘特图 ----

export interface DashboardFocus {
  /** 最紧要的几条（按综合分） */
  urgent: DashboardCard[];
  /** 需要我去推动：别人在等我 */
  blockingOthers: DashboardCard[];
  /** 我被卡住：我在等别人 */
  blockedByOthers: DashboardCard[];
}

export interface GanttMilestone {
  stageId: number;
  name: string;
  /** 相对窗口起点的天数 */
  day: number;
  plannedEnd: string;
}

export interface GanttBar {
  itemId: number;
  code: string;
  title: string;
  role: Role;
  condition: ItemCondition;
  /** 相对窗口起点的天数；渲染时换算成百分比 */
  startDay: number;
  endDay: number;
  /** 已逾期天数；0 = 未逾期 */
  overdueDays: number;
  nextDdl: string;
  currentStage: string | null;
  score: number;
  /** 未结束阶段里设了 DDL 的，在图上标成里程碑 */
  milestones: GanttMilestone[];
}

export interface GanttChart {
  windowStart: string;
  windowEnd: string;
  totalDays: number;
  /** 今天这条竖线的位置 */
  todayDay: number;
  ticks: { day: number; label: string; major: boolean }[];
  bars: GanttBar[];
  /** 没有 DDL、放不上时间轴的 */
  withoutDdl: { itemId: number; code: string; title: string }[];
  /** 有 DDL 但远到超出窗口、没画出来的条数 */
  beyondWindow: number;
}

export interface DashboardPayload {
  summary: Record<DashboardBucketKey, number>;
  sections: DashboardSection[];
  focus: DashboardFocus;
  gantt: GanttChart;
  /**
   * 看护中的项目。
   *
   * 看护型项目**不进任何时间桶**（它压根不是 item），所以它需要单独一块：
   * 安静地列着，只有触发时才需要你动手。
   */
  caretaking: ProjectSummary[];
}

// ---------------------------------------------------------------------------
// 接口返回形状
//
// 服务端也从这里取这些类型（而不是各写一份），所以前后端对同一份响应的理解
// 在编译期就被绑在一起了 —— 改了字段名，两边一起报错。
// ---------------------------------------------------------------------------

export interface DeliverableWithVersions extends DeliverableRow {
  versions: DeliverableVersionRow[];
}

/** GET /api/items/:id 以及所有需求级变更接口的统一返回形状 */
export interface ItemDetail {
  item: ItemViewRow;
  /** 所属项目（P1 起隐式存在的容器，看护型项目会露出来） */
  project: ProjectRow;
  stages: StageRow[];
  todos: TodoRow[];
  blockers: BlockerRow[];
  deliverables: DeliverableWithVersions[];
  /** 挂在需求上的链接（内部 wiki 之类） */
  links: ItemLinkRow[];
  /** 已经「移除」的交付物。留着是为了可逆，界面上折起来不碍事 */
  removedDeliverables: DeliverableWithVersions[];
  /**
   * 需求级文件树（根节点是虚的）。
   *
   * 里面装的交付物和上面的 `deliverables` 是同一批 —— 故意的：
   * 阶段视图要「按阶段分」，文件树要「按文件夹分」，是同一份数据的两个切面。
   * 让服务端把树建好，客户端就不用自己拼，也就能测。
   */
  tree: FolderNode;
}

/**
 * 命名约定（整个 shared 层遵守）：
 *   - **携带库行的响应数据一律蛇形**，跟列名一致：ProjectSummary、ProjectDetail、HandoffResult…
 *   - **纯展示对象用驼峰**：DashboardCard、GanttBar、PaletteCandidate…
 * 混着写会让人每次都要猜，所以这条线要划清楚。
 */
export interface ProjectSummary extends ProjectRow {
  total_items: number;
  /** 未关闭的子需求数 */
  active_items: number;
  open_blockers: number;
  last_activity_at: string | null;
  /** 已交出去、但对方还没确认接手 —— 这段真空期我还在兜底 */
  pending_handoff: boolean;
}

export interface ProjectDetail {
  project: ProjectRow;
  items: ItemViewRow[];
  open_blockers: BlockerRow[];
  last_activity_at: string | null;
}

/** 交接结果。接手方要知道自己接了什么，所以把上下文一并回。 */
export interface HandoffResult {
  project: ProjectRow;
  /** 交接那一刻仍在途的子需求 */
  pending_items: { code: string; title: string; current_stage: string | null }[];
  open_blockers: number;
}

export interface AdvanceStageResult {
  itemId: number;
  fromStageKey: string;
  fromStageName: string;
  toStageKey: string | null;
  toStageName: string | null;
  outcome: StageOutcome;
  forced: boolean;
  closedBlockerIds: number[];
  /** 强推时被忽略的未完事项，直接回给用户看 */
  bypassed: string[];
}

// ---- 命令面板 ----

export interface PaletteCandidate {
  kind: 'jump' | 'command';
  label: string;
  detail: string;
  /**
   * 按 Tab 时把「正在输入的那一段」替换成它。
   * **没有这个字段的候选是纯展示的，Tab 不会动它** —— 这样就不用担心
   * Tab 把用户已经敲好的内容冲掉。
   */
  insert?: string;
  /** 选中它时直接执行这条完整命令（比如把当前输入丢给全文检索） */
  run?: string;
  itemId?: number;
  itemCode?: string;
  command?: string;
}

/** 补全上下文。只有它存在时 Tab 才有意义 —— 它说明候选是在补某一段文字。 */
export interface PaletteCompletion {
  /** 正在补的那一段原文 */
  token: string;
  /** 所有候选 insert 的最长公共前缀；比 token 长才算「补上了」 */
  commonPrefix: string;
}

export interface PaletteQueryResult {
  mode: 'search' | 'command';
  candidates: PaletteCandidate[];
  /** 只在补全场景下出现 */
  completion?: PaletteCompletion;
  /** 命令模式下的人话预览：会做什么 */
  preview?: string;
  error?: string;
  help?: string;
}

export type PaletteNavigate =
  | { kind: 'item'; itemId: number; stageId?: number | null }
  | { kind: 'reports'; reportId: number }
  | { kind: 'search'; q: string };

export interface PaletteExecuteResult {
  message: string;
  itemId: number | null;
  navigate?: PaletteNavigate;
}

// ---- 元信息 ----

/** 全文检索：索引里的一条文档属于哪张源表 */
export type SearchKind =
  | 'item'
  | 'note'
  | 'todo'
  | 'blocker'
  | 'deliverable'
  | 'project'
  | 'link';

export interface SearchHit {
  kind: SearchKind;
  refId: number;
  itemId: number | null;
  projectId: number | null;
  occurredAt: string;
  /** 命中的是标题还是正文 —— 标题命中排前面 */
  inTitle: boolean;
  /** 命中片段，查询词用 [] 括起来，供界面加粗 */
  snippet: string;
  itemCode: string | null;
  itemTitle: string | null;
  projectName: string | null;
}

export interface SearchResult {
  q: string;
  total: number;
  hits: SearchHit[];
  /** 每个类别各命中多少条 */
  counts: Record<SearchKind, number>;
}

// ---------------------------------------------------------------------------
// 需求链接与文件树
// ---------------------------------------------------------------------------

/** 挂在需求上的一个链接（内部 wiki、设计稿、看板……） */
export interface ItemLinkRow {
  id: number;
  item_id: number;
  label: string;
  url: string;
  created_at: string;
}

/** 交付物文件夹。需求级，parent_id 为 NULL 表示根层。 */
export interface FolderRow {
  id: number;
  item_id: number;
  parent_id: number | null;
  name: string;
  created_at: string;
}

/**
 * 文件树的一个节点。
 *
 * 根节点是**虚的**（`folder` 为 null），只用来装根目录下的东西 ——
 * 这样递归渲染时不用为「根」写特例。
 */
export interface FolderNode {
  folder: FolderRow | null;
  children: FolderNode[];
  /** 直接放在这一层里的交付物（不含子文件夹里的） */
  files: DeliverableWithVersions[];
}

/** 磁盘占用与可回收量。回收的是「没有任何在册交付物引用的字节」。 */
export interface StorageUsage {
  totalFiles: number;
  totalBytes: number;
  /** 移除交付物之后能收回来的部分 */
  recoverableFiles: number;
  recoverableBytes: number;
  removedDeliverables: number;
}

export interface PurgeResult {
  /** 删掉的版本记录数（都属于已移除的交付物） */
  deletedVersions: number;
  deletedFiles: number;
  freedBytes: number;
  /** 因为还有别的在册交付物引用同一份内容而保留下来的文件数（内容寻址去重） */
  keptShared: number;
}

/** 批量操作。勾一堆东西一次处理掉，比如「把整个文件夹的内容移到上一级」。 */
export type BatchAction = 'move' | 'remove' | 'restore';

export interface BatchResult {
  /** 真正改动的条数 */
  changed: number;
  /** 请求里带了、但已经是目标状态的（幂等，不算失败） */
  unchanged: number;
  /** 找不到的 id。有值就说明界面上的数据和库不一致，值得看一眼 */
  missing: number[];
}

export interface MetaLabels {  roles: Record<Role, string>;
  conditions: Record<ItemCondition, string>;
  stageKinds: Record<StageKind, string>;
  stageOutcomes: Record<StageOutcome, string>;
  directions: Record<BlockerDirection, string>;
  severities: Record<BlockerSeverity, string>;
  categories: Record<DeliverableCategory, string>;
  projectKinds: Record<ProjectKind, string>;
  searchKinds: Record<SearchKind, string>;
}

/**
 * `GET /api/meta` 的返回。
 *
 * `limits` 来自 settings.yaml 而不是标签表，所以放在这儿而不是 MetaLabels 里。
 */
export interface MetaResponse extends MetaLabels {
  paletteHelp: string;
  limits: { maxUploadMb: number };
}

/** GET /api/meta：中文标签的唯一来源，前端不再各自写一份 */
export interface Meta extends MetaLabels {
  paletteHelp: string;
}
