import type { Automation, Channel, Item, ServerEvent, Status, Thread } from '@acocrew/shared';
import { expect, test, vi } from 'vite-plus/test';
import { connect, needsYou, openThread, orderChannels, pinnedOf, reduce, START, useApp } from './store';

const repo = (name: string): Channel => ({ id: name, name, path: `/home/me/${name}` });
const names = (state: typeof START) => state.channels.map((channel) => channel.name);

test('a new order moves the repositories, and one the order does not name stays last', () => {
  const state = { ...START, channels: ['shop', 'blog', 'journal'].map(repo) };
  expect(names(reduce(state, { type: 'order', ids: ['journal', 'shop', 'blog'] }))).toEqual([
    'journal',
    'shop',
    'blog',
  ]);
  // Someone dragged before this browser's new repository reached them.
  expect(names(reduce(state, { type: 'order', ids: ['blog', 'shop'] }))).toEqual(['blog', 'shop', 'journal']);
});

// A thread as the server sends it: last changed at 100, with `me` in it.
const thread = (status: Status, people = ['me']) => ({ id: 't', status, people, updatedAt: 100 }) as Thread;

test('a thread needs you when Claude waits for an answer, or stopped with something you have not seen', () => {
  const needs = (status: Status, seenAt?: number, people?: string[]) =>
    needsYou(thread(status, people), seenAt === undefined ? {} : { t: seenAt }, 'me');
  // Finished or failed: until you have seen it. Never opened counts as not seen.
  for (const stopped of ['done', 'failed'] as const) {
    expect(needs(stopped)).toBe(true);
    expect(needs(stopped, 99)).toBe(true);
    expect(needs(stopped, 100)).toBe(false);
  }
  // A question or an approval: until someone answers, seen or not.
  expect(needs('needs', 100)).toBe(true);
  // Still busy: nothing to look at yet.
  expect(needs('working')).toBe(false);
  expect(needs('waiting')).toBe(false);
  // A thread you never wrote in is someone else's to look at.
  expect(needs('done', undefined, ['teammate'])).toBe(false);
  expect(needs('needs', undefined, ['teammate'])).toBe(false);
});

test('a pin reaches the list though the thread is no newer, and pinned threads come out newest pin first', () => {
  const rows = [
    { ...thread('done'), id: 'a', pinnedAt: 5 },
    { ...thread('done'), id: 'b', pinnedAt: null },
    { ...thread('done'), id: 'c', pinnedAt: 9 },
  ];
  expect(pinnedOf(rows).map((t) => t.id)).toEqual(['c', 'a']);
  // Pinning leaves `updatedAt` as it is.
  let state = reduce({ ...START, threads: rows }, { type: 'thread', thread: { ...rows[1], pinnedAt: 12 } });
  expect(pinnedOf(state.threads).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  state = reduce(state, { type: 'thread', thread: { ...rows[2], pinnedAt: null } });
  expect(pinnedOf(state.threads).map((t) => t.id)).toEqual(['b', 'a']);
});

test('what was seen comes with the first message, and is added to as threads are looked at', () => {
  const hello: ServerEvent = {
    type: 'hello',
    channels: [],
    threads: [],
    people: [],
    seen: { a: 1, b: 2 },
    automations: [],
    utcOffset: 420,
  };
  const state = reduce(reduce(START, hello), { type: 'seen', seen: { b: 5, c: 7 } });
  expect(state.seen).toEqual({ a: 1, b: 5, c: 7 });
  expect(state.utcOffset).toBe(420);
  // A reconnect brings what the server has, which is what counts.
  expect(reduce(state, hello).seen).toEqual(hello.seen);
});

test('an automation is added, changed and taken away, and the threads it started stay without it', () => {
  const digest = { id: 'a', text: 'write a digest', on: true } as Automation;
  const started = { ...thread('done'), automationId: 'a' };
  const other = { ...thread('done'), id: 'u', automationId: 'b' };
  let state = reduce({ ...START, threads: [started, other] }, { type: 'automation', automation: digest });
  state = reduce(state, { type: 'automation', automation: { ...digest, on: false } });
  expect(state.automations).toEqual([{ ...digest, on: false }]);

  state = reduce(state, { type: 'automation-gone', id: 'a' });
  expect(state.automations).toEqual([]);
  expect(state.threads.map((t) => t.automationId)).toEqual([null, 'b']);
});

test('a thread the person may no longer see leaves the list, and comes back when it is shared again', () => {
  const rows = [
    { ...thread('done'), id: 'a' },
    { ...thread('done'), id: 'b' },
  ];
  let state = reduce({ ...START, threads: rows }, { type: 'thread-gone', id: 'a' });
  expect(state.threads.map((t) => t.id)).toEqual(['b']);
  // Sharing is not news, so the thread comes back no newer than it left.
  state = reduce(state, { type: 'thread', thread: rows[0] });
  expect(state.threads.map((t) => t.id)).toEqual(['b', 'a']);
});

// A stand-in for the browser's socket, which a test can speak through as the server.
class Socket {
  static OPEN = 1;
  static last: Socket;
  readyState = 1;
  sent: string[] = [];
  onopen = () => {};
  onmessage: (message: { data: string }) => void = () => {};
  onclose = () => {};
  constructor() {
    Socket.last = this;
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {}
  says(event: ServerEvent) {
    this.onmessage({ data: JSON.stringify(event) });
  }
}

const HELLO: ServerEvent = {
  type: 'hello',
  channels: ['shop', 'blog'].map(repo),
  threads: [],
  people: [],
  seen: {},
  automations: [],
  utcOffset: 0,
};

test('the app fills up from the socket, follows the open thread, and forgets it all when it hangs up', () => {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { origin: 'http://here' });
  const recheck = vi.fn(async () => {});
  const hangUp = connect(recheck);
  expect(useApp.getState().ready).toBe(false);

  Socket.last.says(HELLO);
  expect(useApp.getState()).toMatchObject({ ready: true, online: true, channels: HELLO.channels });

  openThread('t');
  expect(JSON.parse(Socket.last.sent[0])).toEqual({ type: 'open', threadId: 't' });
  Socket.last.says({ type: 'items', threadId: 't', items: [] });
  // What happens in a thread that is not on screen is left out.
  Socket.last.says({ type: 'items', threadId: 'other', items: [{ id: 'i' } as Item] });
  expect(useApp.getState().items).toEqual([]);

  // The line drops: the screens stay, the server is asked who is logged in, and the open thread is asked for again.
  const first = Socket.last;
  vi.useFakeTimers();
  first.onclose();
  expect(useApp.getState()).toMatchObject({ ready: true, online: false });
  expect(recheck).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);
  vi.useRealTimers();
  expect(Socket.last).not.toBe(first);
  Socket.last.onopen();
  expect(JSON.parse(Socket.last.sent[0])).toEqual({ type: 'open', threadId: 't' });

  hangUp();
  expect(useApp.getState()).toMatchObject({ ...START, navOpen: false });
});

test('a new order shows right away, and the old one comes back when the server turns it down', async () => {
  useApp.setState({ channels: ['shop', 'blog'].map(repo) });
  const shown = () => useApp.getState().channels.map((channel) => channel.name);
  let refuse = () => {};
  const refused = new Promise<Response>((_, reject) => (refuse = () => reject(new Error('no'))));
  vi.stubGlobal('fetch', () => refused);
  orderChannels(['blog', 'shop']);
  expect(shown()).toEqual(['blog', 'shop']);
  refuse();
  await vi.waitFor(() => expect(shown()).toEqual(['shop', 'blog']));
});

test('the GitHub accounts of the machine are not known until the server says, and follow a switch by anyone', () => {
  expect(START.github).toBeNull();
  const accounts = [
    { host: 'github.com', login: 'monalisa', active: false },
    { host: 'github.com', login: 'hubot', active: true },
  ];
  expect(reduce(START, { type: 'github', accounts }).github).toEqual(accounts);
});
