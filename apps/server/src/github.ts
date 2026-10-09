import type { GithubAccount } from '@acocrew/shared';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The GitHub accounts logged in on this machine, as the GitHub CLI lists them. `gh` is that program.
// Null when the machine has no such program.
export async function listAccounts(gh: string): Promise<GithubAccount[] | null> {
  const status = await run(gh, ['auth', 'status', '--json', 'hosts']).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!status) return null;
  const { hosts } = JSON.parse(status.stdout) as { hosts: Record<string, GithubAccount[]> };
  // gh says more about each account (what its token may do, for one). Only this much is passed on.
  return Object.values(hosts)
    .flat()
    .map(({ host, login, active }) => ({ host, login, active }));
}

// Makes this account the active one of its host, for everything on the machine that goes through gh.
export const switchAccount = (gh: string, { host, login }: Pick<GithubAccount, 'host' | 'login'>) =>
  run(gh, ['auth', 'switch', '--hostname', host, '--user', login]);
