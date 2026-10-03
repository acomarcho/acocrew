import type { Msg, Status, Thread } from '@acocrew/shared';
import { createContext, useContext, useState } from 'react';
import { ME, SEED } from './data';

const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
let n = 0;
const uid = () => `x${++n}`;

// Canned agent answers. The real app would stream these from Claude.
const REPLIES = [
  "On it. I looked through the code and made the change in this thread's worktree. Have a look and tell me if you want anything adjusted.",
  'Done. I ran the tests and they pass. Nothing is merged yet, so this is safe to review first.',
  'I found the cause and fixed it. Want me to open a pull request?',
];

// Fake in-memory state. Which channel and thread are open lives in the URL, not here.
export function useAppState() {
  const [threads, setThreads] = useState<Thread[]>(SEED);
  const [navOpen, setNavOpen] = useState(false);

  const patch = (id: string, p: Partial<Thread>) =>
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));

  const add = (id: string, msg: Msg, status: Status) =>
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, status, msgs: [...t.msgs, msg] } : t)));

  const agentReply = (id: string) =>
    setTimeout(() => {
      const msg: Msg = {
        id: uid(),
        by: 'claude',
        at: now(),
        text: REPLIES[n % REPLIES.length],
        tools: [{ kind: 'run', label: 'Ran', detail: 'git status' }],
      };
      add(id, msg, 'done');
    }, 2200);

  const send = (id: string, text: string) => {
    add(id, { id: uid(), by: ME, at: now(), text }, 'working');
    agentReply(id);
  };

  // Returns the new thread's id so the caller can open it.
  const create = (channelId: string, text: string, model: string, effort: string) => {
    const id = uid();
    const title = text.split('\n')[0].slice(0, 70);
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
    const first: Msg = { id: uid(), by: ME, at: now(), text };
    setThreads((ts) => [
      ...ts,
      { id, channelId, title, branch: `thread/${slug}`, status: 'working', model, effort, msgs: [first] },
    ]);
    agentReply(id);
    return id;
  };

  return { threads, navOpen, setNavOpen, patch, send, create };
}

export type App = ReturnType<typeof useAppState>;
export const Ctx = createContext<App>(null!);
export const useApp = () => useContext(Ctx);
