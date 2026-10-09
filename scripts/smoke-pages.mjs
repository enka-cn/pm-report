// 页面巡检：逐个路由真加载一遍，看有没有渲染异常。
//
// 为什么需要它：**条件 hook**（把 hook 写在 `if (...) return` 后面）会让 React 抛 #310，
// 整个页面白屏 —— 而 `pnpm typecheck` 和所有单元测试都查不出来。真踩过一次。
//
// 用法（会自己起一个 headless Edge，用完关掉）：
//   node scripts/smoke-pages.mjs                       # 默认 http://127.0.0.1:5178
//   node scripts/smoke-pages.mjs http://127.0.0.1:5179
//
// 前置：服务已经在跑，而且**已经 pnpm build 过**（巡检查的是构建产物）。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9333;
const BASE = (process.argv[2] ?? 'http://127.0.0.1:5178').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Edge / Chrome 的常见位置。装了别的就在这儿加一条。 */
function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`找不到浏览器，请在 findBrowser() 里加上你的路径`);
  return found;
}

/**
 * 路由清单。
 *
 * 只列**不依赖具体数据**的页面 + 需求详情 —— 需求 id 用接口查出来，
 * 这样换一台机器、换一份数据也能跑。
 */
async function routesToVisit() {
  const routes = ['#/', '#/items', '#/search', '#/search/鉴权', '#/projects', '#/reports'];
  try {
    const items = await (await fetch(`${BASE}/api/items?includeClosed=true`)).json();
    if (items.items?.[0]) {
      routes.push(`#/items/${items.items[0].id}`);
      const stages = await (await fetch(`${BASE}/api/items/${items.items[0].id}`)).json();
      if (stages.stages?.[1]) routes.push(`#/items/${items.items[0].id}/${stages.stages[1].id}`);
    }
    const reports = await (await fetch(`${BASE}/api/reports`)).json();
    if (reports.reports?.[0]) routes.push(`#/reports/${reports.reports[0].id}`);
  } catch {
    console.log('（拿不到数据，只巡检静态路由）');
  }
  return routes;
}

const profile = mkdtempSync(join(tmpdir(), 'smoke-'));
const browser = spawn(
  findBrowser(),
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

let ws;
let nextId = 1;
const pending = new Map();
let errors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', rej, { once: true });
        });
        ws.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data);
          if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            errors.push((d.exception?.description ?? d.text).split('\n')[0]);
          }
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            errors.push(m.params.args.map((a) => a.value ?? a.description).join(' ').split('\n')[0]);
          }
          const slot = pending.get(m.id);
          if (slot) {
            pending.delete(m.id);
            m.error ? slot.rej(new Error(JSON.stringify(m.error))) : slot.res(m.result);
          }
        });
        return;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('浏览器起来了但找不到可调试的页面');
}

async function cleanup() {
  try {
    ws?.close();
  } catch {
    /* 无所谓 */
  }
  browser.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔删不掉，不重要 */
  }
}

let bad = 0;
try {
  await connect();
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  const routes = await routesToVisit();
  console.log(`巡检 ${BASE} 的 ${routes.length} 个路由\n`);

  for (const route of routes) {
    errors = [];
    // 必须先离开当前文档：只改 hash 的导航不会重新加载页面，会一直跑旧代码
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(250);
    await send('Page.navigate', { url: `${BASE}/${route}` });
    await sleep(2600);

    const raw = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        len: document.body.innerText.length,
        root: document.getElementById('root')?.children.length ?? -1,
      })`,
      returnByValue: true,
    });
    const info = JSON.parse(raw.result.value);

    // 阈值放宽：列表页刚加载时内容少是正常的，重点是「有没有渲染出来」和「有没有异常」
    const ok = info.root > 0 && info.len > 60 && errors.length === 0;
    if (!ok) bad++;
    console.log(
      `${ok ? 'OK  ' : '挂了'} ${route.padEnd(22)} 渲染 ${String(info.len).padStart(5)} 字符  root ${info.root}` +
        (errors.length ? `  异常: ${errors[0]}` : ''),
    );
  }

  console.log(`\n${routes.length - bad}/${routes.length} 个页面正常`);
} finally {
  await cleanup();
}

process.exit(bad === 0 ? 0 : 1);
