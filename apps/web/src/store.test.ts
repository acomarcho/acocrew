import {
  contextWindow,
  type Automation,
  type Channel,
  type Chat,
  type Item,
  type Me,
  type ServerEvent,
  type Status,
  type Thread,
} from '@acocrew/shared';
import { expect, test, vi } from 'vite-plus/test';
import {
  closeThread,
  connect,
  githubChoices,
  needsYou,
  openThread,
  orderChannels,
  pinnedOf,
  reduce,
  START,
  switchGithub,
  useApp,
} from './store';

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

test('the size of the context window follows the model and what was picked for it', () => {
  expect(contextWindow({ model: 'claude-opus-5-5', context: '1m' })).toBe(1_000_000);
  expect(contextWindow({ model: 'claude-opus-5-5', context: '200k' })).toBe(200_000);
  // A model without the 1M window has the standard one, whatever was picked.
  expect(contextWindow({ model: 'claude-haiku-4-5-20251001', context: '1m' })).toBe(200_000);
});

test('what was seen comes with the first message, and is added to as threads are looked at', () => {
  const hello: ServerEvent = {
    type: 'hello',
    channels: [],
    threads: [],
    people: [],
    seen: { a: 1, b: 2 },
    unread: {},
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
  unread: {},
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
  Socket.last.says({ type: 'items', threadId: 't', items: [], chats: [], chatSeen: 0 });
  // What happens in a thread that is not on screen is left out.
  Socket.last.says({ type: 'items', threadId: 'other', items: [{ id: 'i' } as Item], chats: [], chatSeen: 0 });
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

test('a GitHub account is offered to switch to only where its host has more than one logged in', () => {
  const account = (host: string, login: string, active = false) => ({ host, login, active });
  const mona = account('github.com', 'monalisa', true);
  const hubot = account('github.com', 'hubot');
  const work = account('github.acme.example', 'mona-acme', true);
  const bot = account('github.acme.example', 'deploy-bot');
  expect(githubChoices([mona, hubot])).toEqual([[mona, hubot]]);
  // Nothing to pick: the server has not said, the machine has no gh, nobody is logged in, or just one is.
  for (const none of [null, [], [mona]]) expect(githubChoices(none)).toEqual([]);
  // A company's own GitHub next to github.com: each host is a choice of its own, and one with a single
  // account is none.
  expect(githubChoices([mona, work, hubot])).toEqual([[mona, hubot]]);
  expect(githubChoices([mona, hubot, work, bot])).toEqual([
    [mona, hubot],
    [work, bot],
  ]);
});

test('a switch of GitHub account shows right away, and is taken back if the server turns it down', async () => {
  const mona = { host: 'github.com', login: 'monalisa', active: true };
  const hubot = { host: 'github.com', login: 'hubot', active: false };
  const work = { host: 'github.acme.example', login: 'mona-acme', active: true };
  const before = [mona, hubot, work];
  // Only the picked account's host changes.
  const after = [{ ...mona, active: false }, { ...hubot, active: true }, work];
  const shown = () => useApp.getState().github;
  // The server answers when the test lets it: with how the accounts are now, or with why not.
  type Reply = { ok: boolean; body: unknown };
  let answer!: (reply: Reply) => void;
  const server = async () => {
    const { ok, body } = await new Promise<Reply>((resolve) => (answer = resolve));
    return { ok, status: ok ? 200 : 400, json: async () => body };
  };
  vi.stubGlobal('fetch', vi.fn(server));

  useApp.setState({ github: before });
  let done = switchGithub(hubot);
  expect(shown()).toEqual(after);
  answer({ ok: true, body: after });
  await done;
  expect(shown()).toEqual(after);

  useApp.setState({ github: before });
  done = switchGithub(hubot);
  expect(shown()).toEqual(after);
  answer({ ok: false, body: { error: 'not logged in to github.com account hubot' } });
  await expect(done).rejects.toThrow('not logged in to github.com account hubot');
  expect(shown()).toEqual(before);
  vi.unstubAllGlobals();
});

// A chat message as the server sends it.
const chat = (id: number, userId: string, tagged: string[] = []): Chat => ({
  id,
  at: id,
  userId,
  text: `#${id}`,
  tagged,
});

test('the chat of the open thread comes with it and grows, and what is new in every thread is kept up to date', () => {
  let state = reduce(START, { ...HELLO, unread: { t: { count: 2, tagged: true } } });
  expect(state.unread).toEqual({ t: { count: 2, tagged: true } });
  state = reduce(state, { type: 'open', threadId: 't' });
  // The first message the person had not had on screen is where the "New" line goes.
  const chats = [chat(1, 'ann'), chat(2, 'me'), chat(3, 'ann'), chat(4, 'ann')];
  state = reduce(state, { type: 'items', threadId: 't', items: [], chats, chatSeen: 2 });
  expect([state.chats, state.chatNew, state.chatSeen]).toEqual([chats, 3, 2]);
  // A message that comes in while the thread is open is added once, however often it arrives.
  state = reduce(state, { type: 'chat', threadId: 't', chat: chat(5, 'ann') });
  state = reduce(state, { type: 'chat', threadId: 't', chat: chat(5, 'ann') });
  // One for another thread is not shown here.
  state = reduce(state, { type: 'chat', threadId: 'other', chat: chat(6, 'ann') });
  expect([state.chats.map((one) => one.id), state.chatNew]).toEqual([[1, 2, 3, 4, 5], 3]);

  // Only the threads the server names change.
  state = reduce(state, { type: 'unread', unread: { other: { count: 1, tagged: false } } });
  state = reduce(state, { type: 'unread', unread: { t: { count: 0, tagged: false } } });
  expect(state.unread).toEqual({ t: { count: 0, tagged: false }, other: { count: 1, tagged: false } });

  // Everything was seen already: no line. Another thread starts with nothing until its own chat arrives.
  expect(reduce(state, { type: 'items', threadId: 't', items: [], chats, chatSeen: 4 }).chatNew).toBeNull();
  expect(reduce(state, { type: 'open', threadId: 'other' })).toMatchObject({ chats: [], chatNew: null, chatSeen: 0 });
});

test('a tag pops up, unless the person is looking at that thread or it tags someone else', () => {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { origin: 'http://here' });
  const screen = { hidden: false };
  vi.stubGlobal('document', screen);
  const hangUp = connect(async () => {});
  useApp.setState({ login: { id: 'me' } as Me });
  Socket.last.says(HELLO);
  openThread('t');
  const says = (threadId: string, tagged: string[]) => {
    useApp.setState({ tag: null });
    Socket.last.says({ type: 'chat', threadId, chat: chat(1, 'ann', tagged) });
    return useApp.getState().tag;
  };
  expect(says('other', ['me'])).toEqual({ threadId: 'other', chat: chat(1, 'ann', ['me']) });
  expect(says('other', ['bob'])).toBeNull();
  expect(says('other', [])).toBeNull();
  // The thread on screen: nothing to point at, unless the browser tab itself is out of sight.
  expect(says('t', ['me'])).toBeNull();
  screen.hidden = true;
  expect(says('t', ['me'])).toMatchObject({ threadId: 't' });
  // Once the thread is off the screen, a tag in it is news like any other, and its chat is no longer kept.
  screen.hidden = false;
  closeThread();
  expect(says('t', ['me'])).toMatchObject({ threadId: 't' });
  expect(useApp.getState()).toMatchObject({ openId: null, items: null, chats: [] });

  hangUp();
  expect(useApp.getState().tag).toBeNull();
  vi.unstubAllGlobals();
});
