// Who sees a thread: the button in its header, and the panel it opens for whoever started the thread.
import { VISIBILITY, type Thread, type Visibility } from '@acocrew/shared';
import { Check, Search, X } from 'lucide-react';
import { useState } from 'react';
import { useApp } from './store';
import { Avatar, VisibilityIcon } from './ui';

const ROW = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm';

export function ShareButton({ thread }: { thread: Thread }) {
  const { me, people, showThread, shareThread } = useApp();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const { visibility, shared } = thread;
  const label = VISIBILITY.find((option) => option.id === visibility)!;
  // Everyone else only sees how it is.
  if (thread.createdBy !== me.id) {
    return (
      <span title={`${label.name} thread`} className="grid size-9 shrink-0 place-items-center text-muted-foreground">
        <VisibilityIcon visibility={visibility} size={16} />
      </span>
    );
  }

  // Every change is sent at once. The panel shows the thread as the server has it.
  const save = (change: Promise<unknown>) => {
    setError('');
    change.catch((err: Error) => setError(err.message));
  };
  const person = (id: string) => people.find((one) => one.id === id);
  const words = typed.trim().toLowerCase();
  const addable = people.filter(
    (one) =>
      !one.deleted &&
      one.id !== me.id &&
      !shared.includes(one.id) &&
      `${one.name} ${one.username}`.toLowerCase().includes(words),
  );
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="Who sees this thread"
        className="flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <VisibilityIcon visibility={visibility} size={16} />
        <span className="hidden sm:inline">Share</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Who sees this thread"
            // On phones the button is not at the edge of the screen, so the panel takes the full width under the header.
            className="fixed inset-x-3 top-14 z-50 rounded-lg border border-border bg-card p-1 text-foreground shadow-xl sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-1 sm:w-80"
          >
            {VISIBILITY.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={option.id === visibility}
                onClick={() => save(showThread(thread.id, option.id as Visibility))}
                className={`${ROW} hover:bg-muted`}
              >
                <VisibilityIcon visibility={option.id as Visibility} />
                <span className="min-w-0 flex-1">
                  <span className="block">{option.name}</span>
                  <span className="block text-xs text-muted-foreground">{option.hint}</span>
                </span>
                {option.id === visibility && <Check size={14} className="shrink-0 text-primary" />}
              </button>
            ))}
            <div className="mt-1 border-t border-border px-2 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Shared with
            </div>
            {shared.map((id) => (
              <div key={id} className={ROW}>
                <Avatar person={person(id)} small />
                <span className="min-w-0 flex-1 truncate">{person(id)?.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${person(id)?.name}`}
                  title="Remove"
                  onClick={() => save(shareThread(thread.id, id, false))}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {shared.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">Nobody yet.</p>}
            {visibility === 'public' && shared.length > 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                Everyone sees it while it is public. These people keep it when it is private again.
              </p>
            )}
            <label className="mt-1 flex items-center gap-2 border-t border-border px-2 pt-2 pb-1 text-muted-foreground">
              <Search size={14} className="shrink-0" />
              <input
                value={typed}
                placeholder="Add people"
                aria-label="Add people"
                onChange={(e) => setTyped(e.target.value)}
                className="w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm"
              />
            </label>
            <div className="max-h-48 overflow-y-auto">
              {addable.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  onClick={() => {
                    save(shareThread(thread.id, one.id, true));
                    setTyped('');
                  }}
                  className={`${ROW} hover:bg-muted`}
                >
                  <Avatar person={one} small />
                  <span className="min-w-0 flex-1 truncate">{one.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">@{one.username}</span>
                </button>
              ))}
              {addable.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  {words ? 'Nobody matches.' : 'Nobody left to add.'}
                </p>
              )}
            </div>
            {error && <p className="px-2 py-1 text-xs text-rose-500">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
