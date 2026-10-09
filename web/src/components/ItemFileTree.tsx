import { useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeliverableWithVersions, FolderNode, ItemDetail as ItemData } from '@manager/shared';
import { api } from '../api';
import { humanSize } from '../lib/format';
import { useMeta } from '../lib/meta';
import { messageOf, useNotice } from '../lib/notice';
import { beginDeliverableDrag, deliverableIdOf, isDeliverableDrag } from '../lib/drop';
import { fmtTime } from '../lib/format';
import { btnGhost, btnPrimary, inputCls } from './ui';

type Act = <T>(fn: () => Promise<T>, success?: (r: T) => string) => Promise<void>;

type Target = number | 'root';

/**
 * 需求级文件树。
 *
 * 和「阶段」是两个正交的轴：阶段是流程位置（由流水线推进，决定卡点），
 * 文件夹是你自己怎么归置（随时可改，不影响任何流程判断）。所以这里能移动文件，
 * 但看不到也不改阶段的任何东西 —— 每行会标出它属于哪个阶段，仅此而已。
 */
export function ItemFileTree({ detail, act }: { detail: ItemData; act: Act }) {
  const meta = useMeta();
  const notice = useNotice();

  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  /** 正在哪个文件夹里新建子文件夹：'root' = 根层，null = 没在新建 */
  const [creatingIn, setCreatingIn] = useState<Target | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<number | null>(null);
  const [renamingFile, setRenamingFile] = useState<number | null>(null);
  const [hover, setHover] = useState<Target | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const total = countFiles(detail.tree);

  function toggle(id: number): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run<T>(fn: () => Promise<T>, ok: string): Promise<void> {
    try {
      await fn();
      await act(async () => undefined);
      notice.ok(ok);
    } catch (err) {
      notice.fail(messageOf(err));
    }
  }

  /**
   * 内部拖动（把已有交付物拖进文件夹）。
   *
   * 只认 `isDeliverableDrag` —— 从资源管理器拖进来的文件交给页面级的文件拖放处理器，
   * 两边靠 dataTransfer.types 区分，不会打架。
   */
  function dragTargetProps(target: Target) {
    return {
      onDragOver(e: DragEvent) {
        if (!isDeliverableDrag(e)) return;
        e.preventDefault();
        // 必须停掉冒泡：嵌套的文件夹会依次触发 dragover，不停的话外层的会覆盖内层的高亮
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setHover(target);
      },
      onDragLeave(e: DragEvent) {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setHover((h) => (h === target ? null : h));
      },
      onDrop(e: DragEvent) {
        if (!isDeliverableDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setHover(null);
        const id = deliverableIdOf(e);
        if (id === null) return;
        void run(
          () => api.moveDeliverable(id, target === 'root' ? null : target),
          target === 'root' ? '已移到根目录' : '已移入文件夹',
        );
      },
    };
  }

  function renderFiles(files: DeliverableWithVersions[], depth: number): ReactNode {
    return (
      <ul className="space-y-px">
        {files.map((d) => {
          const current = d.versions.find((v) => v.id === d.current_version_id) ?? d.versions[0];
          const stage = detail.stages.find((s) => s.id === d.stage_id)?.name;

          return (
            <li
              key={d.id}
              draggable
              onDragStart={(e) => beginDeliverableDrag(e, d.id)}
              title="拖动可以移进别的文件夹"
              className="group flex flex-wrap items-baseline gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/40"
              style={{ paddingLeft: depth * 16 + 6 }}
            >
              <span className="text-zinc-600">·</span>

              {renamingFile === d.id ? (
                <InlineInput
                  initial={d.name}
                  onCancel={() => setRenamingFile(null)}
                  onConfirm={(value) => {
                    setRenamingFile(null);
                    void run(() => api.renameDeliverable(d.id, value), `已改名为「${value}」`);
                  }}
                />
              ) : (
                <button
                  type="button"
                  onDoubleClick={() => setRenamingFile(d.id)}
                  title="双击改名"
                  className="max-w-[26rem] truncate text-sm text-zinc-200"
                >
                  {d.name}
                </button>
              )}

              {d.required === 1 && <span className="text-[10px] text-amber-300">必交</span>}
              <span className="text-[10px] text-zinc-500">
                {meta.data?.categories[d.category] ?? d.category}
              </span>
              {stage && <span className="text-[10px] text-zinc-600">阶段：{stage}</span>}

              {current && (
                <a
                  href={`/api/files/${current.sha256}`}
                  className="text-[10px] text-sky-400 hover:text-sky-300"
                >
                  {current.original_filename}
                </a>
              )}

              {/* 体积要看得见：误传一个大文件时，就是靠这一列找到它的 */}
              <span className="text-[10px] text-zinc-600">
                {current ? humanSize(current.size_bytes) : '—'}
              </span>

              <span className="ml-auto flex shrink-0 items-center gap-2">
                <span className="text-[10px] text-zinc-600">{d.versions.length} 版</span>
                <button
                  type="button"
                  title="移除（记录和文件分开处理：这一步不动磁盘，可在下方「已移除」里恢复）"
                  onClick={() => {
                    const reason = window.prompt(
                      `移除「${d.name}」？\n\n它只是从各处消失，磁盘上的文件还在 —— 真正回收空间要点面板底部的「回收磁盘」，在那之前都可以恢复。\n\n（可以写个原因，会记进事件日志）`,
                      '',
                    );
                    if (reason === null) return;
                    void run(
                      () => api.removeDeliverable(d.id, reason || undefined),
                      `已移除「${d.name}」`,
                    );
                  }}
                  className="text-[10px] text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-rose-400"
                >
                  移除
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  function renderNode(node: FolderNode, depth: number): ReactNode {
    // 根节点是虚的，只往下渲染
    if (node.folder === null) {
      return (
        <>
          {renderFiles(node.files, depth)}
          {node.children.map((child) => renderNode(child, depth))}
        </>
      );
    }

    const folder = node.folder;
    const isCollapsed = collapsed.has(folder.id);
    const inside = countFiles(node);

    return (
      // 标记和拖放处理器放在**外层**：这样拖到文件夹里面的文件上也算拖进这个文件夹。
      // 只标记文件夹那一行的话，往它内部的文件上拖会一路冒到根目录去。
      <div key={folder.id} data-drop-folder={folder.id} {...dragTargetProps(folder.id)}>
        <div
          className={`group flex items-center gap-2 rounded px-1 py-1 ${
            hover === folder.id ? 'bg-sky-500/10 ring-1 ring-sky-400/60' : 'hover:bg-zinc-800/40'
          }`}
          style={{ paddingLeft: depth * 16 + 4 }}
        >
          <button
            type="button"
            onClick={() => toggle(folder.id)}
            className="w-3 shrink-0 text-xs text-zinc-500"
          >
            {isCollapsed ? '▸' : '▾'}
          </button>

          {renamingFolder === folder.id ? (
            <InlineInput
              initial={folder.name}
              onCancel={() => setRenamingFolder(null)}
              onConfirm={(value) => {
                setRenamingFolder(null);
                void run(() => api.updateFolder(folder.id, { name: value }), `已改名为「${value}」`);
              }}
            />
          ) : (
            <button
              type="button"
              onDoubleClick={() => setRenamingFolder(folder.id)}
              title="双击改名"
              className="text-sm text-zinc-200"
            >
              {folder.name}
            </button>
          )}

          <span className="text-[10px] text-zinc-600">{inside} 个</span>

          <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] opacity-0 group-hover:opacity-100">
            <button
              type="button"
              className="text-zinc-500 hover:text-zinc-300"
              onClick={() => setCreatingIn(folder.id)}
            >
              ＋ 子文件夹
            </button>
            <button
              type="button"
              className="text-zinc-500 hover:text-zinc-300"
              onClick={() => setRenamingFolder(folder.id)}
            >
              重命名
            </button>
            <button
              type="button"
              className="text-zinc-600 hover:text-rose-400"
              onClick={() =>
                void run(() => api.deleteFolder(folder.id), `已删除文件夹「${folder.name}」`)
              }
            >
              删除
            </button>
          </span>
        </div>

        {!isCollapsed && (
          <div>
            {creatingIn === folder.id && (
              <NewFolderInput
                depth={depth + 1}
                onCancel={() => setCreatingIn(null)}
                onConfirm={(value) => {
                  setCreatingIn(null);
                  void run(
                    () => api.createFolder(detail.item.id, { name: value, parentId: folder.id }),
                    `已新建文件夹「${value}」`,
                  );
                }}
              />
            )}
            {renderFiles(node.files, depth + 1)}
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <section
      // 面板空白处就是「根目录」，把文件拖回这里就移出文件夹
      {...dragTargetProps('root')}
      className={`rounded border ${hover === 'root' ? 'border-sky-500/60' : 'border-zinc-800'}`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <h2 className="text-xs font-medium text-zinc-300">全部交付物</h2>
        <span className="text-[11px] text-zinc-500">
          共 {total} 个 · 按文件夹归置，和阶段互不影响 · 拖动文件行可以换文件夹
        </span>
        <button className={`${btnGhost} ml-auto`} onClick={() => setCreatingIn('root')}>
          ＋ 新建文件夹
        </button>
      </header>

      <div className="px-2 py-2">
        {creatingIn === 'root' && (
          <NewFolderInput
            depth={0}
            onCancel={() => setCreatingIn(null)}
            onConfirm={(value) => {
              setCreatingIn(null);
              void run(
                () => api.createFolder(detail.item.id, { name: value }),
                `已新建文件夹「${value}」`,
              );
            }}
          />
        )}

        {total === 0 && detail.tree.children.length === 0 && creatingIn === null && (
          <p className="px-1 py-2 text-xs text-zinc-500">
            还没有交付物。把文件拖到页面上就会出现在这里；也可以先建文件夹再把东西拖进去。
          </p>
        )}

        {renderNode(detail.tree, 0)}
      </div>

      {detail.removedDeliverables.length > 0 && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <button
            type="button"
            onClick={() => setShowRemoved((v) => !v)}
            className="text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            {showRemoved ? '▾' : '▸'} 已移除（{detail.removedDeliverables.length}）
          </button>

          {showRemoved && (
            <ul className="mt-1 space-y-px">
              {detail.removedDeliverables.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 py-0.5 pl-4">
                  <span className="text-xs text-zinc-500 line-through">{d.name}</span>
                  {d.versions.length > 0 ? (
                    <span className="text-[10px] text-zinc-600">{d.versions.length} 版</span>
                  ) : (
                    <span
                      className="text-[10px] text-amber-300/70"
                      title="文件内容已经被「回收磁盘」清掉了。恢复只能把记录拿回来，字节回不来。"
                    >
                      文件已被回收
                    </span>
                  )}
                  <span className="text-[10px] text-zinc-600">
                    移除于 {fmtTime(d.removed_at)}
                  </span>
                  <button
                    type="button"
                    className="ml-auto text-[10px] text-sky-400 hover:text-sky-300"
                    onClick={() =>
                      void run(
                        () => api.restoreDeliverable(d.id),
                        `已恢复「${d.name}」`,
                      )
                    }
                  >
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <StorageFooter />
    </section>
  );
}

/**
 * 存储用量与回收。
 *
 * 用量是**全库**的（磁盘只有一个），所以标注清楚 —— 放在这儿是因为
 * 「文件面板」正是你会想起「我是不是传错了什么」的地方。
 */
function StorageFooter() {
  const queryClient = useQueryClient();
  const notice = useNotice();
  const usage = useQuery({ queryKey: ['storage'], queryFn: api.storageUsage });
  const [busy, setBusy] = useState(false);

  const u = usage.data;
  if (!u) return null;

  async function purge(): Promise<void> {
    const ok = window.confirm(
      `回收磁盘？\n\n` +
        `会删掉没有任何在册交付物引用的文件，预计释放 ${humanSize(u!.recoverableBytes)}` +
        `（${u!.recoverableFiles} 个文件）。\n\n` +
        `这一步不可撤销 —— 已移除交付物的历史版本文件会一起清掉（事件日志不受影响）。\n` +
        `在那之前，你随时可以在上面的「已移除」里把它们恢复回来。`,
    );
    if (!ok) return;

    setBusy(true);
    try {
      const r = await api.purgeFiles();
      await queryClient.invalidateQueries();
      notice.ok(
        `已回收 ${humanSize(r.freedBytes)}：${r.deletedFiles} 个文件、${r.deletedVersions} 条版本记录` +
          (r.keptShared > 0 ? `；${r.keptShared} 个文件因仍被引用而保留` : ''),
      );
    } catch (err) {
      notice.fail(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <footer className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">
      <span>
        磁盘占用 {humanSize(u.totalBytes)}
        <span className="text-zinc-600">
          （{u.totalFiles} 个文件，全库；同一份内容只存一份）
        </span>
      </span>

      {u.recoverableBytes > 0 ? (
        <>
          <span className="text-amber-300">
            可回收 {humanSize(u.recoverableBytes)}（{u.recoverableFiles} 个文件）
          </span>
          <button className={btnGhost} disabled={busy} onClick={() => void purge()}>
            {busy ? '回收中…' : '回收磁盘'}
          </button>
        </>
      ) : (
        <span className="text-zinc-600">没有可回收的内容</span>
      )}
    </footer>
  );
}

function countFiles(node: FolderNode): number {
  return node.files.length + node.children.reduce((sum, child) => sum + countFiles(child), 0);
}

function InlineInput({
  initial,
  onCancel,
  onConfirm,
}: {
  initial: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (value.trim()) onConfirm(value.trim());
        else onCancel();
      }}
      className="flex items-center gap-1"
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        className={`${inputCls} w-48 py-0 text-xs`}
      />
      <button type="submit" className="text-[10px] text-sky-400">
        改
      </button>
      <button type="button" className="text-[10px] text-zinc-500" onClick={onCancel}>
        取消
      </button>
    </form>
  );
}

function NewFolderInput({
  depth,
  onCancel,
  onConfirm,
}: {
  depth: number;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (value.trim()) onConfirm(value.trim());
        else onCancel();
      }}
      className="flex items-center gap-1 py-0.5"
      style={{ paddingLeft: depth * 16 + 4 }}
    >
      <span className="text-xs text-zinc-600">▾</span>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="文件夹名，例如 assets"
        className={`${inputCls} w-48 py-0 text-xs`}
      />
      <button type="submit" className={btnPrimary}>
        建
      </button>
      <button type="button" className={btnGhost} onClick={onCancel}>
        取消
      </button>
    </form>
  );
}
