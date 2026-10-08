-- 001_init.sql —— 初始 schema
--
-- 时间表示约定（务必区分）：
--   日期（只有年月日，DDL 语义）: 'YYYY-MM-DD'
--       due_at, planned_start, planned_end, promised_at
--   时刻（ISO 8601，UTC）: 'YYYY-MM-DDTHH:MM:SS.sssZ'
--       created_at, updated_at, occurred_at, actual_start_at, actual_end_at,
--       opened_at, closed_at, suspended_at, done_at, archived_at, finalized_at
--
-- 本文件是 schema 的唯一真相源。已应用的迁移**不要修改**，
-- 迁移运行器会校验 checksum 并在不匹配时报错；要改请新增 002_xxx.sql。

-- ---------------------------------------------------------------------------
-- 项目容器（P1 只有一个隐式默认项目，UI 不暴露；见设计文档 D4）
-- ---------------------------------------------------------------------------
CREATE TABLE project (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  due_at        TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_project_single_default ON project(is_default) WHERE is_default = 1;

-- ---------------------------------------------------------------------------
-- 需求 —— 被跟踪的原子单元
--
-- 注意：这里**没有 status 字段**（设计文档 D2）。
-- 状况由事实投影：closed_at / suspended_at / 未解除的 blocker，见视图 v_item。
-- 角色挂在需求上而不是项目上：同一项目下不同需求角色可以不同。
-- ---------------------------------------------------------------------------
CREATE TABLE item (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  project_id        INTEGER NOT NULL REFERENCES project(id),
  title             TEXT NOT NULL,
  description       TEXT,
  role              TEXT NOT NULL CHECK (role IN ('se', 'dev', 'test', 'maint')),
  criticality       INTEGER NOT NULL DEFAULT 3 CHECK (criticality BETWEEN 1 AND 5),
  due_at            TEXT,
  suspended_at      TEXT,
  suspended_reason  TEXT,
  closed_at         TEXT,
  close_reason      TEXT CHECK (close_reason IN ('done', 'cancelled')),
  priority_override INTEGER,
  owner             TEXT NOT NULL DEFAULT 'me',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE INDEX idx_item_live ON item(closed_at, suspended_at, due_at);

-- ---------------------------------------------------------------------------
-- 阶段 —— 流水线节点
--
-- 同样没有 status 字段（D2）：
--   待开始 = actual_start_at IS NULL AND actual_end_at IS NULL
--   进行中 = actual_start_at IS NOT NULL AND actual_end_at IS NULL
--   已结束 = actual_end_at IS NOT NULL
-- 「同一需求下最多一个进行中的阶段」由下面的部分唯一索引强制，不靠服务层自觉。
-- ---------------------------------------------------------------------------
CREATE TABLE stage (
  id                INTEGER PRIMARY KEY,
  item_id           INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  key               TEXT NOT NULL,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'work'
                    CHECK (kind IN ('work', 'review', 'wait', 'milestone')),
  planned_start     TEXT,
  planned_end       TEXT,
  actual_start_at   TEXT,
  actual_end_at     TEXT,
  outcome           TEXT CHECK (outcome IN ('completed', 'skipped')),
  skip_reason       TEXT,
  suspended_at      TEXT,
  suspended_reason  TEXT,
  wait_counterparty TEXT,
  wait_for          TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (item_id, key),
  UNIQUE (item_id, seq),
  -- outcome 必须有结束时间才成立
  CHECK (outcome IS NULL OR actual_end_at IS NOT NULL),
  -- 跳过时必填原因
  CHECK (outcome IS NULL OR outcome = 'completed' OR skip_reason IS NOT NULL),
  -- kind=wait 必须说明在等谁、等什么，否则自动建不出阻塞单
  CHECK (kind <> 'wait' OR (wait_counterparty IS NOT NULL AND wait_for IS NOT NULL))
);
CREATE INDEX idx_stage_item ON stage(item_id, seq);

CREATE UNIQUE INDEX idx_stage_one_active ON stage(item_id)
  WHERE actual_start_at IS NOT NULL AND actual_end_at IS NULL;

-- ---------------------------------------------------------------------------
-- 待办 —— 阶段的退出标准。勾完不等于阶段完成（D5），推进必须显式确认。
-- ---------------------------------------------------------------------------
CREATE TABLE todo (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  stage_id    INTEGER REFERENCES stage(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  done_at     TEXT,
  due_at      TEXT,
  seq         INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'template')),
  created_at  TEXT NOT NULL,
  CHECK (done = 0 OR done_at IS NOT NULL)
);
CREATE INDEX idx_todo_stage ON todo(stage_id, seq);
CREATE INDEX idx_todo_item ON todo(item_id, done);

-- ---------------------------------------------------------------------------
-- 交付物 —— 文件按 sha256 内容寻址落盘，库里只存元数据
-- required=1 表示这是该阶段的必交项，未上传时推进阶段需要强制确认
-- ---------------------------------------------------------------------------
CREATE TABLE deliverable (
  id                 INTEGER PRIMARY KEY,
  item_id            INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  stage_id           INTEGER REFERENCES stage(id) ON DELETE SET NULL,
  name               TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT 'other'
                     CHECK (category IN ('doc', 'design', 'screenshot', 'log', 'review_record', 'other')),
  required           INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  -- 指向 deliverable_version.id。不建外键：那是循环引用，会让插入顺序变脆。
  current_version_id INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_deliverable_item ON deliverable(item_id);

CREATE TABLE deliverable_version (
  id                INTEGER PRIMARY KEY,
  deliverable_id    INTEGER NOT NULL REFERENCES deliverable(id) ON DELETE CASCADE,
  version_no        INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  rel_path          TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  mime              TEXT,
  note              TEXT,
  uploaded_at       TEXT NOT NULL,
  UNIQUE (deliverable_id, version_no)
);
CREATE INDEX idx_dv_sha ON deliverable_version(sha256);

-- ---------------------------------------------------------------------------
-- 阻塞 —— 一等实体，不是状态旗标（D6）
-- 没有 status 字段：closed_at IS NULL 即未解除
-- ---------------------------------------------------------------------------
CREATE TABLE blocker (
  id           INTEGER PRIMARY KEY,
  item_id      INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  stage_id     INTEGER REFERENCES stage(id) ON DELETE SET NULL,
  direction    TEXT NOT NULL
               CHECK (direction IN ('blocked_by_others', 'blocking_others')),
  counterparty TEXT NOT NULL,
  need         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'medium'
               CHECK (severity IN ('low', 'medium', 'high')),
  opened_at    TEXT NOT NULL,
  promised_at  TEXT,
  closed_at    TEXT,
  resolution   TEXT,
  CHECK (closed_at IS NULL OR resolution IS NOT NULL)
);
CREATE INDEX idx_blocker_open ON blocker(direction, closed_at);
CREATE INDEX idx_blocker_item ON blocker(item_id, closed_at);

-- ---------------------------------------------------------------------------
-- 事件 —— append-only 时间线，唯一真相源（D1）
-- 只允许插入，或仅写 voided_at / void_reason 作废；改删由触发器挡死。
-- ---------------------------------------------------------------------------
CREATE TABLE event (
  id             INTEGER PRIMARY KEY,
  type           TEXT NOT NULL,
  item_id        INTEGER REFERENCES item(id) ON DELETE CASCADE,
  stage_id       INTEGER REFERENCES stage(id) ON DELETE SET NULL,
  deliverable_id INTEGER REFERENCES deliverable(id) ON DELETE SET NULL,
  blocker_id     INTEGER REFERENCES blocker(id) ON DELETE SET NULL,
  payload        TEXT,
  note           TEXT,
  actor          TEXT NOT NULL DEFAULT 'me',
  occurred_at    TEXT NOT NULL,
  voided_at      TEXT,
  void_reason    TEXT
);
CREATE INDEX idx_event_time ON event(occurred_at);
CREATE INDEX idx_event_item ON event(item_id, occurred_at);

CREATE TRIGGER event_append_only_update BEFORE UPDATE ON event
WHEN NEW.type IS NOT OLD.type
  OR NEW.item_id IS NOT OLD.item_id
  OR NEW.stage_id IS NOT OLD.stage_id
  OR NEW.deliverable_id IS NOT OLD.deliverable_id
  OR NEW.blocker_id IS NOT OLD.blocker_id
  OR NEW.payload IS NOT OLD.payload
  OR NEW.note IS NOT OLD.note
  OR NEW.actor IS NOT OLD.actor
  OR NEW.occurred_at IS NOT OLD.occurred_at
BEGIN
  SELECT RAISE(ABORT, 'event 是 append-only：只允许插入，或仅写 voided_at/void_reason 作废');
END;

CREATE TRIGGER event_no_delete BEFORE DELETE ON event
BEGIN
  SELECT RAISE(ABORT, 'event 是 append-only：禁止删除，请用 voided_at 作废');
END;

-- ---------------------------------------------------------------------------
-- 汇报 —— 一次快照。finalized_at 非空即已定稿，其 period_end 成为下次区间起点
-- ---------------------------------------------------------------------------
CREATE TABLE report (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  generated_md  TEXT,
  content_md    TEXT,
  finalized_at  TEXT,
  template_key  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_report_period ON report(period_end);

-- ---------------------------------------------------------------------------
-- 流水线模板（文件系统里的 YAML 是真相源，这里只做缓存/覆盖，P2 用）
-- ---------------------------------------------------------------------------
CREATE TABLE pipeline_template (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT,
  definition  TEXT NOT NULL,
  builtin     INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE tag (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE item_tag (
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 视图 v_item —— 需求的状况是**投影**出来的，不落库（D2）
-- 所有列表/驾驶舱查询都走这个视图，因此不存在“状态字段与事实不同步”的 bug。
-- ---------------------------------------------------------------------------
CREATE VIEW v_item AS
SELECT
  i.*,
  (SELECT s.id FROM stage s
    WHERE s.item_id = i.id
      AND s.actual_start_at IS NOT NULL
      AND s.actual_end_at IS NULL
    LIMIT 1) AS active_stage_id,
  CASE
    WHEN i.closed_at IS NOT NULL THEN 'closed'
    WHEN i.suspended_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM stage s
                  WHERE s.item_id = i.id
                    AND s.actual_start_at IS NOT NULL
                    AND s.actual_end_at IS NULL
                    AND s.suspended_at IS NOT NULL) THEN 'suspended'
    WHEN EXISTS (SELECT 1 FROM blocker b
                  WHERE b.item_id = i.id
                    AND b.direction = 'blocked_by_others'
                    AND b.closed_at IS NULL) THEN 'blocked'
    ELSE 'normal'
  END AS condition
FROM item i;

-- 全文检索（search_fts）留到 P2。真加时必须用 trigram 分词器，不能用默认的
-- unicode61 —— 理由与实测结论见 docs/design.md §4。
