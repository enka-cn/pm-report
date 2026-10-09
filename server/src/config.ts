import path from 'node:path';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** 仓库根目录（server/src/config.ts -> ../..） */
export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const PIPELINES_DIR = path.join(CONFIG_DIR, 'pipelines');
export const REPORT_TEMPLATES_DIR = path.join(CONFIG_DIR, 'report_templates');
/**
 * 运行时数据目录。可以用 `MANAGER_DATA_DIR` 指到别处 ——
 * 起一个临时实例来试东西时就靠它，免得污染真实数据（演示、截图、演练都用得上）。
 */
export const DATA_DIR = process.env['MANAGER_DATA_DIR'] ?? path.join(ROOT, 'data');
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const DB_PATH = path.join(DATA_DIR, 'manager.db');
/** 前端构建产物。存在时服务端会一并托管，这样一个地址就够用。 */
export const WEB_DIST = path.join(ROOT, 'web', 'dist');

export interface Settings {
  dashboard: {
    due_soon_days: number;
    stale_days: number;
    lookahead_days: number;
  };
  scoring: {
    horizon_days: number;
    weights: {
      urgency: number;
      criticality: number;
      blocker_age: number;
      downstream: number;
      stale: number;
    };
  };
  report: {
    default_days: number;
  };
  item: {
    default_criticality: number;
    code_prefix: string;
  };
  upload: {
    /**
     * 一次上传的总量上限（MB）。
     *
     * 不只是「产品定位」问题（这个系统是放文档/截图/日志的），
     * 更是因为 multipart 解析会把整个请求读进内存 —— 不设上限就是等着 OOM。
     */
    max_request_mb: number;
  };
}

const DEFAULT_SETTINGS: Settings = {
  dashboard: { due_soon_days: 3, stale_days: 7, lookahead_days: 7 },
  scoring: {
    horizon_days: 14,
    weights: {
      urgency: 0.4,
      criticality: 0.2,
      blocker_age: 0.2,
      downstream: 0.15,
      stale: 0.05,
    },
  },
  report: { default_days: 7 },
  item: { default_criticality: 3, code_prefix: 'REQ' },
  upload: { max_request_mb: 512 },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 浅合并两层，缺项退回默认值 —— settings.yaml 允许只写想改的项 */
function merge<T>(base: T, override: unknown): T {
  if (!isRecord(override) || !isRecord(base)) return (override ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const b = (base as Record<string, unknown>)[k];
    out[k] = isRecord(b) && isRecord(v) ? merge(b, v) : v;
  }
  return out as T;
}

let cached: Settings | null = null;

export function loadSettings(reload = false): Settings {
  if (cached && !reload) return cached;
  const file = path.join(CONFIG_DIR, 'settings.yaml');
  if (!fs.existsSync(file)) {
    cached = DEFAULT_SETTINGS;
    return cached;
  }
  const parsed: unknown = parseYaml(fs.readFileSync(file, 'utf8'));
  cached = merge(DEFAULT_SETTINGS, parsed);
  return cached;
}
