// Layout 4: Board. Threads are cards sorted into columns by what state the agent is in.
import { MessageSquare } from 'lucide-react';
import { CHANNELS, USERS } from '../data';
import { useApp } from '../store';
import { Branch, NewThread, NewThreadButton, Participants, STATUS_ORDER, StatusDot, statusLabel, ThreadView } from '../ui';

export default function V4Board() {
  const a = useApp();
  return (
    <div data-theme="slate" className="relative flex h-full flex-col overflow-hidden bg-bg text-fg">
      <header className="flex items-center gap-3 border-b border-line bg-side px-3 py-2.5 md:px-5">
        <span className="text-lg font-bold">OpenCase</span>
        <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-muted md:block">{a.channel.repo}</span>
        <span className="flex-1 md:hidden" />
        <NewThreadButton />
      </header>
      <div className="flex gap-1.5 overflow-x-auto border-b border-line bg-side px-3 py-2 md:px-5">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            onClick={() => a.pick(c.id)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ${
              c.id === a.channel.id ? 'bg-accent text-accent-fg' : 'bg-soft text-side-fg hover:text-white'
            }`}
          >
            #{c.name}
          </button>
        ))}
      </div>

      {/* On phones the columns scroll sideways and snap. */}
      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3 md:gap-4 md:p-5">
        {STATUS_ORDER.map((status) => {
          const cards = a.channelThreads.filter((t) => t.status === status);
          return (
            <section key={status} className="flex w-[84vw] shrink-0 snap-center flex-col rounded-xl bg-side md:w-auto md:flex-1 md:shrink">
              <h2 className="flex items-center gap-2 px-3.5 py-3 text-sm font-semibold">
                <StatusDot status={status} />
                {statusLabel(status)}
                <span className="text-muted">{cards.length}</span>
              </h2>
              <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 pb-2.5">
                {cards.map((t) => {
                  const last = t.msgs[t.msgs.length - 1];
                  return (
                    <button
                      key={t.id}
                      onClick={() => a.open(t.id)}
                      className="block w-full rounded-lg border border-line bg-surface p-3 text-left hover:border-accent"
                    >
                      <span className="block font-semibold leading-snug">{t.title}</span>
                      <span className="mt-1.5 line-clamp-2 text-sm text-muted">
                        {USERS[last.by].name}: {last.text}
                      </span>
                      <span className="mt-2.5 flex items-center gap-2">
                        <Participants thread={t} />
                        <span className="flex items-center gap-1 text-xs text-muted">
                          <MessageSquare size={12} /> {t.msgs.length}
                        </span>
                        <span className="ml-auto min-w-0">
                          <Branch thread={t} />
                        </span>
                      </span>
                    </button>
                  );
                })}
                {cards.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted">No threads</p>}
              </div>
            </section>
          );
        })}
      </div>

      {a.thread && (
        <>
          <div className="absolute inset-0 z-20 bg-black/50" onClick={() => a.open(null)} />
          <aside className="absolute inset-0 z-30 border-line shadow-2xl md:left-auto md:w-[540px] md:border-l">
            <ThreadView thread={a.thread} desktopClose />
          </aside>
        </>
      )}

      {a.drafting && (
        <div className="absolute inset-0 z-30 flex items-end bg-black/60 md:items-center md:justify-center" onClick={() => a.draft(false)}>
          <div className="w-full rounded-t-2xl border border-line bg-bg p-4 md:max-w-xl md:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-lg font-bold">Start a thread</h2>
            <NewThread />
          </div>
        </div>
      )}
    </div>
  );
}
