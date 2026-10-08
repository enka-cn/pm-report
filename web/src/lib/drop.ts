import { useState, type DragEvent } from 'react';

/**
 * 文件拖放。
 *
 * **用 `dragover` 实时判断指针下面是谁，而不是用 dragenter/dragleave 维护计数器。**
 * 后者在子元素之间移动时会疯狂触发（进一个子元素就 leave 一次父元素），
 * 计数器极难维护对，结果是高亮乱闪。`dragover` 是持续触发的，
 * 每次直接拿 `closest('[data-drop-stage]')` 算一次，反而简单且永远准确。
 */
export function useFileDrop(onDrop: (files: File[], targetId: number | null) => void) {
  const [active, setActive] = useState(false);
  /** 指针下面的放置目标；null = 落在「没有指定阶段」的地方 */
  const [targetId, setTargetId] = useState<number | null>(null);
  const [count, setCount] = useState(0);

  /** 拖进来的必须是文件。拖一段文字进来不该触发上传界面 */
  function hasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes('Files');
  }

  function reset(): void {
    setActive(false);
    setTargetId(null);
    setCount(0);
  }

  const handlers = {
    onDragEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setActive(true);
    },
    onDragOver(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';

      const host = (e.target as HTMLElement | null)?.closest?.('[data-drop-stage]');
      const raw = host?.getAttribute('data-drop-stage');
      setTargetId(raw ? Number(raw) : null);
      setCount(e.dataTransfer.items.length);
    },
    onDragLeave(e: DragEvent) {
      // 移到子元素上也会触发 dragleave，只有真的离开容器才算
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      reset();
    },
    onDrop(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      const target = targetId;
      reset();
      if (files.length > 0) onDrop(files, target);
    },
  };

  return { active, targetId, count, handlers };
}

/**
 * 拼一句「哪几个文件、处理成什么了」。
 *
 * 版本和跳过这两类要带上**交付物的名字**：同名会归到已有的那一条（可能属于别的阶段），
 * 只说「加入「送测」」会让人以为在送测阶段新建了一条。
 */
export function summarizeDrop(
  results: { filename: string; deliverableName: string; action: string; error?: string }[],
): { ok: string; failed: string[] } {
  const pick = (action: string): string[] =>
    results.filter((r) => r.action === action).map((r) => r.deliverableName);

  const created = pick('created');
  const versioned = pick('versioned');
  const unchanged = pick('unchanged');

  const parts: string[] = [];
  if (created.length > 0) parts.push(`新增 ${created.length} 个（${created.join('、')}）`);
  if (versioned.length > 0) parts.push(`${versioned.join('、')} 成为新版本`);
  if (unchanged.length > 0) parts.push(`${unchanged.join('、')} 内容没变、跳过`);

  const failed = results
    .filter((r) => r.action === 'failed')
    .map((r) => `${r.filename}：${r.error ?? '未知错误'}`);
  if (failed.length > 0) parts.push(`${failed.length} 个失败`);

  return { ok: parts.join('；') || '没有可加入的文件', failed };
}
