// Layout 1: Slack. Channel feed in the middle, thread opens in a right panel.
import { ChevronDown, Hash, Plus } from 'lucide-react';
import { CHANNELS, USERS } from '../data';
import { useApp } from '../store';
import { Avatar, Branch, Drawer, NavButton, NewThread, Participants, StatusBadge, ThreadView } from '../ui';

export default function V1Slack() {
  const a = useApp();
  return (
    <div data-theme="slack" className="relative flex h-full overflow-hidden bg-bg text-fg">
      <Drawer className="md:w-64">
        <div className="flex items-center gap-1 px-4 py-3.5 text-lg font-bold text-white">
          OpenCase <ChevronDown size={16} />
        </div>
        <div className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-side-muted">Channels</div>
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            onClick={() => a.pick(c.id)}
            className={`mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${
              c.id === a.channel.id ? 'bg-side-active text-side-active-fg' : 'hover:bg-side-hover'
            }`}
          >
            <Hash size={16} className="opacity-70" />
            <span className="flex-1 truncate">{c.name}</span>
          </button>
        ))}
        <div className="px-4 pb-1 pt-5 text-xs font-medium uppercase tracking-wide text-side-muted">People</div>
        {Object.entries(USERS).map(([id, u]) => (
          <div key={id} className="mx-2 flex items-center gap-2 px-2 py-1">
            <Avatar id={id} size={20} />
            <span className="truncate">{u.name}</span>
          </div>
        ))}
      </Drawer>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line px-3 py-2.5 md:px-4">
          <NavButton />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 font-bold">
              <Hash size={16} />
              {a.channel.name}
            </div>
            <div className="truncate text-xs text-muted">
              <span className="font-mono">{a.channel.repo}</span> · {a.channel.about}
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {a.channelThreads.map((t) => {
            const first = t.msgs[0];
            const last = t.msgs[t.msgs.length - 1];
            return (
              <button
                key={t.id}
                onClick={() => a.open(t.id)}
                className={`flex w-full gap-3 px-3 py-2.5 text-left hover:bg-surface md:px-4 ${t.id === a.thread?.id ? 'bg-surface' : ''}`}
              >
                <Avatar id={first.by} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold">{USERS[first.by].name}</span>
                    <span className="text-xs text-muted">{first.at}</span>
                  </div>
                  <p className="leading-relaxed">{first.text}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <Participants thread={t} />
                    <span className="text-sm font-semibold text-accent">
                      {t.msgs.length - 1} {t.msgs.length === 2 ? 'reply' : 'replies'}
                    </span>
                    <span className="text-xs text-muted">Last reply {last.at}</span>
                    <StatusBadge status={t.status} />
                    <Branch thread={t} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="p-3 pt-1 md:px-4">
          {a.drafting ? (
            <NewThread />
          ) : (
            <button
              onClick={() => a.draft()}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-left hover:border-accent"
            >
              <span className="grid size-8 place-items-center rounded-full bg-accent text-accent-fg">
                <Plus size={18} />
              </span>
              <span>
                <span className="block font-semibold">New Thread</span>
                <span className="block text-xs text-muted">Every message in #{a.channel.name} starts a thread</span>
              </span>
            </button>
          )}
        </div>
      </main>

      {a.thread && (
        <aside className="absolute inset-0 z-20 border-line md:static md:w-[440px] md:shrink-0 md:border-l">
          <ThreadView thread={a.thread} desktopClose />
        </aside>
      )}
    </div>
  );
}
