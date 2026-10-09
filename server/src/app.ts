import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  DeliverableCategory,
  PipelineTemplate,
  Role,
  SearchKind,
} from '@manager/shared';
import type { Db } from './db/index.ts';
import { FILES_DIR, WEB_DIST, loadSettings } from './config.ts';
import {
  closeItem,
  createItem,
  getItem,
  listItems,
  noteItem,
  reopenItem,
  resumeItem,
  setItemDueDate,
  suspendItem,
} from './domain/items.ts';
import {
  addTodo,
  advanceStage,
  closeBlocker,
  getStage,
  openBlocker,
  removeTodo,
  resumeStage,
  setStageSchedule,
  setTodoDone,
  suspendStage,
} from './domain/stages.ts';
import { listTimeline } from './domain/events.ts';
import { computeDashboardPayload } from './domain/dashboard.ts';
import {
  addDeliverable,
  addDeliverableVersion,
  dropDeliverables,
  findVersionBySha,
  isDeliverableCategory,
  listDeliverables,
  purgeFiles,
  removeDeliverable,
  renameDeliverable,
  restoreDeliverable,
  setDeliverableCategory,
  setDeliverableRequired,
  storageUsage,
} from './domain/deliverables.ts';
import {
  createFolder,
  deleteFolder,
  folderTree,
  getFolder,
  moveDeliverable,
  updateFolder,
} from './domain/folders.ts';
import { addLink, listLinks, removeLink, updateLink } from './domain/links.ts';
import { absolutePathOf, relPathOf, storeFile } from './domain/storage.ts';
import { meta } from './domain/labels.ts';
import { executePalette, helpText, queryPalette } from './domain/palette.ts';
import {
  deleteReport,
  finalizeReport,
  generateReport,
  getReport,
  listReportTemplates,
  listReports,
  unfinalizeReport,
  updateReport,
} from './domain/reports.ts';
import { SEARCH_KINDS, rebuildSearchIndex, search } from './domain/search.ts';
import {
  acceptHandoff,
  archiveProject,
  createProject,
  getProjectDetail,
  getProject,
  handoffProject,
  listProjects,
  listProjectTimeline,
  reclaimProject,
  unarchiveProject,
  updateProject,
} from './domain/projects.ts';

function asString(v: unknown, field: string, required = true): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`缺少参数 ${field}`);
    return undefined;
  }
  return String(v);
}

function asNumber(v: unknown, field: string, required = true): number | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`缺少参数 ${field}`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数 ${field} 必须是数字`);
  return n;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function optionalString(v: unknown): string | null {
  return v === undefined || v === null || v === '' ? null : String(v);
}

/**
 * 读 JSON 请求体，永远返回一个对象。
 *
 * 直接 `await c.req.json()` 在请求体是字面量 `null`、空串或非法 JSON 时，
 * 会得到 `null` 或抛错，随后 `body['outcome']` 就报
 * "Cannot read properties of null (reading 'outcome')" ——
 * 用户看到的是这种内部错误，而不是「缺少参数」。
 */
async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface AppOptions {
  /** 附件落盘目录。测试传临时目录，免得污染真实 data/files。 */
  filesDir?: string;
}

export function createApp(db: Db, templates: PipelineTemplate[], options: AppOptions = {}) {
  const filesDir = options.filesDir ?? FILES_DIR;
  const app = new Hono();

  // 服务层抛出的都是面向用户的中文说明，本地单人工具直接透出即可
  app.onError((err, c) => c.json({ error: err.message }, 400));

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      pipelines: templates.map((t) => ({ key: t.key, name: t.name, role: t.role, stages: t.stages.length })),
    }),
  );

  app.get('/api/pipelines', (c) => c.json({ pipelines: templates }));

  /** 前端要用的中文标签等元信息，避免前后端各写一份然后漂移 */
  app.get('/api/meta', (c) =>
    c.json({
      ...meta(),
      paletteHelp: helpText(),
      limits: { maxUploadMb: loadSettings().upload.max_request_mb },
    }),
  );

  // ---- 命令面板 ----------------------------------------------------------
  //
  // 语法解析只在服务端做一份（设计文档 D8）：前端面板和将来的 CLI 都调这里，
  // 两套实现迟早会漂移，而且所有操作必须经过服务层，否则事件日志会被绕过。

  app.get('/api/palette/query', (c) => {
    const currentItemId = asNumber(c.req.query('currentItemId'), 'currentItemId', false);
    return c.json(
      queryPalette(db, c.req.query('q') ?? '', { currentItemId: currentItemId ?? null }),
    );
  });

  app.post('/api/palette/execute', async (c) => {
    const body = await readJson(c);
    const currentItemId = asNumber(body['currentItemId'], 'currentItemId', false);
    return c.json(
      executePalette(db, asString(body['input'], 'input')!, { currentItemId: currentItemId ?? null }),
    );
  });

  app.get('/api/dashboard', (c) => c.json(computeDashboardPayload(db)));

  app.get('/api/items', (c) => {
    const items = listItems(db, {
      q: c.req.query('q') ?? undefined,
      role: (c.req.query('role') as Role | undefined) ?? undefined,
      condition: (c.req.query('condition') as never) ?? undefined,
      includeClosed: c.req.query('includeClosed') === 'true',
    });
    return c.json({ items });
  });

  app.post('/api/items', async (c) => {
    const body = await readJson(c);
    const detail = createItem(db, templates, {
      title: asString(body['title'], 'title')!,
      role: asString(body['role'], 'role') as Role,
      description: optionalString(body['description']),
      criticality: asNumber(body['criticality'], 'criticality', false),
      dueAt: optionalString(body['dueAt']),
      pipelineKey: optionalString(body['pipelineKey']),
      projectId: asNumber(body['projectId'], 'projectId', false) ?? null,
    });
    return c.json(detail, 201);
  });

  app.get('/api/items/:id', (c) => {
    const detail = getItem(db, asNumber(c.req.param('id'), 'id')!);
    if (!detail) throw new Error(`需求不存在: ${c.req.param('id')}`);
    return c.json(detail);
  });

  app.get('/api/items/:id/timeline', (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    return c.json({
      events: listTimeline(db, id, {
        includeVoided: c.req.query('includeVoided') === 'true',
      }),
    });
  });

  app.post('/api/items/:id/note', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    const eventId = noteItem(db, id, asString(body['text'], 'text')!, optionalString(body['occurredAt']) ?? undefined);
    return c.json({ eventId }, 201);
  });

  app.patch('/api/items/:id/due', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    setItemDueDate(db, id, optionalString(body['dueAt']));
    return c.json(getItem(db, id));
  });

  app.post('/api/items/:id/suspend', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    suspendItem(db, id, asString(body['reason'], 'reason')!);
    return c.json(getItem(db, id));
  });

  app.post('/api/items/:id/resume', (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    resumeItem(db, id);
    return c.json(getItem(db, id));
  });

  app.post('/api/items/:id/close', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    closeItem(db, id, {
      reason: asString(body['reason'], 'reason') as 'done' | 'cancelled',
      note: asString(body['note'], 'note', false),
      forced: asBool(body['forced']),
    });
    return c.json(getItem(db, id));
  });

  app.post('/api/items/:id/reopen', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    reopenItem(db, id, asString(body['note'], 'note', false));
    return c.json(getItem(db, id));
  });

  // ---- 交付物 ------------------------------------------------------------
  //
  // 文件内容按 sha256 寻址落盘，库里只存元数据；同一份内容重复上传会复用同一个文件。
  // 注意：文件和数据库不在同一个事务里。若写库失败会留下一个孤儿文件 ——
  // 因为它是内容寻址的，下次上传同样内容会被复用，所以无害。

  async function readUploadedFile(
    form: FormData,
  ): Promise<{ bytes: Buffer; filename: string; mime: string | null }> {
    const entry = form.get('file');
    if (!(entry instanceof File)) {
      throw new Error('缺少上传文件：multipart 字段名应为 file');
    }
    return {
      bytes: Buffer.from(await entry.arrayBuffer()),
      filename: entry.name || 'unnamed',
      mime: entry.type || null,
    };
  }

  /** 拖拽上传一次可以带多个文件，字段名 `file`（重复即可） */
  async function readUploadedFiles(
    form: FormData,
  ): Promise<{ bytes: Buffer; filename: string; mime: string | null }[]> {
    const entries = [...form.getAll('file'), ...form.getAll('files')];
    const files = entries.filter((e): e is File => e instanceof File);
    if (files.length === 0) {
      throw new Error('缺少上传文件：multipart 字段名应为 file（可重复）');
    }
    return Promise.all(
      files.map(async (f) => ({
        bytes: Buffer.from(await f.arrayBuffer()),
        filename: f.name || 'unnamed',
        mime: f.type || null,
      })),
    );
  }

  app.get('/api/items/:id/deliverables', (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    return c.json({ deliverables: listDeliverables(db, id) });
  });

  app.post('/api/deliverables', async (c) => {
    assertUploadSize(c);
    const form = await c.req.formData();
    const upload = await readUploadedFile(form);
    const stored = storeFile(upload.bytes, filesDir);

    const created = addDeliverable(db, {
      itemId: asNumber(form.get('itemId'), 'itemId')!,
      stageId: asNumber(form.get('stageId'), 'stageId', false) ?? null,
      name: asString(form.get('name'), 'name', false) ?? upload.filename,
      category: (asString(form.get('category'), 'category', false) as DeliverableCategory) ?? 'other',
      required: asBool(form.get('required')),
      file: {
        sha256: stored.sha256,
        relPath: stored.relPath,
        filename: upload.filename,
        sizeBytes: stored.sizeBytes,
        mime: upload.mime,
        note: asString(form.get('note'), 'note', false) ?? null,
      },
    });

    return c.json({ ...created, deduplicated: stored.reused }, 201);
  });

  /**
   * 拖进来就加入。
   *
   * 与 `/api/deliverables` 的区别：不用先想名字和类别 —— 从文件名推、
   * 同名归到同一条（认作新版本）、内容没变就跳过。详见 dropDeliverables 的注释。
   */
  app.post('/api/items/:id/deliverables/drop', async (c) => {
    assertUploadSize(c);
    const itemId = asNumber(c.req.param('id'), 'id')!;
    const form = await c.req.formData();
    const stageId = asNumber(form.get('stageId'), 'stageId', false) ?? null;
    const folderId = asNumber(form.get('folderId'), 'folderId', false) ?? null;

    const uploads = await readUploadedFiles(form);
    const files = uploads.map((upload) => {
      const stored = storeFile(upload.bytes, filesDir);
      return {
        sha256: stored.sha256,
        relPath: stored.relPath,
        filename: upload.filename,
        sizeBytes: stored.sizeBytes,
        mime: upload.mime,
      };
    });

    return c.json({ results: dropDeliverables(db, { itemId, stageId, folderId, files }) }, 201);
  });

  app.post('/api/deliverables/:id/versions', async (c) => {
    assertUploadSize(c);
    const id = asNumber(c.req.param('id'), 'id')!;
    const form = await c.req.formData();
    const upload = await readUploadedFile(form);
    const stored = storeFile(upload.bytes, filesDir);

    const updated = addDeliverableVersion(db, id, {
      sha256: stored.sha256,
      relPath: stored.relPath,
      filename: upload.filename,
      sizeBytes: stored.sizeBytes,
      mime: upload.mime,
      note: asString(form.get('note'), 'note', false) ?? null,
    });

    return c.json({ ...updated, deduplicated: stored.reused }, 201);
  });

  app.patch('/api/deliverables/:id', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);

    // 只在字段真的传了的时候才改。原来无条件 setDeliverableRequired(asBool(undefined))
    // 意味着「只改类别」会把必交项顺手取消掉。
    if (body['required'] !== undefined) {
      setDeliverableRequired(db, id, asBool(body['required']));
    }
    if (body['category'] !== undefined) {
      if (!isDeliverableCategory(body['category'])) {
        throw new Error(`交付物类别不合法: ${String(body['category'])}`);
      }
      setDeliverableCategory(db, id, body['category']);
    }
    if (body['folderId'] !== undefined) {
      moveDeliverable(db, id, asNumber(body['folderId'], 'folderId', false) ?? null);
    }
    if (body['name'] !== undefined) {
      renameDeliverable(db, id, asString(body['name'], 'name')!);
    }
    return c.json({ ok: true });
  });

  app.get('/api/files/:sha256', (c) => {
    const sha = c.req.param('sha256');
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`不是合法的 sha256: ${sha}`);

    const abs = absolutePathOf(relPathOf(sha), filesDir);
    if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${sha}`);

    const version = findVersionBySha(db, sha);
    const filename = version?.original_filename ?? sha;
    const bytes = fs.readFileSync(abs);

    return new Response(bytes, {
      headers: {
        'Content-Type': version?.mime ?? 'application/octet-stream',
        // RFC 5987：中文文件名必须走 filename*，否则头里会出现乱码或被截断
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  });

  // ---- 阶段 --------------------------------------------------------------

  app.patch('/api/stages/:stageId/due', async (c) => {
    const stageId = asNumber(c.req.param('stageId'), 'stageId')!;
    const body = await readJson(c);
    const stage = setStageSchedule(db, stageId, {
      plannedStart:
        body['plannedStart'] === undefined ? undefined : (optionalString(body['plannedStart']) ?? null),
      plannedEnd:
        body['plannedEnd'] === undefined ? undefined : (optionalString(body['plannedEnd']) ?? null),
    });
    return c.json({ stage, item: getItem(db, stage.item_id) });
  });

  app.post('/api/stages/:stageId/advance', async (c) => {
    const stageId = asNumber(c.req.param('stageId'), 'stageId')!;
    const stage = getStage(db, stageId);
    if (!stage) throw new Error(`阶段不存在: ${stageId}`);
    const body = await readJson(c);

    const result = advanceStage(db, {
      itemId: stage.item_id,
      stageId,
      outcome: (body['outcome'] as 'completed' | 'skipped' | undefined) ?? 'completed',
      skipReason: asString(body['skipReason'], 'skipReason', false),
      forced: asBool(body['forced']),
      reason: asString(body['reason'], 'reason', false),
      closeBlockers: body['closeBlockers'] === undefined ? true : asBool(body['closeBlockers']),
    });
    // 返回形状与 GET /api/items/:id 一致（item/stages/todos/blockers），
    // 额外的 result 只是这次操作的元信息 —— 调用方不需要记两套形状。
    return c.json({ result, ...getItem(db, result.itemId)! });
  });

  app.post('/api/stages/:stageId/suspend', async (c) => {
    const stageId = asNumber(c.req.param('stageId'), 'stageId')!;
    const body = await readJson(c);
    suspendStage(db, stageId, asString(body['reason'], 'reason')!);
    const stage = getStage(db, stageId)!;
    return c.json(getItem(db, stage.item_id));
  });

  app.post('/api/stages/:stageId/resume', (c) => {
    const stageId = asNumber(c.req.param('stageId'), 'stageId')!;
    resumeStage(db, stageId);
    const stage = getStage(db, stageId)!;
    return c.json(getItem(db, stage.item_id));
  });

  // ---- 待办 --------------------------------------------------------------

  app.post('/api/todos', async (c) => {
    const body = await readJson(c);
    const todo = addTodo(db, {
      itemId: asNumber(body['itemId'], 'itemId')!,
      stageId: asNumber(body['stageId'], 'stageId', false) ?? null,
      text: asString(body['text'], 'text')!,
      dueAt: optionalString(body['dueAt']),
    });
    return c.json(todo, 201);
  });

  app.patch('/api/todos/:id', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    return c.json(setTodoDone(db, id, asBool(body['done'])));
  });

  app.delete('/api/todos/:id', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    const removed = removeTodo(db, id, asString(body['reason'], 'reason', false));
    return c.json({ ok: true, text: removed.text });
  });

  // ---- 阻塞 --------------------------------------------------------------

  app.post('/api/blockers', async (c) => {
    const body = await readJson(c);
    const blockerId = openBlocker(db, {
      itemId: asNumber(body['itemId'], 'itemId')!,
      stageId: asNumber(body['stageId'], 'stageId', false) ?? null,
      direction: asString(body['direction'], 'direction') as never,
      counterparty: asString(body['counterparty'], 'counterparty')!,
      need: asString(body['need'], 'need')!,
      severity: (asString(body['severity'], 'severity', false) as never) ?? 'medium',
      promisedAt: optionalString(body['promisedAt']),
    });
    return c.json({ blockerId }, 201);
  });

  app.patch('/api/blockers/:id', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    closeBlocker(db, id, asString(body['resolution'], 'resolution')!);
    return c.json({ ok: true });
  });

  // ---- 汇报 --------------------------------------------------------------
  //
  // 草稿不是让你重新回忆，而是按区间查一遍事件再套模板（事件日志是唯一真相源，
  // 见设计文档 D1）。定稿后它的 period_end 成为下一次生成的区间起点。

  app.get('/api/reports', (c) =>
    c.json({ reports: listReports(db), templates: listReportTemplates() }),
  );

  app.post('/api/reports/generate', async (c) => {
    const body = await readJson(c);
    return c.json(
      generateReport(db, {
        templateKey: asString(body['templateKey'], 'templateKey', false),
        periodStart: asString(body['periodStart'], 'periodStart', false),
        periodEnd: asString(body['periodEnd'], 'periodEnd', false),
      }),
      201,
    );
  });

  app.get('/api/reports/:id', (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const report = getReport(db, id);
    if (!report) throw new Error(`汇报不存在: ${id}`);
    return c.json(report);
  });

  app.put('/api/reports/:id', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    return c.json(
      updateReport(db, id, {
        contentMd: asString(body['contentMd'], 'contentMd', false),
        title: asString(body['title'], 'title', false),
      }),
    );
  });

  app.post('/api/reports/:id/finalize', (c) =>
    c.json(finalizeReport(db, asNumber(c.req.param('id'), 'id')!)),
  );

  app.post('/api/reports/:id/unfinalize', (c) =>
    c.json(unfinalizeReport(db, asNumber(c.req.param('id'), 'id')!)),
  );

  app.delete('/api/reports/:id', (c) => {
    deleteReport(db, asNumber(c.req.param('id'), 'id')!);
    return c.json({ ok: true });
  });

  // ---- 项目 --------------------------------------------------------------
  //
  // P1 里项目只是隐式的默认容器（见设计文档 D4）。这里把它露出来，
  // 是为了装下 §13.1 的看护型项目：长期持有、事件驱动、要交接出去。

  app.get('/api/projects', (c) =>
    c.json({
      projects: listProjects(db, {
        kind: (c.req.query('kind') as 'delivery' | 'caretaking' | undefined) ?? undefined,
        includeArchived: c.req.query('includeArchived') === 'true',
        includeDefault: c.req.query('includeDefault') === 'true',
      }),
    }),
  );

  app.post('/api/projects', async (c) => {
    const body = await readJson(c);
    return c.json(
      createProject(db, {
        name: asString(body['name'], 'name')!,
        kind: (asString(body['kind'], 'kind', false) as 'delivery' | 'caretaking') ?? 'delivery',
        description: optionalString(body['description']),
        watchFor: optionalString(body['watchFor']),
        owner: asString(body['owner'], 'owner', false),
        dueAt: optionalString(body['dueAt']),
      }),
      201,
    );
  });

  app.get('/api/projects/:id', (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const detail = getProjectDetail(db, id);
    if (!detail) throw new Error(`项目不存在: ${id}`);
    return c.json(detail);
  });

  app.get('/api/projects/:id/timeline', (c) =>
    c.json({ events: listProjectTimeline(db, asNumber(c.req.param('id'), 'id')!) }),
  );

  app.put('/api/projects/:id', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    return c.json(
      updateProject(db, id, {
        name: asString(body['name'], 'name', false),
        description:
          body['description'] === undefined ? undefined : optionalString(body['description']),
        watchFor: body['watchFor'] === undefined ? undefined : optionalString(body['watchFor']),
        dueAt: body['dueAt'] === undefined ? undefined : optionalString(body['dueAt']),
      }),
    );
  });

  app.post('/api/projects/:id/handoff', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    const result = handoffProject(db, {
      projectId: id,
      toOwner: asString(body['toOwner'], 'toOwner')!,
      note: asString(body['note'], 'note', false),
    });
    return c.json(result);
  });

  /** 接手方确认接手 —— 到这一刻交出方才能真正划掉它 */
  app.post('/api/projects/:id/accept', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    return c.json(acceptHandoff(db, id, asString(body['note'], 'note', false)));
  });

  /** 把责任收回来（没有它，交出去的项目就永远回不来） */
  app.post('/api/projects/:id/reclaim', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    return c.json(reclaimProject(db, id, asString(body['note'], 'note', false)));
  });

  app.post('/api/projects/:id/archive', (c) =>
    c.json(archiveProject(db, asNumber(c.req.param('id'), 'id')!)),
  );

  app.post('/api/projects/:id/unarchive', (c) =>
    c.json(unarchiveProject(db, asNumber(c.req.param('id'), 'id')!)),
  );

  // ---- 全文检索 ----------------------------------------------------------

  app.get('/api/search', (c) => {
    const kind = c.req.query('kind');
    if (kind && !(SEARCH_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`kind 只能是 ${SEARCH_KINDS.join(' / ')}`);
    }
    return c.json(
      search(db, c.req.query('q') ?? '', {
        kind: (kind as SearchKind | undefined) ?? null,
        limit: asNumber(c.req.query('limit'), 'limit', false),
      }),
    );
  });

  /** 重建索引。正常用不上（触发器保证同步），是索引漂了时的对账手段。 */
  app.post('/api/search/reindex', (c) => {
    const indexed = rebuildSearchIndex(db);
    return c.json({ ok: true, indexed });
  });

  /**
   * 上传前的闸门：**在解析 multipart 之前**按 Content-Length 挡掉超大请求。
   *
   * 必须在这儿挡。`c.req.formData()` 会把整个请求体读进内存，
   * 等解析完再检查大小已经晚了 —— 那是 OOM，不是报错。
   */
  function assertUploadSize(c: Context): void {
    const declared = Number(c.req.header('content-length') ?? '0');
    const limit = loadSettings().upload.max_request_mb * 1024 * 1024;
    if (declared > limit) {
      const mb = (declared / 1024 / 1024).toFixed(1);
      throw new Error(
        `这次上传 ${mb} MB，超过了 ${loadSettings().upload.max_request_mb} MB 的上限。` +
          `这个系统是放文档、截图、日志的；上百 G 的东西放共享盘，然后在需求的「链接」里加个入口。` +
          `确实需要放宽就改 config/settings.yaml 的 upload.max_request_mb。`,
      );
    }
  }

  // ---- 需求链接 ----------------------------------------------------------

  app.get('/api/items/:id/links', (c) =>
    c.json({ links: listLinks(db, asNumber(c.req.param('id'), 'id')!) }),
  );

  app.post('/api/items/:id/links', async (c) => {
    const itemId = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    return c.json(
      addLink(db, {
        itemId,
        url: asString(body['url'], 'url')!,
        label: asString(body['label'], 'label', false),
      }),
      201,
    );
  });

  app.patch('/api/links/:id', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    return c.json(
      updateLink(db, id, {
        label: asString(body['label'], 'label', false),
        url: asString(body['url'], 'url', false),
      }),
    );
  });

  app.delete('/api/links/:id', (c) => {
    removeLink(db, asNumber(c.req.param('id'), 'id')!);
    return c.json({ ok: true });
  });

  // ---- 交付物文件夹 ------------------------------------------------------

  app.get('/api/items/:id/tree', (c) =>
    c.json({ tree: folderTree(db, asNumber(c.req.param('id'), 'id')!) }),
  );

  app.post('/api/items/:id/folders', async (c) => {
    const itemId = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    return c.json(
      createFolder(db, {
        itemId,
        parentId: asNumber(body['parentId'], 'parentId', false) ?? null,
        name: asString(body['name'], 'name')!,
      }),
      201,
    );
  });

  app.patch('/api/folders/:id', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    return c.json(
      updateFolder(db, id, {
        name: asString(body['name'], 'name', false),
        parentId:
          body['parentId'] === undefined
            ? undefined
            : (asNumber(body['parentId'], 'parentId', false) ?? null),
      }),
    );
  });

  app.delete('/api/folders/:id', (c) => {
    deleteFolder(db, asNumber(c.req.param('id'), 'id')!);
    return c.json({ ok: true });
  });

  // ---- 移除交付物与回收磁盘 ----------------------------------------------

  /**
   * 移除交付物（软删除）。
   *
   * 只是让它从各处消失，磁盘上的字节还在 —— 字节的回收是 `/api/storage/purge`。
   * 分开是为了让「误点」可挽回，而 200G 一样能收回来。
   */
  app.delete('/api/deliverables/:id', async (c) => {
    const id = asNumber(c.req.param('id'), 'id')!;
    const body = await readJson(c);
    removeDeliverable(db, id, asString(body['reason'], 'reason', false));
    return c.json({ ok: true });
  });

  app.post('/api/deliverables/:id/restore', (c) => {
    restoreDeliverable(db, asNumber(c.req.param('id'), 'id')!);
    return c.json({ ok: true });
  });

  app.get('/api/storage', (c) => c.json(storageUsage(db, filesDir)));

  /** 回收磁盘：删掉没有任何在册交付物引用的字节 */
  app.post('/api/storage/purge', (c) => c.json(purgeFiles(db, filesDir)));

  // ---- 前端产物 ----------------------------------------------------------
  //
  // 前端用 hash 路由（#/items/1），所以浏览器只会请求 / 和 /assets/*，
  // 不需要 SPA 深路径回退。构建过前端时一个地址就能同时提供界面和接口。

  const indexHtml = path.join(WEB_DIST, 'index.html');
  if (fs.existsSync(indexHtml)) {
    const root = path.relative(process.cwd(), WEB_DIST) || '.';
    const staticMw = serveStatic({ root });
    app.use('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) return next();
      return staticMw(c, next);
    });
  }

  return app;
}
