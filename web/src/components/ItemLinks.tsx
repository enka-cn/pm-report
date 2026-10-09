import { useState, type FormEvent } from 'react';
import type { ItemDetail as ItemData } from '@manager/shared';
import { api } from '../api';
import { messageOf, useNotice } from '../lib/notice';
import { Field, Panel, btnGhost, btnPrimary, inputCls } from './ui';

type Act = <T>(fn: () => Promise<T>, success?: (r: T) => string) => Promise<void>;

/** 挂在需求上的链接。点标题在新标签页打开 —— 内部 wiki 之类的入口。 */
export function ItemLinks({ detail, act }: { detail: ItemData; act: Act }) {
  const notice = useNotice();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await act(
        () => api.addLink(detail.item.id, { url: url.trim(), label: label.trim() }),
        (r) => `已加链接「${r.label}」`,
      );
      setUrl('');
      setLabel('');
      setAdding(false);
    } catch (err) {
      notice.fail(messageOf(err));
    }
  }

  return (
    <Panel
      title={`链接（${detail.links.length}）`}
      extra={
        <button className={btnGhost} onClick={() => setAdding((v) => !v)}>
          {adding ? '取消' : '＋ 加链接'}
        </button>
      }
    >
      {detail.links.length === 0 && !adding && (
        <p className="text-xs text-zinc-500">
          还没有链接。内部 wiki、设计稿、看板都能放这儿，点标题直接跳过去。
        </p>
      )}

      <ul className="space-y-1">
        {detail.links.map((link) => (
          <li key={link.id} className="group flex items-baseline gap-2">
            <a
              href={link.url}
              target="_blank"
              // noopener 是必须的：新标签页能通过 window.opener 反向操作本页
              rel="noreferrer noopener"
              title={link.url}
              className="truncate text-sm text-sky-400 hover:text-sky-300"
            >
              {link.label}
            </a>
            <button
              type="button"
              title="删除这条链接"
              onClick={() =>
                void act(
                  () => api.removeLink(link.id).then(() => undefined),
                  () => `已删除链接「${link.label}」`,
                )
              }
              className="shrink-0 text-xs text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-rose-400"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {adding && (
        <form onSubmit={submit} className="mt-2 space-y-2 rounded border border-zinc-800 p-2">
          <Field label="网址">
            <input
              required
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://wiki.internal/pages/…"
              className={`${inputCls} w-full text-xs`}
            />
          </Field>
          <Field label="标题（留空就从网址里凑一个）">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如：需求串讲记录"
              className={`${inputCls} w-full text-xs`}
            />
          </Field>
          <div className="flex items-center gap-2">
            <button type="submit" className={btnPrimary}>
              加上
            </button>
            <button type="button" className={btnGhost} onClick={() => setAdding(false)}>
              取消
            </button>
          </div>
          <p className="text-[11px] text-zinc-500">只收 http / https 的完整网址。</p>
        </form>
      )}
    </Panel>
  );
}
