// Files Claude shows in a thread, by writing `![name](path)` in a message. They can be anywhere on the machine.
import { realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

// The kinds a message can show, and the CSP each one is served with. `sandbox` gives a page its own origin, with
// no access to the login cookie or the app, even when someone opens the address in a tab of its own.
const PAGE = 'sandbox allow-scripts allow-forms allow-popups';
const STILL = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
const KINDS: Record<string, { type: string; csp: string }> = {
  png: { type: 'image/png', csp: STILL },
  jpg: { type: 'image/jpeg', csp: STILL },
  jpeg: { type: 'image/jpeg', csp: STILL },
  gif: { type: 'image/gif', csp: STILL },
  webp: { type: 'image/webp', csp: STILL },
  svg: { type: 'image/svg+xml', csp: STILL },
  html: { type: 'text/html; charset=utf-8', csp: PAGE },
  excalidraw: { type: 'application/json', csp: STILL },
};

export const SHOWN_MAX_BYTES = 25 * 1024 * 1024;

// The file at `path` (absolute, or from `folder`) if it is a kind we show once links are followed. Otherwise null.
// The kind comes from the file itself, so a link named `x.png` to the database or the login secret shows nothing.
// Nothing in `hidden` is shown either: those are files attached in threads, which not everyone may see.
export function findShown(folder: string, path: unknown, hidden: string) {
  if (typeof path !== 'string' || !path) return null;
  try {
    const file = realpathSync(resolve(folder, path));
    const kind = KINDS[extname(file).slice(1).toLowerCase()];
    const stat = statSync(file);
    const isHidden = file.startsWith(realpathSync(hidden) + sep);
    return kind && !isHidden && stat.isFile() && stat.size <= SHOWN_MAX_BYTES ? { file, ...kind } : null;
  } catch {
    return null;
  }
}
