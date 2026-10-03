// Folder picker: browse the server machine's home folder and pick a git repository to add as a channel.
import type { FolderList } from '@acocrew/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, CornerLeftUp, Folder, FolderGit2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '../store';

export const Route = createFileRoute('/add')({ component: AddRepository });

function AddRepository() {
  const { channels, listFolders, addChannel } = useApp();
  const navigate = useNavigate();
  // undefined = the home folder
  const [path, setPath] = useState<string>();
  const [list, setList] = useState<FolderList>();
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : 'Something went wrong.');

  useEffect(() => {
    let stale = false;
    listFolders(path).then((next) => !stale && setList(next), fail);
    return () => {
      stale = true;
    };
  }, [listFolders, path]);

  const go = (next: string) => {
    setError('');
    setSearch('');
    setPath(next);
  };

  const add = (repo: string) =>
    addChannel(repo).then((channel) => navigate({ to: '/c/$channelId', params: { channelId: channel.id } }), fail);

  const row = 'flex w-full items-center gap-2.5 border-b border-line px-3.5 py-2.5 text-left hover:bg-soft';
  const shown = list?.folders.filter((f) => f.name.toLowerCase().includes(search.toLowerCase())) ?? [];

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col p-3 md:py-10">
      <div className="flex items-center gap-2">
        {channels.length > 0 && (
          <Link to="/" className="-ml-1 rounded-md p-1.5 text-muted hover:bg-soft" aria-label="Back">
            <ChevronLeft size={20} />
          </Link>
        )}
        <h2 className="text-xl font-bold">Add a repository</h2>
      </div>
      <p className="mt-1 text-sm text-muted">
        Pick a git repository on this machine. It becomes a channel, and Claude works inside that folder.
      </p>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search this folder"
        className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-base outline-none focus:border-accent md:text-sm"
      />
      {error && <p className="mt-2 text-sm text-rose-500">{error}</p>}
      <div className="mt-3 truncate font-mono text-xs text-muted">{list?.path}</div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-surface">
        {list?.parent && (
          <button type="button" className={row} onClick={() => go(list.parent!)}>
            <CornerLeftUp size={16} className="shrink-0 text-muted" />
            <span className="text-muted">Up one folder</span>
          </button>
        )}
        {shown.map((folder) =>
          folder.isRepo ? (
            <button key={folder.path} type="button" className={row} onClick={() => void add(folder.path)}>
              <FolderGit2 size={16} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
              <span className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-xs font-semibold text-accent-fg">
                Add
              </span>
            </button>
          ) : (
            <button key={folder.path} type="button" className={row} onClick={() => go(folder.path)}>
              <Folder size={16} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            </button>
          ),
        )}
        {list && shown.length === 0 && <p className="p-6 text-center text-sm text-muted">No folders here.</p>}
      </div>
    </div>
  );
}
