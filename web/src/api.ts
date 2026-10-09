import type {
  AdvanceStageResult,
  BatchAction,
  BatchResult,
  BlockerDirection,
  BlockerSeverity,
  CloseReason,
  DashboardPayload,
  DeliverableCategory,
  DeliverableWithVersions,
  DropFileResult,
  FolderNode,
  FolderRow,
  ItemLinkRow,
  EventRow,
  HandoffResult,
  ItemDetail,
  ItemViewRow,
  MetaResponse,
  PaletteExecuteResult,
  PaletteQueryResult,
  PipelineTemplate,
  ProjectDetail,
  ProjectKind,
  ProjectRow,
  ProjectSummary,
  PurgeResult,
  ReportRow,
  Role,
  SearchKind,
  SearchResult,
  StorageUsage,
  StageOutcome,
  TodoRow,
} from '@manager/shared';

/** 服务端把业务错误放在 { error } 里，都是面向用户的中文说明，直接透出即可 */
export class ApiError extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const isForm = init.body instanceof FormData;
  if (init.body !== undefined && !isForm) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const message =
      data !== null && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `请求失败（HTTP ${res.status}）`;
    throw new ApiError(message);
  }
  return data as T;
}

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  meta: () => request<MetaResponse>('/api/meta'),

  dashboard: () => request<DashboardPayload>('/api/dashboard'),

  listItems: (f: {
    q?: string;
    role?: Role | '';
    condition?: string;
    includeClosed?: boolean;
  } = {}) =>
    request<{ items: ItemViewRow[] }>(
      `/api/items${query({
        q: f.q,
        role: f.role,
        condition: f.condition,
        includeClosed: f.includeClosed ? 'true' : undefined,
      })}`,
    ),

  item: (id: number) => request<ItemDetail>(`/api/items/${id}`),

  /** 已加载的流水线模板。新建需求时照着选，避免选到没有模板的角色 */
  pipelines: () => request<{ pipelines: PipelineTemplate[] }>('/api/pipelines'),

  createItem: (body: {
    title: string;
    role: Role;
    description?: string | null;
    criticality?: number;
    dueAt?: string | null;
    pipelineKey?: string | null;
    projectId?: number | null;
  }) => request<ItemDetail>('/api/items', { method: 'POST', body: JSON.stringify(body) }),

  timeline: (id: number) => request<{ events: EventRow[] }>(`/api/items/${id}/timeline`),

  note: (id: number, text: string, occurredAt?: string) =>
    request<{ eventId: number }>(`/api/items/${id}/note`, {
      method: 'POST',
      body: JSON.stringify({ text, occurredAt }),
    }),

  setItemDue: (id: number, dueAt: string | null) =>
    request<ItemDetail>(`/api/items/${id}/due`, {
      method: 'PATCH',
      body: JSON.stringify({ dueAt }),
    }),

  setStageDue: (stageId: number, plannedEnd: string | null) =>
    request<{ stage: unknown; item: ItemDetail }>(`/api/stages/${stageId}/due`, {
      method: 'PATCH',
      body: JSON.stringify({ plannedEnd }),
    }),

  suspendItem: (id: number, reason: string) =>
    request<ItemDetail>(`/api/items/${id}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  resumeItem: (id: number) => request<ItemDetail>(`/api/items/${id}/resume`, { method: 'POST' }),

  closeItem: (id: number, reason: CloseReason, note?: string, forced?: boolean) =>
    request<ItemDetail>(`/api/items/${id}/close`, {
      method: 'POST',
      body: JSON.stringify({ reason, note, forced }),
    }),

  reopenItem: (id: number) => request<ItemDetail>(`/api/items/${id}/reopen`, { method: 'POST' }),

  suspendStage: (stageId: number, reason: string) =>
    request<ItemDetail>(`/api/stages/${stageId}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  resumeStage: (stageId: number) =>
    request<ItemDetail>(`/api/stages/${stageId}/resume`, { method: 'POST' }),

  advanceStage: (
    stageId: number,
    body: {
      outcome?: StageOutcome;
      skipReason?: string;
      forced?: boolean;
      reason?: string;
      closeBlockers?: boolean;
    },
  ) =>
    request<ItemDetail & { result: AdvanceStageResult }>(`/api/stages/${stageId}/advance`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  addTodo: (body: { itemId: number; stageId?: number | null; text: string; dueAt?: string | null }) =>
    request<TodoRow>('/api/todos', { method: 'POST', body: JSON.stringify(body) }),

  setTodoDone: (todoId: number, done: boolean) =>
    request<TodoRow>(`/api/todos/${todoId}`, { method: 'PATCH', body: JSON.stringify({ done }) }),

  removeTodo: (todoId: number, reason?: string) =>
    request<{ ok: true; text: string }>(`/api/todos/${todoId}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),

  openBlocker: (body: {
    itemId: number;
    stageId?: number | null;
    direction: BlockerDirection;
    counterparty: string;
    need: string;
    severity?: BlockerSeverity;
    promisedAt?: string | null;
  }) => request<{ blockerId: number }>('/api/blockers', { method: 'POST', body: JSON.stringify(body) }),

  closeBlocker: (blockerId: number, resolution: string) =>
    request<{ ok: true }>(`/api/blockers/${blockerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ resolution }),
    }),

  uploadDeliverable: (form: FormData) =>
    request<DeliverableWithVersions & { deduplicated: boolean }>('/api/deliverables', {
      method: 'POST',
      body: form,
    }),

  addDeliverableVersion: (deliverableId: number, form: FormData) =>
    request<DeliverableWithVersions & { deduplicated: boolean }>(
      `/api/deliverables/${deliverableId}/versions`,
      { method: 'POST', body: form },
    ),

  /**
   * 拖进来就加入：一次多个文件，服务端从文件名推名字和类别、
   * 同名归到同一条（认作新版本）、内容没变就跳过。
   */
  dropDeliverables: (itemId: number, target: { stageId: number | null; folderId?: number | null }, files: File[]) => {
    const fd = new FormData();
    if (target.stageId !== null) fd.set('stageId', String(target.stageId));
    if (target.folderId !== undefined && target.folderId !== null) {
      fd.set('folderId', String(target.folderId));
    }
    for (const f of files) fd.append('file', f);
    return request<{ results: DropFileResult[] }>(`/api/items/${itemId}/deliverables/drop`, {
      method: 'POST',
      body: fd,
    });
  },

  setDeliverableRequired: (deliverableId: number, required: boolean) =>
    request<{ ok: true }>(`/api/deliverables/${deliverableId}`, {
      method: 'PATCH',
      body: JSON.stringify({ required }),
    }),

  setDeliverableCategory: (deliverableId: number, category: DeliverableCategory) =>
    request<{ ok: true }>(`/api/deliverables/${deliverableId}`, {
      method: 'PATCH',
      body: JSON.stringify({ category }),
    }),

  /** 把交付物归到某个文件夹（null = 根目录）。只改归置，不碰阶段 */
  moveDeliverable: (deliverableId: number, folderId: number | null) =>
    request<{ ok: true }>(`/api/deliverables/${deliverableId}`, {
      method: 'PATCH',
      body: JSON.stringify({ folderId }),
    }),

  renameDeliverable: (deliverableId: number, name: string) =>
    request<{ ok: true }>(`/api/deliverables/${deliverableId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  /** 移除（软删除）：只让它从各处消失，磁盘上的字节还在 */
  removeDeliverable: (deliverableId: number, reason?: string) =>
    request<{ ok: true }>(`/api/deliverables/${deliverableId}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),

  restoreDeliverable: (deliverableId: number) =>
    request<{ ok: true }>(`/api/deliverables/${deliverableId}/restore`, { method: 'POST' }),

  storageUsage: () => request<StorageUsage>('/api/storage'),

  /** 回收磁盘：删掉没有任何在册交付物引用的字节 */
  purgeFiles: () => request<PurgeResult>('/api/storage/purge', { method: 'POST' }),

  /**
   * 批量操作。整个批次在服务端是一个事务 —— 要么全成要么全不成。
   * 半截生效比失败更让人困惑：你以为都成功了，实际只动了一半。
   */
  batchDeliverables: (body: {
    ids: number[];
    action: BatchAction;
    folderId?: number | null;
    reason?: string;
  }) =>
    request<BatchResult>('/api/deliverables/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ---- 需求链接 ----------------------------------------------------------

  listLinks: (itemId: number) =>
    request<{ links: ItemLinkRow[] }>(`/api/items/${itemId}/links`),

  addLink: (itemId: number, body: { url: string; label?: string }) =>
    request<ItemLinkRow>(`/api/items/${itemId}/links`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateLink: (linkId: number, patch: { label?: string; url?: string }) =>
    request<ItemLinkRow>(`/api/links/${linkId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  removeLink: (linkId: number) =>
    request<{ ok: true }>(`/api/links/${linkId}`, { method: 'DELETE' }),

  // ---- 交付物文件夹 ------------------------------------------------------

  folderTree: (itemId: number) => request<{ tree: FolderNode }>(`/api/items/${itemId}/tree`),

  createFolder: (itemId: number, body: { name: string; parentId?: number | null }) =>
    request<FolderRow>(`/api/items/${itemId}/folders`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateFolder: (folderId: number, patch: { name?: string; parentId?: number | null }) =>
    request<FolderRow>(`/api/folders/${folderId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteFolder: (folderId: number) =>
    request<{ ok: true }>(`/api/folders/${folderId}`, { method: 'DELETE' }),

  paletteQuery: (q: string, currentItemId?: number | null) =>
    request<PaletteQueryResult>(
      `/api/palette/query${query({ q, currentItemId: currentItemId ?? undefined })}`,
    ),

  paletteExecute: (input: string, currentItemId?: number | null) =>
    request<PaletteExecuteResult>('/api/palette/execute', {
      method: 'POST',
      body: JSON.stringify({ input, currentItemId }),
    }),

  // ---- 汇报 --------------------------------------------------------------

  listReports: () => request<{ reports: ReportRow[]; templates: string[] }>('/api/reports'),

  report: (id: number) => request<ReportRow>(`/api/reports/${id}`),

  generateReport: (body: { templateKey?: string; periodStart?: string; periodEnd?: string } = {}) =>
    request<ReportRow>('/api/reports/generate', { method: 'POST', body: JSON.stringify(body) }),

  updateReport: (id: number, patch: { contentMd?: string; title?: string }) =>
    request<ReportRow>(`/api/reports/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),

  finalizeReport: (id: number) =>
    request<ReportRow>(`/api/reports/${id}/finalize`, { method: 'POST' }),

  unfinalizeReport: (id: number) =>
    request<ReportRow>(`/api/reports/${id}/unfinalize`, { method: 'POST' }),

  deleteReport: (id: number) => request<{ ok: true }>(`/api/reports/${id}`, { method: 'DELETE' }),

  // ---- 全文检索 ----------------------------------------------------------

  search: (q: string, kind?: SearchKind | null, limit?: number) =>
    request<SearchResult>(
      `/api/search${query({ q, kind: kind ?? undefined, limit })}`,
    ),

  /** 重建索引。正常用不上（触发器保证同步），是索引漂了时的对账手段。 */
  reindexSearch: () =>
    request<{ ok: true; indexed: number }>('/api/search/reindex', { method: 'POST' }),

  // ---- 项目 --------------------------------------------------------------

  listProjects: (f: { kind?: ProjectKind; includeArchived?: boolean } = {}) =>
    request<{ projects: ProjectSummary[] }>(
      `/api/projects${query({
        kind: f.kind,
        includeArchived: f.includeArchived ? 'true' : undefined,
      })}`,
    ),

  project: (id: number) => request<ProjectDetail>(`/api/projects/${id}`),

  projectTimeline: (id: number) =>
    request<{ events: EventRow[] }>(`/api/projects/${id}/timeline`),

  createProject: (body: {
    name: string;
    kind?: ProjectKind;
    description?: string | null;
    watchFor?: string | null;
    owner?: string;
    dueAt?: string | null;
  }) => request<ProjectRow>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),

  updateProject: (
    id: number,
    patch: { name?: string; description?: string | null; watchFor?: string | null; dueAt?: string | null },
  ) => request<ProjectRow>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),

  handoffProject: (id: number, body: { toOwner: string; note?: string }) =>
    request<HandoffResult>(`/api/projects/${id}/handoff`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 接手方确认接手 */
  acceptHandoff: (id: number, note?: string) =>
    request<ProjectRow>(`/api/projects/${id}/accept`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  /** 把责任收回来 */
  reclaimProject: (id: number, note?: string) =>
    request<ProjectRow>(`/api/projects/${id}/reclaim`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  archiveProject: (id: number) =>
    request<ProjectRow>(`/api/projects/${id}/archive`, { method: 'POST' }),

  unarchiveProject: (id: number) =>
    request<ProjectRow>(`/api/projects/${id}/unarchive`, { method: 'POST' }),
};

export function newDeliverableForm(input: {
  itemId: number;
  stageId?: number | null;
  name: string;
  category: DeliverableCategory;
  required: boolean;
  file: File;
  note?: string;
}): FormData {
  const fd = new FormData();
  fd.set('itemId', String(input.itemId));
  if (input.stageId != null) fd.set('stageId', String(input.stageId));
  fd.set('name', input.name);
  fd.set('category', input.category);
  fd.set('required', String(input.required));
  fd.set('file', input.file);
  if (input.note) fd.set('note', input.note);
  return fd;
}
