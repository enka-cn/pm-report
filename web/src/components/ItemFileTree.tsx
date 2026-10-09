import { useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import type { DeliverableWithVersions, FolderNode, ItemDetail as ItemData } from '@manager/shared';
import { api } from '../api';
import { useMeta } from '../lib/meta';
import { messageOf, useNotice } from '../lib/notice';
import { beginDeliverableDrag, deliverableIdOf, isDeliverableDrag } from '../lib/drop';
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

              <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                {d.versions.length} 版
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
    </section>
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
