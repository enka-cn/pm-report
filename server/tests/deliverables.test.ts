import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nowIso, run } from '../src/db/index.ts';
import { loadPipelines } from '../src/domain/pipeline.ts';
import { listTimeline } from '../src/domain/events.ts';
import { createItem, getItem } from '../src/domain/items.ts';
import { advanceStage } from '../src/domain/stages.ts';
import {
  addDeliverable,
  addDeliverableVersion,
  listDeliverables,
  missingRequiredDeliverables,
  setDeliverableRequired,
} from '../src/domain/deliverables.ts';
import { absolutePathOf, relPathOf, sha256Of, storeFile } from '../src/domain/storage.ts';
import { completeStageTodos, freshDb } from './helpers.ts';

const TEMPLATES = loadPipelines();

function freshFilesDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manager-files-'));
}

/** 走一遍完整的落盘流程，返回入库需要的文件元数据 */
function stageFile(text: string, filesDir: string, filename = 'doc.md') {
  const bytes = Buffer.from(text, 'utf8');
  const stored = storeFile(bytes, filesDir);
  return {
    file: {
      sha256: stored.sha256,
      relPath: stored.relPath,
      filename,
      sizeBytes: stored.sizeBytes,
      mime: 'text/markdown',
    },
    stored,
  };
}

test('内容寻址：同一份内容只落一个文件，重复上传自动复用', () => {
  const dir = freshFilesDir();
  const a = storeFile(Buffer.from('架构设计文档 v1'), dir);
  const b = storeFile(Buffer.from('架构设计文档 v1'), dir);

  assert.equal(a.sha256, b.sha256);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true, '第二次上传应复用已有文件');

  const files = fs.readdirSync(path.join(dir, a.sha256.slice(0, 2)));
  assert.equal(files.length, 1, '同一内容不应产生第二个文件');
});

test('落盘路径按 sha256 前两位分片，且不留临时文件', () => {
  const dir = freshFilesDir();
  const stored = storeFile(Buffer.from('日志内容'), dir);

  assert.equal(stored.relPath, relPathOf(stored.sha256));
  assert.equal(stored.relPath.split('/')[0], stored.sha256.slice(0, 2));
  assert.ok(fs.existsSync(absolutePathOf(stored.relPath, dir)));
  assert.equal(
    fs.existsSync(path.join(dir, stored.relPath + '.tmp')),
    false,
    '不该留下临时文件',
  );
});

test('路径穿越被挡住', () => {
  const dir = freshFilesDir();
  assert.throws(() => absolutePathOf('../../windows/win.ini', dir), /非法文件路径/);
  assert.throws(() => absolutePathOf('aa/../../../escape', dir), /非法文件路径/);
  // 正常路径放行
  assert.ok(absolutePathOf('ab/abcdef', dir).startsWith(path.resolve(dir)));
});

test('sha256 计算稳定', () => {
  // 空串的 sha256 是众所周知的常量，用它确认算法没接错
  assert.equal(
    sha256Of(Buffer.from('', 'utf8')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('新建交付物会写 deliverable_added 事件，并出现在需求详情里', () => {
  const dir = freshFilesDir();
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'x', role: 'dev' });
  const s1 = d.stages[0]!;
  const { file } = stageFile('详细设计', dir, '详细设计.md');

  const created = addDeliverable(db, {
    itemId: d.item.id,
    stageId: s1.id,
    name: '详细设计文档',
    category: 'design',
    file,
  });

  assert.equal(created.versions.length, 1);
  assert.equal(created.versions[0]!.version_no, 1);
  assert.equal(created.current_version_id, created.versions[0]!.id, 'current_version 应指向最新版本');

  const types = listTimeline(db, d.item.id).map((e) => e.type);
  assert.ok(types.includes('deliverable_added'));

  const detail = getItem(db, d.item.id)!;
  assert.equal(detail.deliverables.length, 1);
  assert.equal(detail.deliverables[0]!.name, '详细设计文档');
  assert.equal(detail.deliverables[0]!.versions[0]!.original_filename, '详细设计.md');

  db.close();
});

test('同一交付物多次上传形成版本序列，current_version 跟到最新', () => {
  const dir = freshFilesDir();
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'x', role: 'dev' });
  const s1 = d.stages[0]!;

  const first = addDeliverable(db, {
    itemId: d.item.id,
    stageId: s1.id,
    name: '评审材料',
    category: 'review_record',
    file: stageFile('第一版', dir).file,
  });

  const second = addDeliverableVersion(
    db,
    first.id,
    stageFile('第二版，已按意见修改', dir).file,
  );

  assert.equal(second.versions.length, 2);
  assert.deepEqual(
    second.versions.map((v) => v.version_no),
    [2, 1],
    '版本列表应倒序，最新在前',
  );
  assert.equal(second.current_version_id, second.versions[0]!.id);
  assert.equal(second.versions[0]!.note, null);

  // 两个版本指向不同的内容
  assert.notEqual(second.versions[0]!.sha256, second.versions[1]!.sha256);

  db.close();
});

test('必交交付物未上传时推进阶段被拒；上传后放行', () => {
  const dir = freshFilesDir();
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'x', role: 'dev' });
  const s1 = d.stages[0]!;
  completeStageTodos(db, s1.id);

  const { file } = stageFile('SEG 评审记录', dir);
  const required = addDeliverable(db, {
    itemId: d.item.id,
    stageId: s1.id,
    name: 'SEG 评审记录',
    category: 'review_record',
    required: true,
    file,
  });
  const versionId = required.current_version_id!;

  // 模拟「建了必交项但还没上传」：把 current_version 清掉
  run(db, 'UPDATE deliverable SET current_version_id = NULL WHERE id = ?', required.id);
  assert.equal(missingRequiredDeliverables(db, s1.id).length, 1);

  assert.throws(
    () => advanceStage(db, { itemId: d.item.id, stageId: s1.id }),
    /必交交付物未上传（SEG 评审记录）/,
  );
  // 强推可以过，但要写原因
  assert.throws(
    () => advanceStage(db, { itemId: d.item.id, stageId: s1.id, forced: true }),
    /必须填写原因/,
  );

  // 上传后卡点解除
  run(db, 'UPDATE deliverable SET current_version_id = ? WHERE id = ?', versionId, required.id);
  assert.equal(missingRequiredDeliverables(db, s1.id).length, 0);
  const r = advanceStage(db, { itemId: d.item.id, stageId: s1.id });
  assert.equal(r.toStageKey, 'coding');

  db.close();
});

test('过程材料（required=0）不构成卡点', () => {
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'x', role: 'dev' });
  const s1 = d.stages[0]!;
  completeStageTodos(db, s1.id);

  const when = nowIso();
  run(
    db,
    `INSERT INTO deliverable (item_id, stage_id, name, category, required, created_at, updated_at)
     VALUES (?, ?, ?, 'screenshot', 0, ?, ?)`,
    d.item.id,
    s1.id,
    '联调截图',
    when,
    when,
  );

  assert.equal(missingRequiredDeliverables(db, s1.id).length, 0);
  assert.doesNotThrow(() => advanceStage(db, { itemId: d.item.id, stageId: s1.id }));

  db.close();
});

test('可以把已上传的交付物追认为必交项', () => {
  const dir = freshFilesDir();
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'x', role: 'dev' });
  const { file } = stageFile('文档', dir);

  const created = addDeliverable(db, {
    itemId: d.item.id,
    stageId: d.stages[0]!.id,
    name: '设计说明',
    file,
  });
  assert.equal(created.required, 0);

  setDeliverableRequired(db, created.id, true);
  assert.equal(listDeliverables(db, d.item.id)[0]!.required, 1);

  db.close();
});

test('交付物按需求聚合，可按阶段过滤', () => {
  const dir = freshFilesDir();
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'x', role: 'dev' });
  const [s1, s2] = [d.stages[0]!, d.stages[1]!];

  addDeliverable(db, { itemId: d.item.id, stageId: s1.id, name: '甲', file: stageFile('甲', dir).file });
  addDeliverable(db, { itemId: d.item.id, stageId: s2.id, name: '乙', file: stageFile('乙', dir).file });
  addDeliverable(db, { itemId: d.item.id, name: '不挂阶段的丙', file: stageFile('丙', dir).file });

  assert.equal(listDeliverables(db, d.item.id).length, 3);
  assert.deepEqual(
    listDeliverables(db, d.item.id, s1.id).map((x) => x.name),
    ['甲'],
  );
  assert.deepEqual(
    listDeliverables(db, d.item.id, null).map((x) => x.name),
    ['不挂阶段的丙'],
  );

  db.close();
});

test('上传失败不会因为空名称而写进库', () => {
  const dir = freshFilesDir();
  const db = freshDb();
  const d = createItem(db, TEMPLATES, { title: 'x', role: 'dev' });

  assert.throws(
    () => addDeliverable(db, { itemId: d.item.id, name: '   ', file: stageFile('x', dir).file }),
    /名称不能为空/,
  );
  assert.equal(listDeliverables(db, d.item.id).length, 0);

  assert.throws(
    () => addDeliverable(db, { itemId: 99999, name: '不存在需求', file: stageFile('x', dir).file }),
    /需求不存在/,
  );

  db.close();
});
