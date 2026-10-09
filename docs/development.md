# 开发说明

面向改代码的人。**用法看 [README](../README.md)**，**改之前必读 [design.md](design.md) 的「核心设计决策」** —— 那几条决定了整个数据模型，绕开它们的改动会让汇报功能失效。

## 目录

| 路径 | 说明 |
|---|---|
| [docs/design.md](design.md) | 设计文档：实体模型、决策与理由、驾驶舱分桶、汇报算法、全文检索实测数据 |
| [config/pipelines/](../config/pipelines/) | 流水线模板（SE / 开发两套），改完重启生效 |
| [config/settings.yaml](../config/settings.yaml) | 驾驶舱窗口与排序权重 |
| [config/report_templates/](../config/report_templates/) | 汇报模板 |
| [server/src/db/migrations/](../server/src/db/migrations/) | **schema 的唯一真相源** |
| [server/src/domain/](../server/src/domain/) | 领域逻辑，**事件写入的唯一入口** |
| [server/src/app.ts](../server/src/app.ts) | 所有 HTTP 路由 |
| [web/src/](../web/src/) | 前端：驾驶舱、需求列表/详情、搜索、项目、汇报、命令面板 |
| [shared/src/index.ts](../shared/src/index.ts) | 前后端共享类型（只导出类型，无运行时代码） |

## 两条硬约定

1. **所有状态变更必须经过 `server/src/domain/`。**
   事件表由数据库触发器强制 append-only：改和删会被拒绝，只有写入 `voided_at` 的作废可行。
   一旦有代码旁路写库，事件日志就不再是完整真相，汇报会开始骗人 ——
   **这个系统一旦撒谎就没有价值。**

2. **已应用的迁移文件不可修改。**
   迁移运行器会校验 checksum 并在不匹配时报错。改 schema 请新增 `00N_xxx.sql`。

## 前端有个 tsc 查不出的坑

**不要把 hook 放在 `if (...) return` 后面。**

组件里常见「加载中 → 提前 return，加载完 → 往下走」的写法。如果 hook 写在那句 return 之后，
首次渲染（加载中）不调用它、第二次渲染调用它，React 就抛 `#310`（渲染的 hook 比上次多），
**整个页面白屏**，而 `pnpm typecheck` 和所有单元测试都不会报错。

这个坑真踩过（`ItemDetail` 的 `useFileDrop`）。所以加了 `useRef` 存回调要用的数据，
hook 一律提到所有提前 return 之上。

改完前端建议真加载一遍所有路由看看有没有白屏 —— 光跑 typecheck 不够。
仓库里有现成的：

```powershell
pnpm build
pnpm start                                   # 另开一个窗口
node scripts/smoke-pages.mjs                 # 默认 http://127.0.0.1:5178
node scripts/smoke-pages.mjs http://127.0.0.1:5179
```

它会自己起一个 headless Edge（用完关掉），逐个路由加载并报告渲染字符数、root 子节点数和控制台异常。
需求 id 是从接口查的，所以换一份数据也能跑。

## 开发模式

```powershell
pnpm install
pnpm dev          # 同时起后端 :5178 和前端 :5173（带热更新）
```

打开 **http://127.0.0.1:5173** —— Vite 会把 `/api` 代理到后端，不用管 CORS。

单地址模式（前端构建产物由后端一并托管）：

```powershell
pnpm build        # 构建前端到 web/dist
pnpm start        # 一个进程、一个地址 :5178
```

其它命令：

```powershell
pnpm migrate      # 只跑迁移
pnpm test         # 152 个测试（领域层 + HTTP 层，不用起端口）
pnpm typecheck    # shared / server / web 三处类型检查
```

服务端**没有构建步骤**：靠 Node 24 的类型剥离直接跑 `.ts`，用内置的 `node:sqlite`。
代价是相对导入必须写全 `.ts` 后缀，纯类型导入必须用 `import type`。

## 拿临时实例试东西

想在**不碰真实数据**的前提下演示、截图、演练，把数据目录指到别处再换个端口：

```powershell
$env:MANAGER_DATA_DIR = 'C:\codes\manager\.scratch-data'
$env:PORT = '5179'
pnpm start
```

`MANAGER_DATA_DIR` 和 `PORT` 都支持环境变量覆盖，`.scratch-data/` 已在 `.gitignore` 里。

## 已实现的接口

服务起来后可以直接拿 `curl` / `Invoke-RestMethod` 试。
**注意 `/api/palette/query` 的参数名是 `q`。**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活与已加载的流水线模板 |
| GET | `/api/meta` | 中文标签映射 + 命令面板帮助文本（前端取这里，不重复定义） |
| GET | `/api/pipelines` | 流水线模板全文 |
| GET | `/api/dashboard` | 驾驶舱分桶 + 摘要计数 + 看护中项目 |
| GET | `/api/items?q=&role=&condition=&includeClosed=&projectId=` | 需求列表（`condition` 来自 `v_item` 视图） |
| POST | `/api/items` | 新建需求，按角色自动实例化流水线与待办（可带 `projectId`） |
| GET | `/api/items/:id` | 详情：`{item, project, stages, todos, blockers, deliverables}` |
| PATCH | `/api/items/:id/due` | 设置整体交付 DDL |
| POST | `/api/items/:id/suspend` · `/resume` · `/close` · `/reopen` | 挂起 / 恢复 / 关闭 / 重开 |
| POST | `/api/items/:id/note` | 记一条进展（支持 `occurredAt` 回填） |
| GET | `/api/items/:id/timeline` | 事件时间线（`?includeVoided=true` 含已作废） |
| PATCH | `/api/stages/:id/due` | 设置阶段 DDL（`plannedStart` / `plannedEnd`） |
| POST | `/api/stages/:id/advance` | 推进阶段 `{outcome, forced, reason, closeBlockers}` |
| POST | `/api/stages/:id/suspend` · `/resume` | 阶段级挂起 / 恢复 |
| POST | `/api/todos` · PATCH `/api/todos/:id` · DELETE | 建待办 / 勾选 / 删除 |
| POST | `/api/blockers` · PATCH `/api/blockers/:id` | 建阻塞 / 解除 |
| GET | `/api/items/:id/deliverables` | 交付物与版本列表 |
| POST | `/api/deliverables` (multipart) | 新建交付物并上传首个版本 |
| POST | `/api/items/:id/deliverables/drop` (multipart) | **拖进来就加入**：多文件、自动命名与分类、同名认版本 |
| POST | `/api/deliverables/:id/versions` (multipart) | 给已有交付物加版本 |
| PATCH | `/api/deliverables/:id` | 改名称 / 类别 / 所在文件夹 / 必交项（只改传了的字段） |
| GET | `/api/items/:id/links` | 需求上的链接 |
| POST | `/api/items/:id/links` | 加链接（只收 http / https） |
| PATCH · DELETE | `/api/links/:id` | 改 / 删链接 |
| GET | `/api/items/:id/tree` | 需求级文件树（`GET /api/items/:id` 里也带一份） |
| POST | `/api/items/:id/folders` | 新建文件夹（带 `parentId` 就是嵌套） |
| PATCH | `/api/folders/:id` | 改名 / 移动（同一个事务，带环检测） |
| DELETE | `/api/folders/:id` | 删文件夹（非空拒绝） |
| DELETE | `/api/deliverables/:id` | 移除交付物（软删除，不动磁盘） |
| POST | `/api/deliverables/:id/restore` | 从「已移除」恢复 |
| GET | `/api/storage` | 磁盘占用与可回收量 |
| POST | `/api/storage/purge` | 回收磁盘（删掉无引用的字节） |

## 为什么「移除」和「回收」是两步

迁移 006 之前，交付物在数据库层面删不掉：`event.deliverable_id` 是 `ON DELETE SET NULL`，
删一行 `deliverable` 会触发「把事件里的引用置空」，而那是一次 `UPDATE event` ——
直接撞上 append-only 触发器。**但那是外键写法造成的事故，不是原则。**

原则只有一条：**事件日志必须 append-only**，它记录「发生过什么」。
它**不蕴含**「文件字节必须永远留着」—— 那是保留策略，两码事。
日志写着「某时刻上传了《设计说明》v2」，即使后来文件被清掉，这句话依然是真的。

所以：`removed_at` 软删除保住日志完整性，字节回收单独一步保住磁盘。
外键一个没动，200G 能收回来，误点也还能撤回。

**改这几个查询时注意 `removed_at IS NULL`**：`listDeliverables`、`listRemovedDeliverables`（反过来）、
`missingRequiredDeliverables`、`folderContents`、`dropDeliverables` 的同名查找、`rebuildSearchIndex`。
漏一处就会出现「移除的东西在某个角落冒出来」。`server/tests/removal.test.ts` 第一条测试专门盯这个。
| GET | `/api/files/:sha256` | 按内容哈希下载 |
| GET | `/api/palette/query?q=&currentItemId=` | 命令面板候选 + 补全上下文 + **人话预览** |
| POST | `/api/palette/execute` | 执行命令（`{input, currentItemId}`） |
| GET | `/api/reports` | 汇报列表 + 可用模板名 |
| POST | `/api/reports/generate` | 生成草稿（区间自动接上一次定稿） |
| GET · PUT · DELETE | `/api/reports/:id` | 读取 / 保存正文 / 删除草稿 |
| POST | `/api/reports/:id/finalize` · `/unfinalize` | 定稿 / 取消定稿 |
| GET | `/api/projects?kind=&includeArchived=` | 项目列表（含子需求数、未解除阻塞数、最近活动） |
| POST | `/api/projects` | 新建项目（看护型必填 `watchFor`） |
| GET | `/api/projects/:id` | 项目详情：说明、子需求、未解除阻塞、最近活动 |
| GET | `/api/projects/:id/timeline` | 项目级事件流 |
| PUT | `/api/projects/:id` | 改名称 / 说明 / 看护条件 / 截止日期 |
| POST | `/api/projects/:id/handoff` | 交接：改负责人 + 把在途子需求、阻塞、看护条件记进事件 |
| POST | `/api/projects/:id/accept` | 接手方确认接手 —— **在这之前它仍留在交出方的看护清单里** |
| POST | `/api/projects/:id/reclaim` | 把责任收回来（没有它，交出去的项目就永远回不来） |
| POST | `/api/projects/:id/archive` · `/unarchive` | 归档 / 取消归档（有在途子需求时拒绝归档） |
| GET | `/api/search?q=&kind=&limit=` | 全文检索（备注 / 待办 / 交付物 / 阻塞 / 项目说明） |
| POST | `/api/search/reindex` | 重建索引（正常用不上，索引漂了时的对账手段） |

## 进度

- [x] **P1 服务端**：schema + 迁移运行器、事件写入服务层、流水线实例化、阶段流转、挂起 / 关闭 / 重开
- [x] **P1 服务端**：驾驶舱七桶分桶与打分、交付物内容寻址上传与版本、需求与阶段 DDL、命令面板、时间线
- [x] **P1 前端**：仪表盘、需求列表与筛选、需求详情、命令面板
- [x] **P2 汇报**：草稿生成（区间自动衔接）、可编辑模板、编辑 / 定稿 / 取消定稿 / 复制
- [x] **P2 项目层**：看护型项目（事件驱动、不进时间桶）、子需求、交接与待接收、收回、归档
- [x] **P2 命令面板**：Tab 补全（命令名 / 需求编号 / 阶段名 / 枚举修饰符）、方向键选择、预览即承诺
- [x] **P2 全文检索**：7 张源表一个索引（FTS5 + trigram）、触发器保证不过期、命中片段高亮、按类别筛选
- [ ] **P3**：git 关联、CLI、docx 导出
