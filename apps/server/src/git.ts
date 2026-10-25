import type { Places } from '@acocrew/shared';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Runs git in a folder and gives back what it printed. Git never stops to ask for a password: it fails.
export async function git(dir: string, ...args: string[]) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  return (await run('git', ['-C', dir, ...args], { env })).stdout.trim();
}

// The branch a folder is on. Null when it is on no branch, or is not a working copy.
export const branchOf = (dir: string) =>
  git(dir, 'branch', '--show-current').then(
    (name) => name || null,
    () => null,
  );

// Where a new thread in this repository can work.
export async function listPlaces(repo: string): Promise<Places> {
  const [refs, copies, main] = await Promise.all([
    // One line per branch: where it is kept, its name, and what it points at if it is only a pointer (like
    // `origin/HEAD`, which is left out).
    git(
      repo,
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:rstrip=-2) %(refname:lstrip=2) %(symref)',
      'refs/heads',
      'refs/remotes',
    ),
    git(repo, 'worktree', 'list', '--porcelain'),
    // The remote's main branch. A repository with no remote starts from the branch its folder is on.
    git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => branchOf(repo)),
  ]);
  const branches = refs
    .split('\n')
    .map((line) => line.split(' '))
    .filter(([, name, pointer]) => name && !pointer)
    .map(([kind, name]) => ({ name, remote: kind === 'refs/remotes' ? name.split('/')[0] : null }))
    .sort((a, b) => Number(b.name === main) - Number(a.name === main));
  // Git lists the repository folder first. A copy whose folder is gone, or that holds no files, is left out.
  const worktrees = copies
    .split('\n\n')
    .filter((copy) => !/^(bare|prunable)/m.test(copy))
    .map((copy) => ({
      path: /^worktree (.+)$/m.exec(copy)![1],
      branch: /^branch refs\/heads\/(.+)$/m.exec(copy)?.[1] ?? null,
    }));
  return { branches, worktrees };
}

// Makes a new working copy of the repository in `path`, on a new branch that starts from `from`.
// A branch kept on a remote is fetched first, so the copy starts from the newest commit there.
export async function addWorktree(repo: string, path: string, branch: string, from: Places['branches'][number]) {
  // Asked for by its full name, so git cannot take it for a tag of the same name, or for an option.
  if (from.remote) await git(repo, 'fetch', from.remote, `refs/heads/${from.name.slice(from.remote.length + 1)}`);
  // Without `--no-track`, a push from the new branch would aim at the branch it started from.
  await git(repo, 'worktree', 'add', '--no-track', '-b', branch, path, from.name);
}

// When a branch was made, in seconds, from git's own log of it (its last line is the oldest). 0 when git does not
// know.
const madeAt = (repo: string, name: string) =>
  git(repo, 'reflog', '--date=unix', '--format=%gd', `refs/heads/${name}`).then(
    (log) => Number(/@\{(\d+)\}$/.exec(log)?.[1] ?? 0),
    () => 0,
  );

// Deletes a worktree with whatever is in it, committed or not, and its branches: `made`, the one it was made on,
// and the one its folder is on now if that one was made after `made`. Claude often moves a worktree to a branch of
// its own. A branch that was there before (main, or someone's own) was only checked out there, and stays, and so
// does one whose age git cannot tell.
export async function removeWorktree(repo: string, path: string, made: string) {
  const on = await branchOf(path);
  const [since, born] = await Promise.all([madeAt(repo, made), on && on !== made ? madeAt(repo, on) : 0]);
  await git(repo, 'worktree', 'remove', '--force', path);
  const ours = since && born >= since ? [made, on!] : [made];
  // Asked for by their full names, so a branch that is gone already is simply not listed.
  const left = await git(
    repo,
    'for-each-ref',
    '--format=%(refname:short)',
    ...ours.map((name) => `refs/heads/${name}`),
  );
  if (left) await git(repo, 'branch', '-D', ...left.split('\n'));
}
