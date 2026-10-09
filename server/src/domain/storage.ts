import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FILES_DIR } from '../config.ts';

export interface StoredFile {
  sha256: string;
  /** 相对 data/files 的路径，存进 deliverable_version.rel_path */
  relPath: string;
  sizeBytes: number;
  /** true 表示内容已存在、复用了同一份文件（内容寻址的去重） */
  reused: boolean;
}

export function sha256Of(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** sha256 -> 相对路径。<前两位>/<完整 sha>，避免单目录堆几十万个文件。 */
export function relPathOf(sha256: string): string {
  return path.posix.join(sha256.slice(0, 2), sha256);
}

/**
 * 内容寻址落盘：同一份内容永远只存一个文件，重复上传自动去重。
 *
 * 先写临时文件再改名 —— 直接写目标路径的话，中途失败会留下一个半截文件，
 * 但它已经顶着正确的 sha256 文件名，之后永远会被当成完整内容复用。
 */
export function storeFile(bytes: Uint8Array, filesDir: string = FILES_DIR): StoredFile {
  const sha256 = sha256Of(bytes);
  const relPath = relPathOf(sha256);
  const abs = path.join(filesDir, relPath);

  if (fs.existsSync(abs)) {
    return { sha256, relPath, sizeBytes: bytes.byteLength, reused: true };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }

  return { sha256, relPath, sizeBytes: bytes.byteLength, reused: false };
}

/** 解析相对路径为绝对路径，并挡住 `..` 逃出 files 目录 */
export function absolutePathOf(relPath: string, filesDir: string = FILES_DIR): string {
  const root = path.resolve(filesDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`非法文件路径: ${relPath}`);
  }
  return abs;
}

export function fileExists(relPath: string, filesDir: string = FILES_DIR): boolean {
  return fs.existsSync(absolutePathOf(relPath, filesDir));
}

export function readStoredFile(relPath: string, filesDir: string = FILES_DIR): Buffer {
  return fs.readFileSync(absolutePathOf(relPath, filesDir));
}

/** 给人看的体积。大文件是真实存在的（误传的模型包），所以 GB / TB 也要能显示 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export interface StoredFileOnDisk {
  sha256: string;
  abs: string;
  bytes: number;
}

/**
 * 遍历 data/files，列出真正躺在磁盘上的文件。
 *
 * 只看 `<两位十六进制>/<64 位 sha256>` 这个形状 —— 内容是寻址的，
 * 不认识的目录名（比如残留的临时文件）一律不碰。
 */
export function listStoredFiles(filesDir: string = FILES_DIR): StoredFileOnDisk[] {
  if (!fs.existsSync(filesDir)) return [];

  const out: StoredFileOnDisk[] = [];
  for (const shard of fs.readdirSync(filesDir)) {
    const shardDir = path.join(filesDir, shard);
    if (!fs.statSync(shardDir).isDirectory()) continue;

    for (const name of fs.readdirSync(shardDir)) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const abs = path.join(shardDir, name);
      out.push({ sha256: name, abs, bytes: fs.statSync(abs).size });
    }
  }
  return out;
}
