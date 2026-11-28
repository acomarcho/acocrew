import { SERVER_PORT } from '@acocrew/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { startServer } from './server.ts';

const home = realpathSync(homedir());
const codexHome = process.env.ACOCREW_CODEX_HOME;
const codexModel = process.env.ACOCREW_CODEX_MODEL?.trim();
const codexBin = process.env.ACOCREW_CODEX_BIN;
const codex = (() => {
  if (!codexHome && !codexModel && !codexBin) return;
  if (!codexHome || !isAbsolute(codexHome) || !codexModel)
    throw new Error('Enabling Codex needs an absolute ACOCREW_CODEX_HOME and an ACOCREW_CODEX_MODEL.');
  if (codexBin && !isAbsolute(codexBin)) throw new Error('ACOCREW_CODEX_BIN must be an absolute path.');
  if (!statSync(codexHome, { throwIfNoEntry: false })?.isDirectory())
    throw new Error('ACOCREW_CODEX_HOME must be an existing directory.');
  const path = realpathSync(codexHome);
  const hostDefault = join(home, '.codex');
  if (existsSync(hostDefault) && path === realpathSync(hostDefault))
    throw new Error('ACOCREW_CODEX_HOME must be separate from the machine’s default Codex home.');
  return { home: path, model: codexModel, binary: codexBin || undefined };
})();
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

const { port, close } = await startServer(Number(process.env.PORT) || SERVER_PORT, {
  db,
  query,
  home,
  images,
  worktrees,
  secret,
  https: process.env.ACOCREW_HTTPS === '1',
  web,
  codex,
});
console.log(`acocrew server listening on http://127.0.0.1:${port}${web ? ' (with the built web app)' : ''}`);

if (codex) {
  const stop = () => void close().finally(() => process.exit());
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
