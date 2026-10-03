// Layout 2: Lark topics. Each thread is a card that opens in place.
import { ChevronLeft, FolderGit2, MessageSquare, Search } from 'lucide-react';
import { CHANNELS, USERS } from '../data';
import { useApp } from '../store';
import { Avatar, Branch, Message, NewThread, NewThreadButton, StatusBadge, ThreadComposer, Working } from '../ui';

function ChannelIcon({ color, size = 40 }: { color: string; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-full text-white" style={{ width: size, height: size, background: color }}>
      <FolderGit2 size={size * 0.48} />
    </span>
  );
}

export default function V2Topics() {
  const a = useApp();
  return (
    <div data-theme="lark" className="relative flex h-full overflow-hidden bg-soft text-fg">
      {/* On phones this list is its own screen. */}
      <nav
        className={`absolute inset-0 z-30 flex-col bg-side md:static md:flex md:w-80 md:shrink-0 md:border-r md:border-line ${
          a.navOpen ? 'flex' : 'hidden'
        }`}
      >
        <div className="px-4 pb-2 pt-4 text-lg font-semibold">Chats</div>
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg bg-side-hover px-3 py-2 text-sm text-side-muted">
          <Search size={15} /> Search
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {CHANNELS.map((c) => {
            const list = a.threads.filter((t) => t.channelId === c.id);
            const latest = list[list.length - 1];
            const waiting = list.filter((t) => t.status === 'needs').length;
            return (
              <button
                key={c.id}
                onClick={() => a.pick(c.id)}
                className={`flex w-full items-center gap-3 rounded-lg p-2.5 text-left ${
                  c.id === a.channel.id ? 'bg-side-active' : 'hover:bg-side-hover'
                }`}
              >
                <ChannelIcon color={c.color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-sm text-side-muted">{latest?.title ?? 'No threads yet'}</span>
                </span>
                {waiting > 0 && (
                  <span className="grid size-5 place-items-center rounded-full bg-rose-500 text-xs font-medium text-white">{waiting}</span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        <header className="flex items-center gap-2.5 border-b border-line px-3 py-2.5 md:px-5">
          <button onClick={() => a.setNavOpen(true)} className="-ml-1 rounded-md p-1 text-muted md:hidden" aria-label="Back to chats">
            <ChevronLeft size={22} />
          </button>
          <ChannelIcon color={a.channel.color} size={34} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{a.channel.name}</div>
            <div className="truncate font-mono text-xs text-muted">{a.channel.repo}</div>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 md:p-5">
          {a.channelThreads.map((t) => {
            const expanded = t.id === a.thread?.id;
            const first = t.msgs[0];
            const last = t.msgs[t.msgs.length - 1];
            return (
              <article key={t.id} className={`max-w-3xl rounded-xl border bg-surface ${expanded ? 'border-accent' : 'border-line'}`}>
                <button onClick={() => a.open(expanded ? null : t.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-left">
                  <span className="min-w-0 flex-1 basis-48 font-semibold">{t.title}</span>
                  <StatusBadge status={t.status} />
                </button>
                <div className="px-4 pb-1">
                  <Branch thread={t} />
                </div>

                {expanded ? (
                  <>
                    <div className="-mx-0 border-t border-line py-2">
                      {t.msgs.map((m) => (
                        <Message key={m.id} m={m} />
                      ))}
                      {t.status === 'working' && <Working />}
                    </div>
                    <div className="p-3 pt-0">
                      <ThreadComposer thread={t} />
                    </div>
                  </>
                ) : (
                  <button onClick={() => a.open(t.id)} className="block w-full px-4 pb-3 text-left">
                    <span className="flex items-start gap-2 border-t border-line pt-2.5 text-sm">
                      <Avatar id={last.by} size={20} />
                      <span className="line-clamp-2 min-w-0 flex-1 text-muted">
                        <b className="font-medium text-fg">{USERS[last.by].name}</b> {last.text}
                      </span>
                    </span>
                    <span className="mt-2 flex items-center gap-1.5 text-sm text-muted">
                      <MessageSquare size={14} /> Reply
                      <span>
                        · {t.msgs.length} {t.msgs.length === 1 ? 'message' : 'messages'} · started by {USERS[first.by].name}
                      </span>
                    </span>
                  </button>
                )}
              </article>
            );
          })}
        </div>

        <div className="border-t border-line p-3 md:px-5">
          <div className="max-w-3xl">{a.drafting ? <NewThread /> : <NewThreadButton />}</div>
        </div>
      </main>
    </div>
  );
}
