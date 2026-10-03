import {
  HEALTH_PATH,
  WS_PATH,
  type Answer,
  type Channel,
  type FolderList,
  type Item,
  type ServerEvent,
  type Status,
  type Thread,
} from '@acocrew/shared';
import type { PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vite-plus/test';
import { WebSocket } from 'ws';
import { openDb, type Db } from './db.ts';
import type { QueryFn } from './runner.ts';
import { threads } from './schema.ts';
import { startServer } from './server.ts';

// A line of a recording (see fixtures/record.ts): a real message from Claude, or a marker for what the
// outside world did at that point.
type Ask = { toolName: string; input: Record<string, unknown>; toolUseID: string; suggestions?: never };
type Marker = { _user: true } | { _ask: Ask } | { _quiet: true } | { _crash: true };
type Line = SDKMessage | Marker;

const recording = (name: string): Line[] =>
  readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

// Turn 1 writes notes.txt, turn 2 reads two files.
const TWO_TURNS = recording('two-turns');
const SESSION = (TWO_TURNS[1] as SDKMessage).session_id;

// A stand-in for Claude that plays a recording back. Like the real thing it waits for a user message only
// where the recording had one, asks for permission where the recording did, and otherwise talks on its own.
function fakeClaude(script: Line[]) {
  const calls: Parameters<QueryFn>[0]['options'][] = [];
  const decisions: PermissionResult[] = [];
  // What each user message handed to Claude held.
  const said: SDKUserMessage['message']['content'][] = [];
  const holds: { before: (msg: SDKMessage) => boolean; released: Promise<void> }[] = [];
  const releases: (() => void)[] = [];
  let closed = 0;
  let interrupted = 0;
  let abandoned = 0;
  let pos = 0;

  const query: QueryFn = ({ prompt, options }) => {
    calls.push(options);
    const abort = new AbortController();
    const users = prompt[Symbol.asyncIterator]();
    let kill = () => {};
    const killed = new Promise<'killed'>((resolve) => (kill = () => resolve('killed')));

    let dead = false;
    async function* talk() {
      try {
        yield* play();
      } finally {
        // The reader walked away while the process was still alive. The real SDK kills the process then.
        if (!dead) abandoned++;
      }
    }
    async function* play() {
      for (;;) {
        const line = script[pos];
        // Nothing left to say: sit idle like a real process until it is closed.
        if (!line) return void (await killed);
        if ('_user' in line) {
          const next = await Promise.race([users.next(), killed]);
          if (next === 'killed') return;
          said.push(next.value.message.content);
        } else if ('_ask' in line) {
          const { toolName, input, toolUseID, suggestions } = line._ask;
          pos++;
          const context = { signal: abort.signal, suggestions, toolUseID, requestId: toolUseID };
          decisions.push((await options.canUseTool!(toolName, input, context))!);
          continue;
        } else if ('_crash' in line) {
          pos++;
          throw new Error('Claude crashed');
        } else if ('_quiet' in line) {
          await new Promise((resolve) => setImmediate(resolve));
        } else {
          const hold = holds.findIndex((h) => h.before(line));
          if (hold >= 0 && (await Promise.race([holds.splice(hold, 1)[0].released, killed])) === 'killed') return;
          pos++;
          yield line;
          continue;
        }
        pos++;
      }
    }

    return Object.assign(talk(), {
      // Like the real thing, an interrupt makes Claude wrap up: whatever it was holding back comes out.
      async interrupt() {
        interrupted++;
        for (const release of releases) release();
        await new Promise((resolve) => setImmediate(resolve));
      },
      close() {
        closed++;
        dead = true;
        abort.abort();
        kill();
        // A killed process never finishes its turn. The next one starts at the next user message.
        while (script[pos] && !('_user' in script[pos])) pos++;
      },
    });
  };

  // Stops Claude just before the first message that matches, until the returned function is called.
  const pause = (before: (msg: SDKMessage) => boolean) => {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    holds.push({ before, released });
    releases.push(release);
    return release;
  };
  return {
    query,
    calls,
    decisions,
    said,
    pause,
    closed: () => closed,
    interrupted: () => interrupted,
    abandoned: () => abandoned,
  };
}

const workDir = join(homedir(), 'acocrew-work');
mkdirSync(workDir, { recursive: true });
const home = mkdtempSync(join(workDir, 'test-home-'));
mkdirSync(join(home, 'code', 'shop', '.git'), { recursive: true });
mkdirSync(join(home, 'code', 'notes'));
mkdirSync(join(home, '.secret'));
symlinkSync('/etc', join(home, 'way-out'));
const images = join(home, '.acocrew', 'attachments');
afterAll(() => rmSync(home, { recursive: true }));

let db: Db;
let claude: ReturnType<typeof fakeClaude>;
let server: Awaited<ReturnType<typeof startServer>>;
let sockets: WebSocket[];

// Starts (or restarts) the server with a Claude that plays `script`.
async function serve(script: Line[]) {
  server?.close();
  claude = fakeClaude(script);
  server = await startServer(0, { db, query: claude.query, home, images }); // 0 = any free port
}

beforeEach(async () => {
  db = openDb(':memory:');
  sockets = [];
  await serve(TWO_TURNS);
});
afterEach(() => {
  vi.useRealTimers();
  for (const socket of sockets) socket.close();
  server.close();
});

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (path: string, body?: unknown) => fetch(url(path), { method: 'POST', body: JSON.stringify(body) });

// What one item looks like on screen, as a short line of text.
function line(item: Item): string {
  if (item.kind === 'todos') return `todos: ${item.todos.map((t) => `${t.subject}=${t.status}`).join(', ')}`;
  if (item.kind !== 'tool') return `${item.kind}: ${item.text}`;
  if (item.ask === 'pending' && !item.done) return `${item.name} asking`;
  return `${item.name} ${item.failed ? 'failed' : item.done ? 'done' : 'running'}`;
}

// A browser tab: remembers every event and can wait for one.
async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
  sockets.push(socket);
  const events: ServerEvent[] = [];
  let check = () => {};
  // How far each kind of event has been waited for.
  const read: Record<string, number> = {};
  socket.on('message', (data) => {
    events.push(JSON.parse(String(data)));
    check();
  });
  type Of<K> = Extract<ServerEvent, { type: K }>;
  // Waits for the next event of this type that has not been waited for before.
  const until = <K extends ServerEvent['type']>(type: K, match: (event: Of<K>) => boolean = () => true) =>
    new Promise<Of<K>>((resolve) => {
      check = () => {
        const at = events.findIndex((e, i) => i >= (read[type] ?? 0) && e.type === type && match(e as Of<K>));
        if (at < 0) return;
        read[type] = at + 1;
        check = () => {};
        resolve(events[at] as Of<K>);
      };
      check();
    });
  const hello = await until('hello');

  function items(threadId: string) {
    let list: Item[] = [];
    for (const e of events) {
      if (e.type === 'items' && e.threadId === threadId) list = e.items;
      if (e.type === 'item' && e.threadId === threadId) {
        const { item } = e;
        list = list.some((i) => i.id === item.id) ? list.map((i) => (i.id === item.id ? item : i)) : [...list, item];
      }
      if (e.type === 'delta' && e.threadId === threadId) {
        list = list.map((i) => (i.id === e.itemId && i.kind === 'message' ? { ...i, text: i.text + e.text } : i));
      }
    }
    return list;
  }

  return {
    events,
    hello,
    until,
    items,
    // Opens a thread and waits for everything in it so far.
    async open(threadId: string) {
      socket.send(JSON.stringify({ type: 'open', threadId }));
      await until('items', (e) => e.threadId === threadId);
    },
    // Waits until the thread next reports this status.
    status: async (threadId: string, status: Status) =>
      (await until('thread', (e) => e.thread.id === threadId && e.thread.status === status)).thread,
    // What the screen would show: replays the events the way the web app does. What a subagent did is
    // listed under its card, indented.
    screen(threadId: string) {
      const all = items(threadId);
      const under = (parent?: string, indent = ''): string[] =>
        all.filter((i) => i.parent === parent).flatMap((i) => [indent + line(i), ...under(i.id, `${indent}  `)]);
      return under();
    },
    // Waits until the screen looks right, however it got there.
    shows(threadId: string, right: (screen: string[]) => boolean) {
      return new Promise<void>((resolve) => {
        const look = () => right(this.screen(threadId)) && resolve();
        socket.on('message', look);
        look();
      });
    },
    tool: (threadId: string, name: string) =>
      items(threadId).find((i) => i.kind === 'tool' && i.name === name) as Extract<Item, { kind: 'tool' }>,
  };
}

const HAIKU = { model: 'claude-haiku-4-5-20251001', effort: 'low', context: '1m', fast: false, access: 'full' };
const OPUS = { ...HAIKU, model: 'claude-opus-5-5', effort: 'high' };

async function addChannel() {
  const res = await post('/api/channels', { path: join(home, 'code', 'shop') });
  return (await res.json()) as Channel;
}

async function startThread(text: string, settings: object = HAIKU) {
  const channel = await addChannel();
  const res = await post('/api/threads', { channelId: channel.id, text, ...settings });
  return (await res.json()) as Thread;
}

const say = (thread: Thread, text: string, settings: object = HAIKU) =>
  post(`/api/threads/${thread.id}/messages`, { text, ...settings });
const answer = (thread: Thread, body: Answer) => post(`/api/threads/${thread.id}/answers`, body);

// A tab that has the new thread open before Claude says anything.
async function watch(script: Line[], text: string, settings = HAIKU) {
  await serve(script);
  const release = claude.pause((msg) => msg.type === 'system');
  const tab = await connect();
  const thread = await startThread(text, settings);
  await tab.open(thread.id);
  release();
  return { tab, thread };
}

// Moments to stop Claude at.
const midBubble = (msg: SDKMessage) =>
  msg.type === 'stream_event' &&
  msg.event.type === 'content_block_delta' &&
  'text' in msg.event.delta &&
  msg.event.delta.text === ' created';
const bubbleEnd = (msg: SDKMessage) => msg.type === 'assistant' && msg.message.content[0].type === 'text';
const toolResult = (msg: SDKMessage) => msg.type === 'user';
const taskOver = (msg: SDKMessage) => msg.type === 'system' && msg.subtype === 'task_notification';
const tasksOver = (msg: SDKMessage) =>
  msg.type === 'system' && msg.subtype === 'background_tasks_changed' && !msg.tasks.length;

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

test('with the built web app, one server gives out the app, its files and the api', async () => {
  const web = mkdtempSync(join(workDir, 'test-web-'));
  onTestFinished(() => rmSync(web, { recursive: true }));
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'index.html'), '<html>the app</html>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
  server.close();
  server = await startServer(0, { db, query: claude.query, home, images, web });

  // Any screen's address gets the app, which then shows that screen.
  for (const path of ['/', '/c/some-channel/t/some-thread']) {
    expect(await (await fetch(url(path))).text(), path).toBe('<html>the app</html>');
  }
  expect(await (await fetch(url('/assets/app.js'))).text()).toBe('console.log(1)');
  expect(await (await fetch(url(HEALTH_PATH))).json()).toEqual({ ok: true });
  expect((await fetch(url('/api/nope'))).status).toBe(404);
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
  const { tab, thread } = await watch(TWO_TURNS, 'make notes\nplease');
  expect(thread).toMatchObject({ title: 'make notes', status: 'working', tasks: [], ...HAIKU });

  await tab.status(thread.id, 'done');
  expect(tab.screen(thread.id)).toEqual(['message: make notes\nplease', ...TURN_1.slice(1)]);
  // The answer arrived in pieces before it arrived whole.
  expect(tab.events.filter((e) => e.type === 'delta').length).toBeGreaterThan(5);

  await say(thread, 'what is in them?');
  await tab.status(thread.id, 'working');
  await tab.status(thread.id, 'done');
  const screen = tab.screen(thread.id);
  expect(screen.slice(3, 6)).toEqual(['message: what is in them?', 'Read done', 'Read done']);
  expect(screen).toHaveLength(7);

  expect(claude.calls).toHaveLength(1);
  expect(claude.calls[0]).toMatchObject({ cwd: join(home, 'code', 'shop'), resume: undefined, model: HAIKU.model });

  // A tab that opens the thread later sees the same thing, from the database.
  const late = await connect();
  expect(late.hello.threads).toMatchObject([{ id: thread.id, status: 'done' }]);
  await late.open(thread.id);
  expect(late.screen(thread.id)).toEqual(screen);
});

test('a tool card keeps what went in, what came out and how long it took', async () => {
  const { tab, thread } = await watch(TWO_TURNS, 'make notes');
  await tab.status(thread.id, 'done');
  const write = tab.tool(thread.id, 'Write');
  expect(write.detail).toBe('/home/marcho/acocrew-sample-repo/notes.txt');
  expect(JSON.parse(write.input)).toMatchObject({ content: 'hello from acocrew' });
  expect(write.output).toMatch(/^File created successfully/);
  expect(write.endAt).toBeGreaterThan(write.at);
});

test('a tab that opens a thread while Claude is writing gets the words so far, then the rest', async () => {
  const release = claude.pause(midBubble);
  const thread = await startThread('make notes');

  const late = await connect();
  await late.open(thread.id);
  expect(late.screen(thread.id)).toEqual([TURN_1[0], TURN_1[1], 'message: Done — notes.txt is']);

  release();
  await late.status(thread.id, 'done');
  expect(late.events.filter((e) => e.type === 'delta').length).toBeGreaterThan(5);
  expect(late.screen(thread.id)).toEqual(TURN_1);
});

test('a message sent while Claude is busy shows right away and is answered after, by the same process', async () => {
  const release = claude.pause(bubbleEnd);
  const tab = await connect();
  const thread = await startThread('make notes');
  await tab.open(thread.id);
  // A different model is asked for, but the busy process is left alone.
  await say(thread, 'what is in them?', { ...HAIKU, model: 'claude-opus-5-5' });
  await tab.shows(thread.id, (screen) => screen.at(-1) === 'message: what is in them?');
  expect(tab.screen(thread.id)).toEqual([...TURN_1, 'message: what is in them?']);
  release();
  await tab.status(thread.id, 'done');
  await tab.status(thread.id, 'done');
  const screen = tab.screen(thread.id);
  expect(screen.slice(0, 4)).toEqual([...TURN_1, 'message: what is in them?']);
  expect(screen).toHaveLength(7);
  expect(claude.calls).toHaveLength(1);
  expect(claude.closed()).toBe(0);

  // Same order after a reload.
  const late = await connect();
  await late.open(thread.id);
  expect(late.screen(thread.id)).toEqual(screen);
});

test('changing the model while Claude is idle starts a new process that resumes the same conversation', async () => {
  const tab = await connect();
  const thread = await startThread('make notes');
  await tab.status(thread.id, 'done');
  await say(thread, 'what is in them?', OPUS);
  const done = await tab.status(thread.id, 'done');
  expect(done).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
  expect(claude.closed()).toBe(1);
  expect(claude.calls).toHaveLength(2);
  expect(claude.calls[1]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'high', resume: SESSION });
});

const SMALL = { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' };

test.each([
  ['Opus has both extras', OPUS, 'claude-opus-5-5[1m]', { fastMode: false, env: {} }],
  ['200k switches the 1M window off', { ...OPUS, context: '200k' }, 'claude-opus-5-5', { fastMode: false, env: SMALL }],
  ['fast mode is switched on', { ...OPUS, fast: true }, 'claude-opus-5-5[1m]', { fastMode: true, env: {} }],
  [
    'Sonnet has no fast mode',
    { ...OPUS, model: 'claude-sonnet-5-5', fast: true },
    'claude-sonnet-5-5[1m]',
    { fastMode: false, env: {} },
  ],
  ['Haiku has neither', { ...HAIKU, fast: true }, HAIKU.model, { fastMode: false, env: SMALL }],
])('Claude is started with the context window and fast mode the model has: %s', async (_, settings, model, extras) => {
  const tab = await connect();
  const thread = await startThread('make notes', settings);
  expect(thread).toMatchObject({ context: settings.context, fast: settings.fast });
  await tab.status(thread.id, 'done');
  expect(claude.calls[0]).toMatchObject({ model, effort: settings.effort });
  expect(claude.calls[0].settings).toEqual(extras);
});

test('when the account cannot run fast mode, the thread says so once, and only if fast mode was asked for', async () => {
  // What a real account with extra usage switched off answers.
  const noFast = TWO_TURNS.map((msg) =>
    'subtype' in msg && msg.subtype === 'init'
      ? { ...msg, fast_mode_state: 'off' as const, fast_mode_disabled_reason: 'extra_usage_disabled' as const }
      : msg,
  );
  const NOTICE = 'notice: Fast mode is not available (extra usage disabled), so Claude runs at normal speed.';
  await serve(noFast);
  const tab = await connect();
  const fast = await startThread('make notes', { ...OPUS, fast: true });
  await tab.open(fast.id);
  await tab.status(fast.id, 'done');
  expect(tab.screen(fast.id)).toEqual([TURN_1[0], NOTICE, ...TURN_1.slice(1)]);
  await say(fast, 'what is in them?', { ...OPUS, fast: true });
  await tab.status(fast.id, 'done');
  expect(tab.screen(fast.id).filter((shown) => shown === NOTICE)).toHaveLength(1);

  await serve(noFast);
  const late = await connect();
  const standard = await startThread('make notes', OPUS);
  await late.open(standard.id);
  await late.status(standard.id, 'done');
  expect(late.screen(standard.id)).toEqual(TURN_1);
});

test('changing the context window or fast mode while Claude is idle starts a new process', async () => {
  const tab = await connect();
  const thread = await startThread('make notes', OPUS);
  await tab.status(thread.id, 'done');
  await say(thread, 'what is in them?', { ...OPUS, context: '200k', fast: true });
  const done = await tab.status(thread.id, 'done');
  expect(done).toMatchObject({ context: '200k', fast: true });
  expect(claude.closed()).toBe(1);
  expect(claude.calls[1]).toMatchObject({ model: 'claude-opus-5-5', resume: SESSION });
  expect(claude.calls[1].settings).toEqual({ fastMode: true, env: SMALL });
});

test('when Claude starts background work and ends its turn, the thread waits, and what Claude says when the work finishes shows up on its own', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await serve(recording('background'));
  const finish = claude.pause(tasksOver);
  const tab = await connect();
  const thread = await startThread('run it in the background');
  await tab.open(thread.id);

  const waiting = await tab.status(thread.id, 'waiting');
  expect(waiting.tasks).toEqual(['Run a 6-second sleep and then print finished']);
  expect(tab.screen(thread.id)).toEqual(['message: run it in the background', 'Bash running', 'message: Started']);
  // However long the background work takes, the process is kept.
  vi.advanceTimersByTime(60 * 60_000);
  expect(claude.closed()).toBe(0);

  // Nobody sends anything. The work finishes and Claude speaks up by itself.
  finish();
  await tab.status(thread.id, 'working');
  const done = await tab.status(thread.id, 'done');
  expect(done.tasks).toEqual([]);
  expect(tab.screen(thread.id)).toEqual([
    'message: run it in the background',
    'Bash done',
    'message: Started',
    'message: All done',
  ]);
  expect(tab.tool(thread.id, 'Bash').output).toMatch(/^Background command .* completed/);
  expect(claude.calls).toHaveLength(1);
});

test("a subagent's card stays open while it works and lists what it did", async () => {
  await serve(recording('subagent'));
  const finish = claude.pause(taskOver);
  const tab = await connect();
  const thread = await startThread('ask a subagent');
  await tab.open(thread.id);
  await tab.shows(thread.id, (screen) => screen.filter((l) => l === '  Read done').length === 2);
  expect(tab.screen(thread.id)).toEqual(['message: ask a subagent', 'Agent running', '  Read done', '  Read done']);

  finish();
  await tab.status(thread.id, 'done');
  const screen = tab.screen(thread.id);
  expect(screen.slice(0, 4)).toEqual(['message: ask a subagent', 'Agent done', '  Read done', '  Read done']);
  expect(screen[4]).toMatch(/^message: Here's the report from the subagent/);
  expect(screen).toHaveLength(5);
});

test('a subagent sent to the background keeps its card open after the turn ends, until it reports back', async () => {
  await serve(recording('subagent-background'));
  const finish = claude.pause(tasksOver);
  const tab = await connect();
  const thread = await startThread('ask a subagent in the background');
  await tab.open(thread.id);

  const waiting = await tab.status(thread.id, 'waiting');
  expect(waiting.tasks).toEqual(['Read math.js and report its purpose']);
  await tab.shows(thread.id, (screen) => screen.some((l) => l.startsWith('  message: ')));
  expect(tab.screen(thread.id)).toEqual([
    'message: ask a subagent in the background',
    'Agent running',
    '  Bash done',
    '  Read done',
    '  message: The math.js file exports an `add` function that takes two numbers and returns their sum.',
    'message: Launched.',
  ]);

  finish();
  await tab.status(thread.id, 'working');
  await tab.status(thread.id, 'done');
  const screen = tab.screen(thread.id);
  expect(screen[1]).toBe('Agent done');
  expect(screen.at(-1)).toMatch(/^message: The agent's report/);
  expect(tab.tool(thread.id, 'Agent').output).toMatch(/^The math.js file exports/);
});

test('with "Ask first", Claude waits for a yes before changing things, but reads without asking', async () => {
  const { tab, thread } = await watch(recording('approve'), 'read then write', { ...HAIKU, access: 'ask' });
  expect(await tab.status(thread.id, 'needs')).toMatchObject({ access: 'ask' });
  expect(tab.screen(thread.id)).toEqual(['message: read then write', 'Read done', 'Write asking']);
  expect(claude.decisions).toEqual([]);

  const write = tab.tool(thread.id, 'Write');
  expect((await answer(thread, { toolId: write.id, decision: 'approve' })).status).toBe(200);
  await tab.status(thread.id, 'done');
  expect(claude.decisions).toMatchObject([{ behavior: 'allow', updatedInput: { content: 'yes' } }]);
  expect(claude.decisions[0]).not.toHaveProperty('updatedPermissions');
  expect(tab.screen(thread.id)).toEqual(['message: read then write', 'Read done', 'Write done', 'message: Done.']);
  expect(tab.tool(thread.id, 'Write').ask).toBe('approved');

  // The prompt is gone, so a second answer has nowhere to go.
  expect((await answer(thread, { toolId: write.id, decision: 'approve' })).status).toBe(409);
});

test('"Always allow" passes on the rule Claude suggested, scoped to the running process', async () => {
  // Claude suggests saving the rule for good. We only ever let it last for the running process.
  const forGood = JSON.parse(
    JSON.stringify(recording('approve')).replaceAll('"destination":"session"', '"destination":"userSettings"'),
  );
  const { tab, thread } = await watch(forGood, 'read then write', { ...HAIKU, access: 'ask' });
  await tab.status(thread.id, 'needs');
  await answer(thread, { toolId: tab.tool(thread.id, 'Write').id, decision: 'always' });
  await tab.status(thread.id, 'done');
  expect(claude.decisions).toMatchObject([
    { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
  ]);
});

test('a declined action does not run, and Claude carries on', async () => {
  const { tab, thread } = await watch(recording('decline'), 'write it', { ...HAIKU, access: 'ask' });
  await tab.status(thread.id, 'needs');
  await answer(thread, { toolId: tab.tool(thread.id, 'Write').id, decision: 'decline' });
  await tab.status(thread.id, 'done');
  expect(claude.decisions).toEqual([{ behavior: 'deny', message: 'The user declined this action.', interrupt: false }]);
  expect(tab.screen(thread.id)).toEqual([
    'message: write it',
    'Write failed',
    "message: I'm not allowed to create that file.",
  ]);
  expect(tab.tool(thread.id, 'Write').ask).toBe('declined');
});

test('Cancel is a no that also tells Claude to end its turn', async () => {
  const { tab, thread } = await watch(recording('decline'), 'write it', { ...HAIKU, access: 'ask' });
  await tab.status(thread.id, 'needs');
  await answer(thread, { toolId: tab.tool(thread.id, 'Write').id, decision: 'cancel' });
  await tab.status(thread.id, 'done');
  expect(claude.decisions).toEqual([{ behavior: 'deny', message: 'The user declined this action.', interrupt: true }]);
  expect(tab.tool(thread.id, 'Write')).toMatchObject({ ask: 'declined', failed: true });
});

test("a typed answer to Claude's question is passed on as written", async () => {
  const { tab, thread } = await watch(recording('question'), 'ask me');
  await tab.status(thread.id, 'needs');
  const answers = { 'Which color do you prefer?': 'Actually, purple' };
  await answer(thread, { toolId: tab.tool(thread.id, 'AskUserQuestion').id, decision: 'approve', answers });
  await tab.status(thread.id, 'done');
  expect(claude.decisions).toMatchObject([{ behavior: 'allow', updatedInput: { answers } }]);
});

test('with "Full access", Claude is told yes right away and nobody is asked', async () => {
  const { tab, thread } = await watch(recording('approve'), 'read then write');
  await tab.status(thread.id, 'done');
  expect(claude.decisions).toMatchObject([{ behavior: 'allow' }]);
  expect(tab.events.some((e) => e.type === 'thread' && e.thread.status === 'needs')).toBe(false);
  expect(tab.tool(thread.id, 'Write').ask).toBeUndefined();
});

test("Claude's question shows its choices and waits for a pick, even with full access", async () => {
  const { tab, thread } = await watch(recording('question'), 'ask me');
  await tab.status(thread.id, 'needs');
  const card = tab.tool(thread.id, 'AskUserQuestion');
  expect(card.questions).toMatchObject([
    { question: 'Which color do you prefer?', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] },
  ]);

  await answer(thread, { toolId: card.id, decision: 'approve', answers: { 'Which color do you prefer?': 'Blue' } });
  await tab.status(thread.id, 'done');
  expect(claude.decisions).toMatchObject([
    { behavior: 'allow', updatedInput: { answers: { 'Which color do you prefer?': 'Blue' } } },
  ]);
  expect(tab.screen(thread.id).at(-1)).toMatch(/^message: You picked \*\*Blue\*\*/);
});

test('Stop interrupts Claude, marks what was running as failed, and the next message resumes', async () => {
  const { tab, thread } = await watch(TWO_TURNS, 'make notes');
  claude.pause(toolResult); // never released: Stop arrives while the Write tool is running
  await tab.until('item', (e) => e.item.kind === 'tool');

  // Two people press Stop at once.
  const stops = await Promise.all([post(`/api/threads/${thread.id}/stop`), post(`/api/threads/${thread.id}/stop`)]);
  expect(stops.map((res) => res.status)).toEqual([200, 200]);
  await tab.status(thread.id, 'done');
  expect(claude.interrupted()).toBe(1);
  expect(claude.closed()).toBe(1);
  // Claude was given the chance to wind down: the process was closed, not dropped mid-sentence.
  expect(claude.abandoned()).toBe(0);
  expect(tab.screen(thread.id)).toEqual(['message: make notes', 'Write failed', 'notice: Stopped.']);

  await say(thread, 'what is in them?');
  await tab.status(thread.id, 'working');
  await tab.status(thread.id, 'done');
  expect(claude.calls[1]).toMatchObject({ resume: SESSION });
  expect(tab.screen(thread.id)).toHaveLength(7);
});

test('after Stop, Claude gets a no to anything it still asks for, even with full access', async () => {
  await serve(recording('approve'));
  // Stop arrives just before Claude decides to write the file.
  claude.pause(
    (msg) =>
      msg.type === 'assistant' && msg.message.content[0].type === 'tool_use' && msg.message.content[0].name === 'Write',
  );
  const tab = await connect();
  const thread = await startThread('read then write');
  await tab.open(thread.id);
  await tab.shows(thread.id, (screen) => screen.includes('Read done'));

  await post(`/api/threads/${thread.id}/stop`);
  expect(claude.decisions).toEqual([{ behavior: 'deny', message: 'Stopped.' }]);
  expect(tab.screen(thread.id)).toEqual(['message: read then write', 'Read done', 'notice: Stopped.']);
});

test('Stop while Claude is waiting for a yes cancels the question for good', async () => {
  const { tab, thread } = await watch(recording('approve'), 'read then write', { ...HAIKU, access: 'ask' });
  await tab.status(thread.id, 'needs');
  await post(`/api/threads/${thread.id}/stop`);
  await tab.status(thread.id, 'done');
  expect(claude.decisions).toEqual([{ behavior: 'deny', message: 'Stopped.' }]);
  expect(tab.screen(thread.id)).toEqual(['message: read then write', 'Read done', 'Write failed', 'notice: Stopped.']);

  const late = await connect();
  await late.open(thread.id);
  expect(late.screen(thread.id)).toEqual(tab.screen(thread.id));
});

test("Claude's to-do list is kept up to date as it works", async () => {
  const { tab, thread } = await watch(recording('todos'), 'make a list');
  await tab.status(thread.id, 'done');
  expect(tab.screen(thread.id)).toContain('todos: Read math.js=completed, Say hi=completed');
  const steps = tab.events.flatMap((e) => (e.type === 'item' && e.item.kind === 'todos' ? [line(e.item)] : []));
  expect(steps[0]).toBe('todos: Read math.js=pending');
  expect(steps).toContain('todos: Read math.js=in_progress, Say hi=pending');
});

test('when Claude fails, the thread shows the error and asks for attention, and the next message still works', async () => {
  const upToFirstTool = TWO_TURNS.findIndex(toolResult as (line: Line) => boolean);
  const { tab, thread } = await watch(
    [...TWO_TURNS.slice(0, upToFirstTool), { _crash: true }, ...TWO_TURNS],
    'make notes',
  );
  await tab.status(thread.id, 'needs');
  expect(tab.screen(thread.id)).toEqual(['message: make notes', 'Write failed', 'error: Claude crashed']);

  await say(thread, 'try again');
  await tab.status(thread.id, 'working');
  await tab.status(thread.id, 'done');
  expect(claude.calls).toHaveLength(2);
});

test('a restart while Claude is waiting for a yes closes the prompt and says why', async () => {
  const { tab, thread } = await watch(recording('approve'), 'read then write', { ...HAIKU, access: 'ask' });
  await tab.status(thread.id, 'needs');
  await serve([]);
  const after = await connect();
  expect(after.hello.threads).toMatchObject([{ id: thread.id, status: 'needs' }]);
  await after.open(thread.id);
  const screen = after.screen(thread.id);
  expect(screen.slice(0, 3)).toEqual(['message: read then write', 'Read done', 'Write failed']);
  expect(screen[3]).toMatch(/^error: The server restarted/);
});

test('a thread that was mid-answer when the server stopped asks for attention after a restart', async () => {
  claude.pause(bubbleEnd); // never released: the old server dies mid-answer
  const thread = await startThread('make notes');
  await serve([]);
  const after = await connect();
  expect(after.hello.threads).toMatchObject([{ id: thread.id, status: 'needs' }]);
  await after.open(thread.id);
  const screen = after.screen(thread.id);
  expect(screen.slice(0, 2)).toEqual(TURN_1.slice(0, 2));
  expect(screen[2]).toMatch(/^error: The server restarted/);
});

test('a Claude process with nothing to do for ten minutes is closed, and the next message resumes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const tab = await connect();
  const thread = await startThread('make notes');
  await tab.status(thread.id, 'done');
  expect(claude.closed()).toBe(0);
  vi.advanceTimersByTime(10 * 60_000);
  expect(claude.closed()).toBe(1);
  vi.useRealTimers();

  await say(thread, 'what is in them?');
  await tab.status(thread.id, 'working');
  await tab.status(thread.id, 'done');
  expect(claude.calls[1]).toMatchObject({ resume: SESSION });
});

const PNG = readFileSync(new URL('./fixtures/image.png', import.meta.url));
const upload = (body: Uint8Array, type: string) =>
  fetch(url('/api/images'), { method: 'POST', body, headers: { 'content-type': type } });
const uploaded = async () => ((await (await upload(PNG, 'image/png')).json()) as { id: string }).id;

test('an uploaded image shows in the thread on every device and is handed to Claude before the words', async () => {
  const id = await uploaded();
  const back = await fetch(url(`/api/images/${id}`));
  expect(back.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await back.arrayBuffer())).toEqual(PNG);

  const tab = await connect();
  const thread = await startThread('what is this?', { ...HAIKU, images: [id] });
  await tab.open(thread.id);
  await tab.status(thread.id, 'done');
  expect(tab.items(thread.id)[0]).toMatchObject({ kind: 'message', by: 'user', text: 'what is this?', images: [id] });
  expect(claude.said).toEqual([
    [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
      { type: 'text', text: 'what is this?' },
    ],
  ]);

  // Words alone go to Claude as before.
  await say(thread, 'thanks');
  await tab.status(thread.id, 'done');
  expect(claude.said[1]).toBe('thanks');

  const late = await connect();
  await late.open(thread.id);
  expect(late.items(thread.id)[0]).toMatchObject({ images: [id] });
});

test('an image can be sent with no words, to start a thread or to reply', async () => {
  const id = await uploaded();
  const tab = await connect();
  const thread = await startThread('', { ...HAIKU, images: [id] });
  expect(thread.title).toBe('Image');
  await tab.status(thread.id, 'done');
  expect((await say(thread, ' ', { ...HAIKU, images: [id, id] })).status).toBe(200);
  await tab.status(thread.id, 'done');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } };
  expect(claude.said).toEqual([[image], [image, image]]);
});

test('only png, jpeg, gif and webp up to 10MB are taken, and a message can only point at an uploaded image', async () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const res = await upload(PNG, type);
    expect(res.status, type).toBe(200);
    const back = await fetch(url(`/api/images/${((await res.json()) as { id: string }).id}`));
    expect(back.headers.get('content-type')).toBe(type);
    expect(back.headers.get('x-content-type-options')).toBe('nosniff');
  }
  for (const type of ['image/svg+xml', 'text/html', 'application/pdf', 'constructor', '']) {
    expect((await upload(PNG, type)).status, type).toBe(400);
  }
  expect((await upload(new Uint8Array(0), 'image/png')).status).toBe(400);
  expect((await upload(new Uint8Array(10 * 1024 * 1024), 'image/png')).status).toBe(200);
  expect((await upload(new Uint8Array(10 * 1024 * 1024 + 1), 'image/png')).status).toBe(413);

  writeFileSync(join(home, '.acocrew', 'secret.png'), 'private');
  const thread = await startThread('make notes');
  for (const id of ['nope.png', '../secret.png', '..', '', 7]) {
    expect((await say(thread, 'hi', { ...HAIKU, images: [id] })).status, String(id)).toBe(400);
    expect((await fetch(url(`/api/images/${encodeURIComponent(id)}`))).status, String(id)).toBe(404);
  }
  expect((await say(thread, 'hi', { ...HAIKU, images: 'nope' })).status).toBe(400);
  expect((await say(thread, '', HAIKU)).status).toBe(400);
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
    ['/api/threads', { channelId: thread.channelId, text: 'hi', ...HAIKU, model: 'gpt' }],
    ['/api/threads', { channelId: thread.channelId, text: 'hi', ...HAIKU, access: 'root' }],
    [`/api/threads/${thread.id}/messages`, { text: 'hi', ...HAIKU, effort: 'huge' }],
    [`/api/threads/${thread.id}/messages`, { text: 'hi', ...HAIKU, context: '2m' }],
    [`/api/threads/${thread.id}/messages`, { text: 'hi', ...HAIKU, fast: 'yes' }],
    ['/api/threads/nope/messages', { text: 'hi', ...HAIKU }],
  ] as const;
  for (const [path, body] of bad) expect((await post(path, body)).status, JSON.stringify(body)).toBe(400);
  expect((await answer(thread, { toolId: 'nope', decision: 'approve' })).status).toBe(409);
  expect((await answer(thread, { toolId: 'nope' } as never)).status).toBe(400);
  expect(db.select().from(threads).where(eq(threads.channelId, thread.channelId)).all()).toHaveLength(1);
});
