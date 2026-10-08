import { serve } from '@hono/node-server';
import { DB_PATH } from './config.ts';
import { openDb } from './db/index.ts';
import { migrate, orphanMigrations } from './db/migrate.ts';
import { loadPipelines } from './domain/pipeline.ts';
import { createApp } from './app.ts';

const PORT = Number(process.env['PORT'] ?? 5178);
const HOST = process.env['HOST'] ?? '127.0.0.1';

const db = openDb();
const applied = migrate(db);
const templates = loadPipelines();
const app = createApp(db, templates);

for (const m of applied) console.log(`已应用迁移: ${m.name}`);
const orphans = orphanMigrations(db);
if (orphans.length > 0) {
  console.warn(`警告：以下迁移已应用但源文件不存在 —— ${orphans.join(', ')}`);
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log('');
  console.log(`  项目管理服务已启动`);
  console.log(`  地址   http://${HOST}:${info.port}`);
  console.log(`  数据库 ${DB_PATH}`);
  console.log(`  模板   ${templates.map((t) => t.key).join(', ')}`);
  console.log('');
});

function shutdown() {
  try {
    db.close();
  } catch {
    /* 关不上也无所谓，进程马上退出 */
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
