import { SERVER_PORT } from '@acocrew/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { startServer } from './server.ts';

const home = realpathSync(homedir());
// PORT and ACOCREW_DB let a second copy (for example one being developed) run next to the one people use.
// ACOCREW_HTTPS=1 is for a copy that people reach through an https address (a tunnel in front of it).
// Logging in then only works over https, and on localhost.
const dbFile = process.env.ACOCREW_DB ?? join(home, '.acocrew', 'acocrew.db');
const db = openDb(dbFile);
// Attached images sit next to the database.
const images = join(dirname(dbFile), 'attachments');
// So do the worktrees that threads work in.
const worktrees = join(dirname(dbFile), 'worktrees');
// So does the secret that signs login cookies. It is made on the first start, and only this user can read it.
const secretFile = join(dirname(dbFile), 'secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const secret = readFileSync(secretFile, 'utf8');
// After `pnpm build` the web app is here, and this one process serves everything.
const built = fileURLToPath(new URL('../../web/dist', import.meta.url));
const web = existsSync(join(built, 'index.html')) ? built : undefined;

const { port } = await startServer(Number(process.env.PORT) || SERVER_PORT, {
  db,
  query,
  home,
  images,
  worktrees,
  secret,
  https: process.env.ACOCREW_HTTPS === '1',
  web,
});
console.log(`acocrew server listening on http://127.0.0.1:${port}${web ? ' (with the built web app)' : ''}`);
