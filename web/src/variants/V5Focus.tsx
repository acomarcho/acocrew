// Layout 5: Focus. Sidebar is a tree of repositories with their threads. One chat fills the screen.
import { FolderGit2, Plus } from 'lucide-react';
import { CHANNELS } from '../data';
import { useApp } from '../store';
import { Drawer, NavButton, NewThread, StatusDot, ThreadView } from '../ui';

export default function V5Focus() {
  const a = useApp();
  const startIn = (channelId: string) => {
    a.pick(channelId);
    a.draft();
  };

  return (
    <div data-theme="ink" className="relative flex h-full overflow-hidden bg-bg text-fg">
      <Drawer className="md:w-72 md:border-r md:border-line">
        <div className="px-4 py-3.5 text-lg font-bold text-white">OpenCase</div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {CHANNELS.map((c) => (
            <div key={c.id} className="mb-2">
              <div className="flex items-center gap-2 px-4 py-1.5 text-sm text-side-muted">
                <FolderGit2 size={14} />
                <span className="flex-1 truncate font-medium">{c.name}</span>
                <button onClick={() => startIn(c.id)} className="rounded p-1 hover:bg-side-hover hover:text-white" aria-label={`New thread in ${c.name}`}>
                  <Plus size={15} />
                </button>
              </div>
              {a.threads
                .filter((t) => t.channelId === c.id)
                .map((t) => (
                  <button
                    key={t.id}
                    onClick={() => a.open(t.id)}
                    className={`mx-2 flex w-[calc(100%-1rem)] items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ${
                      t.id === a.thread?.id ? 'bg-side-active text-side-active-fg' : 'hover:bg-side-hover'
                    }`}
                  >
                    <StatusDot status={t.status} />
                    <span className="truncate">{t.title}</span>
                  </button>
                ))}
            </div>
          ))}
        </div>
      </Drawer>

      <main className="flex min-w-0 flex-1 flex-col">
        {a.thread ? (
          <ThreadView thread={a.thread} narrow />
        ) : (
          <>
            <div className="p-2.5 md:hidden">
              <NavButton />
            </div>
            <div className="flex flex-1 flex-col justify-center p-4 pb-16">
              <div className="mx-auto w-full max-w-2xl">
                <h1 className="mb-1 text-2xl font-bold">What should we work on?</h1>
                <p className="mb-4 text-muted">Pick a repository, then start a thread.</p>
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {CHANNELS.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => startIn(c.id)}
                      className={`rounded-full border px-3 py-1 text-sm ${
                        c.id === a.channel.id ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg'
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
                <NewThread cancel={false} />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
