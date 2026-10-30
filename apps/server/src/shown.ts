// Files Claude shows in a thread, by writing `![name](path)` in a message. They are read from the folder the
// thread works in, and nowhere else.
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

// The file at `path` (absolute, or from `folder`) if it is a kind we show and sits inside `folder` once links are
// followed. Otherwise null.
export function findShown(folder: string, path: unknown) {
  if (typeof path !== 'string' || !path) return null;
  const kind = KINDS[extname(path).slice(1).toLowerCase()];
  if (!kind) return null;
  try {
    const root = realpathSync(folder);
    const file = realpathSync(resolve(root, path));
    const stat = statSync(file);
    const inside = file.startsWith(root + sep);
    return inside && stat.isFile() && stat.size <= SHOWN_MAX_BYTES ? { file, ...kind } : null;
  } catch {
    return null;
  }
}
