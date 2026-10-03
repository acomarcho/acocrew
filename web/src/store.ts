import { createContext, useContext, useState } from 'react';
import { CHANNELS, ME, SEED, type Msg, type Status, type Thread } from './data';

const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
let n = 0;
const uid = () => `x${++n}`;

// Canned agent answers. The real app would stream these from Claude.
const REPLIES = [
  'On it. I looked through the code and made the change in this thread\'s worktree. Have a look and tell me if you want anything adjusted.',
  'Done. I ran the tests and they pass. Nothing is merged yet, so this is safe to review first.',
  'I found the cause and fixed it. Want me to open a pull request?',
];

export function useAppState() {
  const [threads, setThreads] = useState<Thread[]>(SEED);
  const [channelId, setChannelId] = useState(CHANNELS[0].id);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
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

  const create = (text: string, model: string, effort: string) => {
    const id = uid();
    const title = text.split('\n')[0].slice(0, 70);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
    const first: Msg = { id: uid(), by: ME, at: now(), text };
    setThreads((ts) => [
      ...ts,
      { id, channelId, title, branch: `thread/${slug}`, status: 'working', model, effort, msgs: [first] },
    ]);
    setThreadId(id);
    setDrafting(false);
    agentReply(id);
  };

  const pick = (id: string) => {
    setChannelId(id);
    setThreadId(null);
    setDrafting(false);
    setNavOpen(false);
  };

  const open = (id: string | null) => {
    const found = threads.find((t) => t.id === id);
    if (found) setChannelId(found.channelId);
    setThreadId(id);
    setDrafting(false);
    setNavOpen(false);
  };

  const draft = (on = true) => {
    setDrafting(on);
    setNavOpen(false);
    if (on) setThreadId(null);
  };

  return {
    threads,
    channel: CHANNELS.find((c) => c.id === channelId)!,
    channelThreads: threads.filter((t) => t.channelId === channelId),
    thread: threads.find((t) => t.id === threadId) ?? null,
    drafting,
    navOpen,
    setNavOpen,
    patch,
    send,
    create,
    pick,
    open,
    draft,
  };
}

export type App = ReturnType<typeof useAppState>;
export const Ctx = createContext<App>(null!);
export const useApp = () => useContext(Ctx);
