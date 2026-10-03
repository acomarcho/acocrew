import type { FolderList } from '@acocrew/shared';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

// The real path of `path` if it is a folder inside `home` (or `home` itself), else null.
// Links are followed first, so a link cannot point the app outside the home folder.
export function folderInside(home: string, path: string): string | null {
  try {
    const real = realpathSync(path);
    const inside = real === home || real.startsWith(home + sep);
    return inside && statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export const isRepo = (dir: string) => existsSync(join(dir, '.git'));

export function listFolders(home: string, path: string): FolderList | null {
  const dir = folderInside(home, path);
  if (!dir) return null;
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(dir, entry.name), isRepo: isRepo(join(dir, entry.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: dir, parent: dir === home ? null : dirname(dir), folders };
}
