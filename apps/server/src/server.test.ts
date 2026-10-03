import {
  HEALTH_PATH,
  WS_PATH,
  type Channel,
  type FolderList,
  type Item,
  type ServerEvent,
  type Thread,
} from '@acocrew/shared';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { WebSocket } from 'ws';
import { openDb, type Db } from './db.ts';
import type { QueryFn } from './runner.ts';
import { threads } from './schema.ts';
import { startServer } from './server.ts';

// Real messages recorded from the Claude Agent SDK: turn 1 writes notes.txt, turn 2 reads two files.
const RECORDED: SDKMessage[] = readFileSync(new URL('./fixtures/two-turns.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

// A stand-in for Claude. Each user message gets the next recorded turn as its answer.
function fakeClaude(script = RECORDED) {
  const calls: Parameters<QueryFn>[0]['options'][] = [];
  let closed = 0;
  let hold: { before: (msg: SDKMessage) => boolean; released: Promise<void> } | null = null;
  let pos = 0;
  const query: QueryFn = ({ prompt, options }) => {
    calls.push(options);
    async function* answer() {
      for await (const _ of prompt) {
        for (;;) {
          const msg = script[pos++];
          if (!msg) throw new Error('Claude crashed');
          if (hold?.before(msg)) await hold.released;
          yield msg;
          if (msg.type === 'result') break;
        }
      }
    }
    return Object.assign(answer(), { close: () => void closed++ });
  };
  // Stops Claude just before the first message that matches, until the returned function is called.
  const pause = (before: (msg: SDKMessage) => boolean) => {
    let release = () => {};
    hold = { before, released: new Promise<void>((resolve) => (release = resolve)) };
    return release;
  };
  return { query, calls, pause, closed: () => closed };
}

const workDir = join(homedir(), 'acocrew-work');
mkdirSync(workDir, { recursive: true });
const home = mkdtempSync(join(workDir, 'test-home-'));
mkdirSync(join(home, 'code', 'shop', '.git'), { recursive: true });
mkdirSync(join(home, 'code', 'notes'));
mkdirSync(join(home, '.secret'));
symlinkSync('/etc', join(home, 'way-out'));
afterAll(() => rmSync(home, { recursive: true }));

let db: Db;
let claude: ReturnType<typeof fakeClaude>;
let server: Awaited<ReturnType<typeof startServer>>;
let sockets: WebSocket[];

beforeEach(async () => {
  db = openDb(':memory:');
  claude = fakeClaude();
  server = await startServer(0, { db, query: claude.query, home }); // 0 = any free port
  sockets = [];
});
afterEach(() => {
  vi.useRealTimers();
  for (const socket of sockets) socket.close();
  server.close();
});

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (path: string, body: unknown) => fetch(url(path), { method: 'POST', body: JSON.stringify(body) });

// A browser tab: remembers every event and can wait for one.
async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
  sockets.push(socket);
  const events: ServerEvent[] = [];
  let check = () => {};
  socket.on('message', (data) => {
    events.push(JSON.parse(String(data)));
    check();
  });
  type Of<K> = Extract<ServerEvent, { type: K }>;
  const until = <K extends ServerEvent['type']>(type: K, match: (event: Of<K>) => boolean = () => true) =>
    new Promise<Of<K>>((resolve) => {
      check = () => {
        const found = events.find((e): e is Of<K> => e.type === type && match(e as Of<K>));
        if (found) resolve(found);
      };
      check();
    });
  const ended = (threadId: string) =>
    events.filter((e) => e.type === 'thread' && e.thread.id === threadId && e.thread.status !== 'working');
  const hello = await until('hello');
  return {
    events,
    hello,
    until,
    // Opens a thread and waits for everything in it so far.
    async open(threadId: string) {
      socket.send(JSON.stringify({ type: 'open', threadId }));
      await until('items', (e) => e.threadId === threadId);
    },
    // Waits until the thread has finished `count` turns.
    turnsDone: (threadId: string, count: number) => until('thread', (e) => e === ended(threadId)[count - 1]),
    // What the screen would show: replays item and delta events the way the web app does.
    screen(threadId: string) {
      let items: Item[] = [];
      for (const e of events) {
        if (e.type === 'items' && e.threadId === threadId) items = e.items;
        if (e.type === 'item' && e.threadId === threadId) {
          const { item } = e;
          items = items.some((i) => i.id === item.id)
            ? items.map((i) => (i.id === item.id ? item : i))
            : [...items, item];
        }
        if (e.type === 'delta' && e.threadId === threadId) {
          items = items.map((i) => (i.id === e.itemId && i.kind === 'message' ? { ...i, text: i.text + e.text } : i));
        }
      }
      const state = (tool: Extract<Item, { kind: 'tool' }>) =>
        tool.failed ? 'failed' : tool.done ? 'done' : 'running';
      return items.map((i) => (i.kind === 'tool' ? `${i.name} ${state(i)}` : `${i.kind}: ${i.text}`));
    },
  };
}

// Three moments to stop Claude at: before it does anything, halfway through writing a bubble, and when a
// bubble is fully written but not yet final.
const turnStart = (msg: SDKMessage) => msg.type === 'system';
const midBubble = (msg: SDKMessage) =>
  msg.type === 'stream_event' &&
  msg.event.type === 'content_block_delta' &&
  'text' in msg.event.delta &&
  msg.event.delta.text === ' created';
const bubbleEnd = (msg: SDKMessage) => msg.type === 'assistant' && msg.message.content[0].type === 'text';

const HAIKU = { model: 'claude-haiku-4-5-20251001', effort: 'low' };

async function addChannel() {
  const res = await post('/api/channels', { path: join(home, 'code', 'shop') });
  return (await res.json()) as Channel;
}

async function startThread(text: string) {
  const channel = await addChannel();
  const res = await post('/api/threads', { channelId: channel.id, text, ...HAIKU });
  return (await res.json()) as Thread;
}

const TURN_1 = [
  'message: make notes',
  'Write done',
  'message: Done — notes.txt is created with the line "hello from acocrew".',
];

test('health check answers ok', async () => {
  const res = await fetch(url(HEALTH_PATH));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('unknown paths are 404', async () => {
  expect((await fetch(url('/nope'))).status).toBe(404);
});

test('folders: lists visible folders and marks git repositories', async () => {
  const top = await (await fetch(url('/api/folders'))).json();
  expect(top).toEqual({
    path: home,
    parent: null,
    folders: [{ name: 'code', path: join(home, 'code'), isRepo: false }],
  });

  const res = await fetch(url(`/api/folders?path=${encodeURIComponent(join(home, 'code'))}`));
  const code = (await res.json()) as FolderList;
  expect(code.parent).toBe(home);
  expect(code.folders.map((f) => [f.name, f.isRepo])).toEqual([
    ['notes', false],
    ['shop', true],
  ]);
});

test('folders: nothing outside the home folder can be listed', async () => {
  for (const path of ['/etc', join(home, '..'), join(home, 'way-out'), join(home, 'missing')]) {
    const res = await fetch(url(`/api/folders?path=${encodeURIComponent(path)}`));
    expect(res.status, path).toBe(404);
  }
});

test('add repository: only a git repository inside home becomes a channel, once', async () => {
  for (const path of [join(home, 'code', 'notes'), '/etc', join(home, 'way-out'), undefined]) {
    expect((await post('/api/channels', { path })).status, String(path)).toBe(400);
  }
  const tab = await connect();
  const channel = await addChannel();
  expect(channel).toEqual({ id: channel.id, name: 'shop', path: join(home, 'code', 'shop') });
  expect(await tab.until('channel')).toEqual({ type: 'channel', channel });
  expect(await addChannel()).toEqual(channel);
  expect((await connect()).hello.channels).toEqual([channel]);
});

test('a thread runs Claude in the repo folder and streams two turns through one process', async () => {
  const release = claude.pause(turnStart);
  const tab = await connect();
  const thread = await startThread('make notes\nplease');
  expect(thread).toMatchObject({ title: 'make notes', status: 'working', ...HAIKU });
  await tab.open(thread.id);
  release();

  const first = await tab.turnsDone(thread.id, 1);
  expect(first).toMatchObject({ thread: { status: 'done' } });
  expect(tab.screen(thread.id)).toEqual(['message: make notes\nplease', ...TURN_1.slice(1)]);
  // The answer arrived in pieces before it arrived whole.
  expect(tab.events.filter((e) => e.type === 'delta').length).toBeGreaterThan(5);

  await post(`/api/threads/${thread.id}/messages`, { text: 'what is in them?', ...HAIKU });
  await tab.turnsDone(thread.id, 2);
  const screen = tab.screen(thread.id);
  expect(screen.slice(3, 6)).toEqual(['message: what is in them?', 'Read done', 'Read done']);
  expect(screen).toHaveLength(7);

  expect(claude.calls).toHaveLength(1);
  expect(claude.calls[0]).toMatchObject({ cwd: join(home, 'code', 'shop'), resume: undefined, ...HAIKU });

  // A tab that opens the thread later sees the same thing, from the database.
  const late = await connect();
  expect(late.hello.threads).toMatchObject([{ id: thread.id, status: 'done' }]);
  await late.open(thread.id);
  expect(late.screen(thread.id)).toEqual(screen);
});

test('a tab that opens a thread while Claude is writing gets the words so far, then the rest', async () => {
  const release = claude.pause(midBubble);
  const thread = await startThread('make notes');

  const late = await connect();
  await late.open(thread.id);
  expect(late.screen(thread.id)).toEqual([TURN_1[0], TURN_1[1], 'message: Done — notes.txt is']);

  release();
  await late.turnsDone(thread.id, 1);
  expect(late.events.filter((e) => e.type === 'delta').length).toBeGreaterThan(5);
  expect(late.screen(thread.id)).toEqual(TURN_1);
});

test('a message sent while Claude is busy waits its turn', async () => {
  const release = claude.pause(bubbleEnd);
  const tab = await connect();
  const thread = await startThread('make notes');
  await tab.open(thread.id);
  await post(`/api/threads/${thread.id}/messages`, { text: 'what is in them?', ...HAIKU });
  release();
  await tab.turnsDone(thread.id, 2);
  const screen = tab.screen(thread.id);
  // The second message shows up right away, under the bubble Claude was writing, and is answered after it.
  expect(screen.slice(0, 4)).toEqual([...TURN_1, 'message: what is in them?']);
  expect(screen).toHaveLength(7);
  expect(claude.calls).toHaveLength(1);

  // Same order after a reload.
  const late = await connect();
  await late.open(thread.id);
  expect(late.screen(thread.id)).toEqual(screen);
});

test('changing the model starts a new Claude process that resumes the same conversation', async () => {
  const tab = await connect();
  const thread = await startThread('make notes');
  await tab.turnsDone(thread.id, 1);
  await post(`/api/threads/${thread.id}/messages`, {
    text: 'what is in them?',
    model: 'claude-opus-5-5',
    effort: 'high',
  });
  const second = await tab.turnsDone(thread.id, 2);
  expect(second).toMatchObject({ thread: { status: 'done', model: 'claude-opus-5-5', effort: 'high' } });
  expect(claude.closed()).toBe(1);
  expect(claude.calls).toHaveLength(2);
  expect(claude.calls[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', resume: RECORDED[0].session_id });
});

test('when Claude fails, the thread shows the error and asks for attention, and the next message still works', async () => {
  server.close();
  const upToFirstTool = RECORDED.findIndex((m) => m.type === 'user');
  claude = fakeClaude([...RECORDED.slice(0, upToFirstTool), undefined as never, ...RECORDED]);
  server = await startServer(0, { db, query: claude.query, home });

  const tab = await connect();
  const thread = await startThread('make notes');
  await tab.open(thread.id);
  const failed = await tab.turnsDone(thread.id, 1);
  expect(failed).toMatchObject({ thread: { status: 'needs' } });
  expect(tab.screen(thread.id)).toEqual(['message: make notes', 'Write failed', 'error: Claude crashed']);

  await post(`/api/threads/${thread.id}/messages`, { text: 'try again', ...HAIKU });
  const retried = await tab.turnsDone(thread.id, 2);
  expect(retried).toMatchObject({ thread: { status: 'done' } });
  expect(claude.calls).toHaveLength(2);
});

test('a thread that was mid-answer when the server stopped asks for attention after a restart', async () => {
  claude.pause(bubbleEnd); // never released: the old server dies mid-answer
  const tab = await connect();
  const thread = await startThread('make notes');
  await tab.open(thread.id);
  server.close();

  server = await startServer(0, { db, query: fakeClaude().query, home });
  const after = await connect();
  expect(after.hello.threads).toMatchObject([{ id: thread.id, status: 'needs' }]);
  await after.open(thread.id);
  const screen = after.screen(thread.id);
  expect(screen.slice(0, 2)).toEqual(TURN_1.slice(0, 2));
  expect(screen[2]).toMatch(/^error: The server restarted/);
});

test('a Claude process nobody talks to for ten minutes is closed, and the next message resumes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const tab = await connect();
  const thread = await startThread('make notes');
  await tab.turnsDone(thread.id, 1);
  expect(claude.closed()).toBe(0);
  vi.advanceTimersByTime(10 * 60_000);
  expect(claude.closed()).toBe(1);
  vi.useRealTimers();

  await post(`/api/threads/${thread.id}/messages`, { text: 'what is in them?', ...HAIKU });
  await tab.turnsDone(thread.id, 2);
  expect(claude.calls[1]).toMatchObject({ resume: RECORDED[0].session_id });
});

test('requests from another website are refused, our own pages are not', async () => {
  const channel = await addChannel();
  const body = JSON.stringify({ channelId: channel.id, text: 'hi', ...HAIKU });
  const from = (headers: Record<string, string>) => fetch(url('/api/threads'), { method: 'POST', body, headers });
  const viaProxy = { origin: 'https://team.example:5273', 'x-forwarded-host': 'team.example:5273' };
  expect((await from({ origin: 'https://evil.example' })).status).toBe(403);
  expect((await from({ ...viaProxy, origin: 'https://evil.example' })).status).toBe(403);
  expect((await from({ origin: `http://127.0.0.1:${server.port}` })).status).toBe(200);
  expect((await from(viaProxy)).status).toBe(200);

  // What a page on that site gets when it opens the socket: the refusal's status, or 'open'.
  const socketFrom = (headers: Record<string, string>) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`, { headers });
    return new Promise((resolve) => {
      socket.once('unexpected-response', (_, res) => resolve(res.statusCode));
      socket.once('open', () => {
        socket.close();
        resolve('open');
      });
    });
  };
  expect(await socketFrom({ origin: 'https://evil.example' })).toBe(403);
  expect(await socketFrom(viaProxy)).toBe('open');
});

test('bad requests are turned away', async () => {
  const thread = await startThread('make notes');
  const bad = [
    ['/api/threads', { channelId: 'nope', text: 'hi', ...HAIKU }],
    ['/api/threads', { channelId: thread.channelId, text: '  ', ...HAIKU }],
    ['/api/threads', { channelId: thread.channelId, text: 'hi', model: 'gpt', effort: 'low' }],
    [`/api/threads/${thread.id}/messages`, { text: 'hi', model: HAIKU.model, effort: 'huge' }],
    ['/api/threads/nope/messages', { text: 'hi', ...HAIKU }],
  ] as const;
  for (const [path, body] of bad) expect((await post(path, body)).status, JSON.stringify(body)).toBe(400);
  expect(db.select().from(threads).where(eq(threads.channelId, thread.channelId)).all()).toHaveLength(1);
});
