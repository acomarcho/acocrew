// Layout 3: Inbox. Channels, then a thread list, then the open thread, like an email app.
import { useState } from 'react';
import { ChevronLeft, Hash, MessagesSquare } from 'lucide-react';
import { CHANNELS, USERS, type Status } from '../data';
import { useApp } from '../store';
import { Drawer, NavButton, NewThread, NewThreadButton, Participants, STATUS_ORDER, StatusDot, statusLabel, ThreadView } from '../ui';

export default function V3Inbox() {
  const a = useApp();
  const [filter, setFilter] = useState<Status | null>(null);
  const detailOpen = a.thread !== null || a.drafting;
  const rows = a.channelThreads.filter((t) => !filter || t.status === filter).reverse();

  return (
    <div data-theme="paper" className="relative flex h-full overflow-hidden bg-bg text-fg">
      <Drawer className="md:w-56 md:border-r md:border-line">
        <div className="px-4 py-3.5 text-lg font-bold">OpenCase</div>
        <div className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-side-muted">Repositories</div>
        {CHANNELS.map((c) => {
          const count = a.threads.filter((t) => t.channelId === c.id && t.status !== 'done').length;
          const active = c.id === a.channel.id;
          return (
            <button
              key={c.id}
              onClick={() => a.pick(c.id)}
              className={`mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                active ? 'bg-side-active text-side-active-fg' : 'hover:bg-side-hover'
              }`}
            >
              <Hash size={15} className="opacity-60" />
              <span className="flex-1 truncate">{c.name}</span>
              {count > 0 && <span className="text-xs opacity-70">{count}</span>}
            </button>
          );
        })}
      </Drawer>

      <section className={`w-full min-w-0 flex-col border-line md:flex md:w-[360px] md:shrink-0 md:border-r ${detailOpen ? 'hidden' : 'flex'}`}>
        <header className="flex items-center gap-2 px-3 py-2.5">
          <NavButton />
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">#{a.channel.name}</div>
            <div className="truncate font-mono text-xs text-muted">{a.channel.repo}</div>
          </div>
          <NewThreadButton />
        </header>
        <div className="flex gap-1.5 overflow-x-auto border-b border-line px-3 pb-2.5">
          {[null, ...STATUS_ORDER].map((s) => (
            <button
              key={s ?? 'all'}
              onClick={() => setFilter(s)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                filter === s ? 'bg-fg text-bg' : 'bg-soft text-muted hover:text-fg'
              }`}
            >
              {s ? statusLabel(s) : 'All'}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((t) => {
            const last = t.msgs[t.msgs.length - 1];
            return (
              <button
                key={t.id}
                onClick={() => a.open(t.id)}
                className={`block w-full border-b border-line px-3.5 py-3 text-left hover:bg-soft ${t.id === a.thread?.id ? 'bg-soft' : ''}`}
              >
                <span className="flex items-center gap-2">
                  <StatusDot status={t.status} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{t.title}</span>
                  <span className="shrink-0 text-xs text-muted">{last.at.replace('Yesterday ', 'Yest. ')}</span>
                </span>
                <span className="mt-1 line-clamp-2 text-sm text-muted">
                  {USERS[last.by].name}: {last.text}
                </span>
                <span className="mt-2 flex items-center gap-2 text-xs text-muted">
                  <Participants thread={t} />
                  {t.msgs.length} messages
                </span>
              </button>
            );
          })}
          {rows.length === 0 && <p className="p-6 text-center text-sm text-muted">Nothing here.</p>}
        </div>
      </section>

      <section className={`min-w-0 flex-1 flex-col md:flex ${detailOpen ? 'flex' : 'hidden'}`}>
        {a.thread && <ThreadView thread={a.thread} />}
        {a.drafting && (
          <div className="flex h-full flex-col p-3 md:justify-center md:p-10">
            <button onClick={() => a.draft(false)} className="mb-4 flex items-center gap-1 text-sm text-muted md:hidden">
              <ChevronLeft size={18} /> Back
            </button>
            <div className="mx-auto w-full max-w-2xl">
              <h2 className="mb-3 text-xl font-bold">Start a thread</h2>
              <NewThread />
            </div>
          </div>
        )}
        {!detailOpen && (
          <div className="grid h-full place-items-center p-8 text-center text-muted">
            <div>
              <MessagesSquare size={40} className="mx-auto mb-3 opacity-50" />
              <p className="mb-4">Pick a thread on the left, or start a new one.</p>
              <NewThreadButton />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
