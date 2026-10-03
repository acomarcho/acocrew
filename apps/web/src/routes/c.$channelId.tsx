// The Inbox screen: channels, then a thread list, then the open thread, like an email app.
import type { Status } from '@acocrew/shared';
import { createFileRoute, Link, Outlet, redirect, useChildMatches } from '@tanstack/react-router';
import { Hash } from 'lucide-react';
import { useState } from 'react';
import { CHANNELS, USERS } from '../data';
import { useApp } from '../store';
import { Drawer, NavButton, NewThreadButton, Participants, STATUS_ORDER, StatusDot, statusLabel } from '../ui';

export const Route = createFileRoute('/c/$channelId')({
  beforeLoad: ({ params }) => {
    const channel = CHANNELS.find((c) => c.id === params.channelId);
    if (!channel) throw redirect({ to: '/' });
    return { channel };
  },
  component: Inbox,
});

function Inbox() {
  const { channel } = Route.useRouteContext();
  const { threads, setNavOpen } = useApp();
  const [filter, setFilter] = useState<Status | null>(null);
  // On phones the list and the detail take turns. The detail shows when a thread or "new" is open.
  const detailOpen = useChildMatches({ select: (matches) => matches.some((m) => m.routeId !== '/c/$channelId/') });
  const rows = threads.filter((t) => t.channelId === channel.id && (!filter || t.status === filter)).reverse();

  return (
    <div className="relative flex h-full overflow-hidden">
      <Drawer className="md:w-56 md:border-r md:border-line">
        <div className="px-4 py-3.5 text-lg font-bold">OpenCase</div>
        <div className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-side-muted">Repositories</div>
        {CHANNELS.map((c) => {
          const count = threads.filter((t) => t.channelId === c.id && t.status !== 'done').length;
          return (
            <Link
              key={c.id}
              to="/c/$channelId"
              params={{ channelId: c.id }}
              onClick={() => setNavOpen(false)}
              className="mx-2 flex items-center gap-2 rounded-md px-2 py-1.5"
              activeProps={{ className: 'bg-side-active text-side-active-fg' }}
              inactiveProps={{ className: 'hover:bg-side-hover' }}
            >
              <Hash size={15} className="opacity-60" />
              <span className="flex-1 truncate">{c.name}</span>
              {count > 0 && <span className="text-xs opacity-70">{count}</span>}
            </Link>
          );
        })}
      </Drawer>

      <section
        className={`w-full min-w-0 flex-col border-line md:flex md:w-[360px] md:shrink-0 md:border-r ${detailOpen ? 'hidden' : 'flex'}`}
      >
        <header className="flex items-center gap-2 px-3 py-2.5">
          <NavButton />
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">#{channel.name}</div>
            <div className="truncate font-mono text-xs text-muted">{channel.repo}</div>
          </div>
          <NewThreadButton channelId={channel.id} />
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
              <Link
                key={t.id}
                to="/c/$channelId/t/$threadId"
                params={{ channelId: channel.id, threadId: t.id }}
                className="block border-b border-line px-3.5 py-3 hover:bg-soft"
                activeProps={{ className: 'bg-soft' }}
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
              </Link>
            );
          })}
          {rows.length === 0 && <p className="p-6 text-center text-sm text-muted">Nothing here.</p>}
        </div>
      </section>

      <section className={`min-w-0 flex-1 flex-col md:flex ${detailOpen ? 'flex' : 'hidden'}`}>
        <Outlet />
      </section>
    </div>
  );
}
