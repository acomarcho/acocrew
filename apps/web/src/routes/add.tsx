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

  const row = 'flex w-full items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-left hover:bg-muted';
  const shown = list?.folders.filter((f) => f.name.toLowerCase().includes(search.toLowerCase())) ?? [];

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col p-3 md:py-10">
      <div className="flex items-center gap-2">
        {channels.length > 0 && (
          <Link to="/" className="-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Back">
            <ChevronLeft size={20} />
          </Link>
        )}
        <h2 className="flex-1 text-xl font-bold">Add a repository</h2>
        {/* With no repository yet there is no sidebar, so this is the way to your account and the team's. */}
        <Link to="/settings" className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted">
          Settings
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick a git repository on this machine. It becomes a channel, and Claude works inside that folder.
      </p>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search this folder"
        className="mt-3 rounded-lg border border-border bg-card px-3 py-2 text-base outline-none focus:border-primary md:text-sm"
      />
      {error && <p className="mt-2 text-sm text-rose-500">{error}</p>}
      <div className="mt-3 truncate font-mono text-xs text-muted-foreground">{list?.path}</div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card">
        {list?.parent && (
          <button type="button" className={row} onClick={() => go(list.parent!)}>
            <CornerLeftUp size={16} className="shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">Up one folder</span>
          </button>
        )}
        {shown.map((folder) =>
          folder.isRepo ? (
            <button key={folder.path} type="button" className={row} onClick={() => void add(folder.path)}>
              <FolderGit2 size={16} className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
              <span className="shrink-0 rounded-md bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                Add
              </span>
            </button>
          ) : (
            <button key={folder.path} type="button" className={row} onClick={() => go(folder.path)}>
              <Folder size={16} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            </button>
          ),
        )}
        {list && shown.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">No folders here.</p>
        )}
      </div>
    </div>
  );
}
