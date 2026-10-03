// The Inbox screen: channels, then a thread list, then the open thread, like an email app.
import { MODELS, type Status } from '@acocrew/shared';
import { createFileRoute, Link, Navigate, Outlet, useChildMatches } from '@tanstack/react-router';
import { Hash, Plus } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../store';
import { Drawer, NavButton, NewThreadButton, STATUS_ORDER, StatusDot, statusLabel } from '../ui';

export const Route = createFileRoute('/c/$channelId')({ component: Inbox });

const when = (at: number) =>
  new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Inbox() {
  const { channelId } = Route.useParams();
  const { channels, threads, setNavOpen } = useApp();
  const [filter, setFilter] = useState<Status | null>(null);
  // On phones the list and the detail take turns. The detail shows when a thread or "new" is open.
  const detailOpen = useChildMatches({ select: (matches) => matches.some((m) => m.routeId !== '/c/$channelId/') });
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) return <Navigate to="/" replace />;
  const rows = threads
    .filter((t) => t.channelId === channel.id && (!filter || t.status === filter))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="relative flex h-full overflow-hidden">
      <Drawer className="md:w-56 md:border-r md:border-border">
        <div className="px-4 py-3.5 text-lg font-bold">acocrew</div>
        <div className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-sidebar-muted">Repositories</div>
        {channels.map((c) => {
          const count = threads.filter((t) => t.channelId === c.id && t.status !== 'done').length;
          return (
            <Link
              key={c.id}
              to="/c/$channelId"
              params={{ channelId: c.id }}
              onClick={() => setNavOpen(false)}
              className="mx-2 flex items-center gap-2 rounded-md px-2 py-1.5"
              activeProps={{ className: 'bg-sidebar-primary text-sidebar-primary-foreground' }}
              inactiveProps={{ className: 'hover:bg-sidebar-accent' }}
            >
              <Hash size={15} className="opacity-60" />
              <span className="flex-1 truncate">{c.name}</span>
              {count > 0 && <span className="text-xs opacity-70">{count}</span>}
            </Link>
          );
        })}
        <Link
          to="/add"
          onClick={() => setNavOpen(false)}
          className="mx-2 mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sidebar-muted hover:bg-sidebar-accent"
        >
          <Plus size={15} />
          Add repository
        </Link>
      </Drawer>

      <section
        className={`w-full min-w-0 flex-col border-border md:flex md:w-[360px] md:shrink-0 md:border-r ${detailOpen ? 'hidden' : 'flex'}`}
      >
        <header className="flex items-center gap-2 px-3 py-2.5">
          <NavButton />
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">#{channel.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{channel.path}</div>
          </div>
          <NewThreadButton channelId={channel.id} />
        </header>
        <div className="flex gap-1.5 overflow-x-auto border-b border-border px-3 pb-2.5">
          {[null, ...STATUS_ORDER].map((s) => (
            <button
              key={s ?? 'all'}
              onClick={() => setFilter(s)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                filter === s ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {s ? statusLabel(s) : 'All'}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((t) => (
            <Link
              key={t.id}
              to="/c/$channelId/t/$threadId"
              params={{ channelId: channel.id, threadId: t.id }}
              className="block border-b border-border px-3.5 py-3 hover:bg-muted"
              activeProps={{ className: 'bg-muted' }}
            >
              <span className="flex items-center gap-2">
                <StatusDot status={t.status} />
                <span className="min-w-0 flex-1 truncate font-semibold">{t.title}</span>
              </span>
              <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex-1 truncate">{MODELS.find((m) => m.id === t.model)?.name}</span>
                {when(t.updatedAt)}
              </span>
            </Link>
          ))}
          {rows.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">Nothing here.</p>}
        </div>
      </section>

      <section className={`min-w-0 flex-1 flex-col md:flex ${detailOpen ? 'flex' : 'hidden'}`}>
        <Outlet />
      </section>
    </div>
  );
}
