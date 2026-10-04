import {
  AUTOMATIONS_PATH,
  COMMANDS_PATH,
  HEALTH_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  ME_PATH,
  USERS_PATH,
  WS_PATH,
  type Answer,
  type Automation,
  type Channel,
  type Command,
  type FolderList,
  type Item,
  type Me,
  type Person,
  type Places,
  type ServerEvent,
  type Status,
  type Temporary,
  type Thread,
} from '@acocrew/shared';
import type { PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, onTestFinished, test, vi } from 'vite-plus/test';
import { WebSocket } from 'ws';
import { FIRST_ADMIN } from './auth.ts';
import { CHECK_MS } from './automations.ts';
import { openDb, type Db } from './db.ts';
import type { QueryFn } from './runner.ts';
import { automations, channels, events, session as sessions, threads } from './schema.ts';
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
// What Claude said when asked to name a thread that starts with "make notes".
const NAMING = recording('title');
const NAME = '📝 Create note-taking feature';

// Part of what a real Claude said it can run in a repository with skills of its own: three of the repository's
// skills (`broken` has a skill file with no header, `ship` is an old-style command file), one from the home
// folder that the repository also has under the same name (`concise-mode`), one from a plugin, and built-ins.
const COMMANDS = JSON.parse(readFileSync(new URL('./fixtures/commands.json', import.meta.url), 'utf8'));

// A stand-in for Claude that plays a recording back. Like the real thing it waits for a user message only
// where the recording had one, asks for permission where the recording did, and otherwise talks on its own.
// Asked to name a thread, it plays `naming` back instead.
function fakeClaude(script: Line[], naming: Line[] = []) {
  const calls: Parameters<QueryFn>[0]['options'][] = [];
  // Every time it was asked to name a thread.
  const named: Parameters<QueryFn>[0][] = [];
  const decisions: PermissionResult[] = [];
  // What each user message handed to Claude held.
  const said: SDKUserMessage['message']['content'][] = [];
  const holds: { before: (msg: SDKMessage) => boolean; released: Promise<void> }[] = [];
  const releases: (() => void)[] = [];
  // Set to make Claude fail the next time it is asked what it can run.
  let listing: Error | undefined;
  let closed = 0;
  let interrupted = 0;
  let abandoned = 0;
  let pos = 0;

  async function* name() {
    for (const line of naming) {
      if ('_crash' in line) throw new Error('Claude crashed');
      yield line as SDKMessage;
    }
  }

  const query: QueryFn = ({ prompt, options }) => {
    // Plain words instead of an open conversation: the one question the server asks is what to name a thread.
    if (typeof prompt === 'string') {
      named.push({ prompt, options });
      return Object.assign(name(), { close() {}, async interrupt() {}, supportedCommands: async () => [] });
    }
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
      async supportedCommands() {
        const failure = listing;
        listing = undefined;
        if (failure) throw failure;
        return COMMANDS;
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
    named,
    decisions,
    said,
    pause,
    failListing: () => void (listing = new Error('Claude is not logged in')),
    closed: () => closed,
    interrupted: () => interrupted,
    abandoned: () => abandoned,
  };
}

const workDir = join(homedir(), 'acocrew-work');
mkdirSync(workDir, { recursive: true });
const home = mkdtempSync(join(workDir, 'test-home-'));
mkdirSync(join(home, 'code', 'notes'), { recursive: true });
mkdirSync(join(home, '.secret'));
symlinkSync('/etc', join(home, 'way-out'));
const images = join(home, '.acocrew', 'attachments');
const worktrees = join(home, '.acocrew', 'worktrees');
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const me = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const commit = (dir: string, file: string, words: string) => {
  writeFileSync(join(dir, file), words);
  git(dir, 'add', '.');
  git(dir, ...me, 'commit', '--quiet', '-m', words.trim());
  return git(dir, 'rev-parse', 'HEAD');
};
// A repository with one commit on `main`.
function makeRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '--initial-branch=main');
  commit(dir, 'post.md', 'hello\n');
  return dir;
}
// `shop` has no remote. `blog` was cloned from `hub`, the way a repository on GitHub is.
const shop = makeRepo(join(home, 'code', 'shop'));
const hub = makeRepo(join(home, '.remotes', 'blog'));
const blog = join(home, 'code', 'blog');
git(home, 'clone', '--quiet', hub, blog);
// A second copy of the same remote repository. Only one test starts threads in it.
const journal = join(home, 'code', 'journal');
git(home, 'clone', '--quiet', hub, journal);
afterAll(() => rmSync(home, { recursive: true }));

let db: Db;
let claude: ReturnType<typeof fakeClaude>;
let server: Awaited<ReturnType<typeof startServer>>;
let sockets: WebSocket[];

// Starts (or restarts) the server with a Claude that plays `script`.
async function serve(script: Line[], naming?: Line[]) {
  server?.close();
  claude = fakeClaude(script, naming);
  server = await startServer(0, { db, query: claude.query, home, images, worktrees, secret: 'test' }); // 0 = any free port
}

// The login cookie of whoever the test is acting as. Every request and every tab sends it, like a browser.
let cookie: string;
// What the first admin changes their password to.
const PASSWORD = 'correct horse';
const DAY = 24 * 60 * 60_000;

// Most tests are about what happens once someone is in. So each one starts from a copy of a database in which
// the first admin has logged in and picked a password, and acts as that admin. Getting there takes a real
// first start and a real login, done once (hashing passwords is slow on purpose).
let fresh: Buffer;
let adminCookie: string;
beforeAll(async () => {
  db = openDb(':memory:');
  await serve(TWO_TURNS);
  cookie = adminCookie = await logIn(FIRST_ADMIN.username, FIRST_ADMIN.password);
  await post(`${ME_PATH}/password`, { currentPassword: FIRST_ADMIN.password, newPassword: PASSWORD });
  fresh = db.$client.serialize();
});

beforeEach(async () => {
  db = openDb(fresh);
  sockets = [];
  cookie = adminCookie;
  await serve(TWO_TURNS);
});
afterEach(() => {
  vi.useRealTimers();
  for (const socket of sockets) socket.close();
  server.close();
});

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
// What a browser adds to every request from our own pages: where the page came from, and the login cookie.
const browser = () => ({ origin: url(''), cookie, 'content-type': 'application/json' });
const ask = (path: string, init: RequestInit = {}) =>
  fetch(url(path), { ...init, headers: { ...browser(), ...init.headers } });
const post = (path: string, body?: unknown) => ask(path, { method: 'POST', body: JSON.stringify(body) });

// Fills in the login form. Gives back the cookie the browser would keep, or nothing when the login failed.
async function logIn(username: string, password: string) {
  const res = await post(LOGIN_PATH, { username, password });
  return res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}

// What one item looks like on screen, as a short line of text.
function line(item: Item): string {
  if (item.kind === 'todos') return `todos: ${item.todos.map((t) => `${t.subject}=${t.status}`).join(', ')}`;
  if (item.kind !== 'tool') return `${item.kind}: ${item.text}`;
  if (item.ask === 'pending' && !item.done) return `${item.name} asking`;
  return `${item.name} ${item.failed ? 'failed' : item.done ? 'done' : 'running'}`;
}

// A browser tab: remembers every event and can wait for one.
async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`, { headers: { cookie } });
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
    // Settles once the server has cut this tab off.
    closed: new Promise<void>((resolve) => socket.once('close', () => resolve())),
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

// What a page gets when it opens the socket: the refusal's status, or 'open'.
const socketFrom = (headers: Record<string, string> = {}) => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`, { headers: { cookie, ...headers } });
  return new Promise((resolve) => {
    socket.once('unexpected-response', (_, res) => resolve(res.statusCode));
    socket.once('open', () => {
      socket.close();
      resolve('open');
    });
  });
};

// What a message is sent with. A thread or an automation started with these is private.
const HAIKU = {
  model: 'claude-haiku-4-5-20251001',
  effort: 'low',
  context: '1m',
  fast: false,
  access: 'full',
  visibility: 'private',
};
const OPUS = { ...HAIKU, model: 'claude-opus-5-5', effort: 'high' };
// A thread is private unless it is started as one for everyone.
const PUBLIC = { ...HAIKU, visibility: 'public' };

async function addChannel(path = shop) {
  const res = await post('/api/channels', { path });
  return (await res.json()) as Channel;
}

// Works in the current checkout unless `settings` says otherwise.
async function startThread(text: string, settings: object = HAIKU) {
  const channel = await addChannel();
  const res = await post('/api/threads', { channelId: channel.id, text, path: channel.path, ...settings });
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
  const res = await ask(HEALTH_PATH);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('unknown paths are 404', async () => {
  expect((await ask('/nope')).status).toBe(404);
});

test('with the built web app, one server gives out the app, its files and the api', async () => {
  const web = mkdtempSync(join(workDir, 'test-web-'));
  onTestFinished(() => rmSync(web, { recursive: true }));
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'index.html'), '<html>the app</html>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
  server.close();
  server = await startServer(0, { db, query: claude.query, home, images, worktrees, secret: 'test', web });

  // Any screen's address gets the app, which then shows that screen.
  for (const path of ['/', '/c/some-channel/t/some-thread']) {
    expect(await (await ask(path)).text(), path).toBe('<html>the app</html>');
  }
  expect(await (await ask('/assets/app.js')).text()).toBe('console.log(1)');
  expect(await (await ask(HEALTH_PATH)).json()).toEqual({ ok: true });
  expect((await ask('/api/nope')).status).toBe(404);
});

test('folders: lists visible folders and marks git repositories', async () => {
  const top = await (await ask('/api/folders')).json();
  expect(top).toEqual({
    path: home,
    parent: null,
    folders: [{ name: 'code', path: join(home, 'code'), isRepo: false }],
  });

  const res = await ask(`/api/folders?path=${encodeURIComponent(join(home, 'code'))}`);
  const code = (await res.json()) as FolderList;
  expect(code.parent).toBe(home);
  expect(code.folders.map((f) => [f.name, f.isRepo])).toEqual([
    ['blog', true],
    ['journal', true],
    ['notes', false],
    ['shop', true],
  ]);
});

test('folders: nothing outside the home folder can be listed', async () => {
  for (const path of ['/etc', join(home, '..'), join(home, 'way-out'), join(home, 'missing')]) {
    const res = await ask(`/api/folders?path=${encodeURIComponent(path)}`);
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

test('repositories can be put in a new order, which every device gets and keeps, and a new one goes last', async () => {
  const [a, b] = [await addChannel(shop), await addChannel(blog)];
  const tab = await connect();
  expect(tab.hello.channels).toEqual([a, b]);

  expect((await post('/api/channels/order', { ids: [b.id, a.id] })).status).toBe(200);
  expect(await tab.until('order')).toEqual({ type: 'order', ids: [b.id, a.id] });
  expect((await connect()).hello.channels).toEqual([b, a]);

  const c = await addChannel(journal);
  expect((await connect()).hello.channels).toEqual([b, a, c]);

  // Only the full list of repositories, each one once, is an order.
  for (const ids of [
    [a.id, b.id],
    [a.id, b.id, c.id, c.id],
    [a.id, b.id, 'nope'],
    [a.id, b.id, 7],
    'nope',
    undefined,
  ]) {
    expect((await post('/api/channels/order', { ids })).status, JSON.stringify(ids)).toBe(400);
  }
  expect((await connect()).hello.channels).toEqual([b, a, c]);
});

test('a thread runs Claude in the repo folder and streams two turns through one process', async () => {
  const { tab, thread } = await watch(TWO_TURNS, 'make notes\nplease');
  expect(thread).toMatchObject({ title: 'make notes', status: 'working', tasks: [], path: null, ...HAIKU });

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

test('a new thread starts out named after its first line, then gets a name from Claude on every device', async () => {
  await serve(TWO_TURNS, NAMING);
  const release = claude.pause((msg) => msg.type === 'system');
  const tab = await connect();
  // The thread is there before the name is: nothing waits for it.
  const thread = await startThread('make notes\nplease');
  expect(thread.title).toBe('make notes');
  const working = await tab.until('thread', (e) => e.thread.since !== null);
  const named = await tab.until('thread', (e) => e.thread.title === NAME);
  expect(named.thread).toMatchObject({ id: thread.id, channelId: thread.channelId });
  // Getting a name is not news: the thread keeps its place in the list, and stays seen for whoever saw it.
  expect(named.thread.updatedAt).toBe(working.thread.updatedAt);
  release();

  // Claude got the first message and nothing to act with, on the small model whatever the thread runs on.
  expect(claude.named).toHaveLength(1);
  expect(claude.named[0].prompt).toContain('make notes\nplease');
  expect(claude.named[0].options).toMatchObject({ model: HAIKU.model, tools: [], settingSources: [] });

  // The name is given once. A reply does not ask again, and the name stays through the rest of the thread.
  await tab.status(thread.id, 'done');
  await say(thread, 'what is in them?');
  await tab.status(thread.id, 'working');
  expect((await tab.status(thread.id, 'done')).title).toBe(NAME);
  expect(claude.named).toHaveLength(1);
  expect((await connect()).hello.threads).toMatchObject([{ id: thread.id, title: NAME }]);
});

test('a thread on a bigger model is still named by the small one, and the thread itself still runs on the big one', async () => {
  await serve(TWO_TURNS, NAMING);
  const tab = await connect();
  const thread = await startThread('make notes', OPUS);
  await tab.until('thread', (e) => e.thread.title === NAME);
  expect(claude.named[0].options.model).toBe(HAIKU.model);
  expect(claude.calls[0].model).toBe('claude-opus-5-5[1m]');
  expect((await tab.status(thread.id, 'done')).model).toBe(OPUS.model);
});

// Ways naming goes wrong: the process dies, it ends without an answer, or its answer is not a name.
const RESULT = NAMING.at(-1) as Extract<SDKMessage, { subtype: 'success' }>;
test.each([
  ['crashes', [NAMING[0], { _crash: true }]],
  ['says nothing', NAMING.slice(0, 1)],
  ['answers with an error', [{ ...RESULT, is_error: true, result: 'API Error: 529 Overloaded' }]],
  ['answers with nothing', [{ ...RESULT, result: '  ' }]],
  // What the real Claude once said when the first message was just "hi".
  [
    'talks back',
    [{ ...RESULT, result: 'I need more context to name this thread. The message "hi" is just a greeting.' }],
  ],
] as [string, Line[]][])('when naming a thread %s, the first line stays as its name', async (_, naming) => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => logged.mockRestore());
  await serve(TWO_TURNS, naming);
  const tab = await connect();
  const thread = await startThread('make notes');
  expect((await tab.status(thread.id, 'done')).title).toBe('make notes');
  expect(claude.named).toHaveLength(1);
  // The thread itself is not bothered: no error in it, and it does not ask for attention.
  const late = await connect();
  expect(late.hello.threads).toMatchObject([{ title: 'make notes', status: 'done' }]);
  await late.open(thread.id);
  expect(late.screen(thread.id)).toEqual(TURN_1);
});

test('a long name from Claude is cut to one short line', async () => {
  const long = `🧪 ${'word '.repeat(40)}\nand a second line`;
  await serve(TWO_TURNS, [{ ...RESULT, result: long }]);
  const tab = await connect();
  const thread = await startThread('make notes');
  const named = await tab.until('thread', (e) => e.thread.id === thread.id && e.thread.title.startsWith('🧪'));
  expect(named.thread.title).toBe(long.slice(0, 70));
});

test('a thread started in a new worktree runs Claude there, on its own branch, and replies stay there', async () => {
  const tab = await connect();
  const channel = await addChannel(blog);
  const res = await post('/api/threads', { channelId: channel.id, text: 'make notes', from: 'main', ...HAIKU });
  const thread = (await res.json()) as Thread;
  const short = thread.id.slice(0, 8);
  expect(thread.path).toBe(join(worktrees, 'blog', short));

  // The new folder is a second working copy of the repository, on a new branch from the commit it was on.
  expect(git(thread.path!, 'branch', '--show-current')).toBe(`acocrew/${short}`);
  expect(git(thread.path!, 'rev-parse', 'HEAD')).toBe(git(blog, 'rev-parse', 'HEAD'));
  expect(readFileSync(join(thread.path!, 'post.md'), 'utf8')).toBe('hello\n');
  expect(git(blog, 'branch', '--show-current')).toBe('main');

  // A reply that needs a new Claude process starts it in the same folder.
  await tab.status(thread.id, 'done');
  await say(thread, 'what is in them?', OPUS);
  await tab.status(thread.id, 'done');
  expect(claude.calls.map((call) => call.cwd)).toEqual([thread.path, thread.path]);
  expect((await connect()).hello.threads).toMatchObject([{ id: thread.id, path: thread.path }]);

  // A follow up thread works in the same worktree. So can one right in the repository folder. Neither makes a
  // new worktree.
  const before = git(blog, 'worktree', 'list');
  const again = await post('/api/threads', { channelId: channel.id, text: 'make notes', path: thread.path, ...HAIKU });
  expect(await again.json()).toMatchObject({ path: thread.path, branch: `acocrew/${short}` });
  const inRepo = await post('/api/threads', { channelId: channel.id, text: 'make notes', path: blog, ...HAIKU });
  expect(await inRepo.json()).toMatchObject({ path: null, branch: 'main' });
  expect(claude.calls.slice(2).map((call) => call.cwd)).toEqual([thread.path, blog]);
  expect(git(blog, 'worktree', 'list')).toBe(before);
});

const places = async (channel: Channel) => (await (await ask(`/api/channels/${channel.id}/places`)).json()) as Places;

test('a new worktree starts from the newest commit of the remote main branch unless another branch is picked', async () => {
  const channel = await addChannel(journal);
  // The start screen offers the remote's main branch first, and every working copy that exists.
  expect(await places(channel)).toMatchObject({
    branches: [
      { name: 'origin/main', remote: 'origin' },
      { name: 'main', remote: null },
    ],
    worktrees: [{ path: journal, branch: 'main' }],
  });

  // Someone else pushes after our copy was made. The new worktree still gets their commit.
  const pushed = commit(hub, 'post.md', 'hello again\n');
  const res = await post('/api/threads', { channelId: channel.id, text: 'make notes', from: 'origin/main', ...HAIKU });
  const thread = (await res.json()) as Thread;
  const branch = `acocrew/${thread.id.slice(0, 8)}`;
  expect(thread.branch).toBe(branch);
  expect(git(thread.path!, 'rev-parse', 'HEAD')).toBe(pushed);
  // A push from the new branch does not aim at the branch it started from.
  expect(git(journal, 'config', '--get-regexp', '^branch\\.').split('\n')).toEqual([
    'branch.main.remote origin',
    'branch.main.merge refs/heads/main',
  ]);

  // The local main branch was not moved, and a worktree from it starts from where it is.
  const local = await post('/api/threads', { channelId: channel.id, text: 'make notes', from: 'main', ...HAIKU });
  const { path } = (await local.json()) as Thread;
  expect(git(path!, 'rev-parse', 'HEAD')).toBe(git(journal, 'rev-parse', 'main'));
  expect(git(path!, 'rev-parse', 'HEAD')).not.toBe(pushed);
  // A branch on the remote with a name git could take for an option is fetched like any other.
  git(hub, 'update-ref', 'refs/heads/-odd', pushed);
  git(journal, 'fetch', '--quiet');
  const odd = await post('/api/threads', { channelId: channel.id, text: 'make notes', from: 'origin/-odd', ...HAIKU });
  expect(git(((await odd.json()) as Thread).path!, 'rev-parse', 'HEAD')).toBe(pushed);

  const copies = (await places(channel)).worktrees;
  expect(copies[0]).toEqual({ path: journal, branch: 'main' });
  expect(copies.slice(1)).toEqual(
    expect.arrayContaining([{ path: thread.path, branch }, expect.objectContaining({ path })]),
  );
});

test('with no remote, a new worktree starts from the branch the repository folder is on', async () => {
  const channel = await addChannel();
  git(shop, 'checkout', '--quiet', '-b', 'draft');
  try {
    expect((await places(channel)).branches[0]).toEqual({ name: 'draft', remote: null });
  } finally {
    git(shop, 'checkout', '--quiet', 'main');
    git(shop, 'branch', '-D', 'draft');
  }
});

test('a worktree on no branch is offered without one, and a worktree whose folder is gone is not offered', async () => {
  const channel = await addChannel();
  const [loose, gone] = [join(home, '.copies', 'loose'), join(home, '.copies', 'gone')];
  git(shop, 'worktree', 'add', '--quiet', '--detach', loose);
  git(shop, 'worktree', 'add', '--quiet', '-b', 'gone', gone);
  rmSync(gone, { recursive: true });
  expect((await places(channel)).worktrees).toEqual([
    { path: shop, branch: 'main' },
    { path: loose, branch: null },
  ]);
});

test('the thread shows the branch Claude left its folder on, also for threads from before branches were kept', async () => {
  await serve(TWO_TURNS);
  const release = claude.pause(bubbleEnd);
  const tab = await connect();
  const channel = await addChannel(blog);
  const res = await post('/api/threads', { channelId: channel.id, text: 'make notes', from: 'main', ...HAIKU });
  const thread = (await res.json()) as Thread;
  // What Claude would do in the middle of its turn.
  git(thread.path!, 'checkout', '--quiet', '-b', 'notes');
  release();
  await tab.status(thread.id, 'done');
  await tab.until('thread', (e) => e.thread.id === thread.id && e.thread.branch === 'notes');

  // Finding the branch out again is not something that happened in the thread, so its time stays.
  const { updatedAt } = db.update(threads).set({ branch: null }).returning().get();
  await serve(TWO_TURNS);
  const later = await connect();
  // The branch is read while the server starts, so a tab that connects late is told right at the start.
  const onNotes = (t: Thread) => t.id === thread.id && t.branch === 'notes';
  const found = later.hello.threads.find(onNotes) ?? (await later.until('thread', (e) => onNotes(e.thread))).thread;
  expect(found.updatedAt).toBe(updatedAt);
});

test('when git cannot make the worktree, no thread is started and the reason comes back', async () => {
  const channel = await addChannel(blog);
  git(blog, 'remote', 'set-url', 'origin', join(home, 'missing'));
  try {
    const res = await post('/api/threads', {
      channelId: channel.id,
      text: 'make notes',
      from: 'origin/main',
      ...HAIKU,
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Could not make a worktree: .*missing/);
  } finally {
    git(blog, 'remote', 'set-url', 'origin', hub);
  }
  expect(db.select().from(threads).all()).toEqual([]);
  expect(claude.calls).toEqual([]);
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

test('when Claude fails, the thread shows the error and says it failed, and the next message still works', async () => {
  const upToFirstTool = TWO_TURNS.findIndex(toolResult as (line: Line) => boolean);
  const { tab, thread } = await watch(
    [...TWO_TURNS.slice(0, upToFirstTool), { _crash: true }, ...TWO_TURNS],
    'make notes',
  );
  await tab.status(thread.id, 'failed');
  expect(tab.screen(thread.id)).toEqual(['message: make notes', 'Write failed', 'error: Claude crashed']);

  await say(thread, 'try again');
  await tab.status(thread.id, 'working');
  await tab.status(thread.id, 'done');
  expect(claude.calls).toHaveLength(2);
});

test('a restart while Claude is waiting for a yes closes the prompt and says why', async () => {
  const { tab, thread } = await watch(recording('approve'), 'read then write', { ...HAIKU, access: 'ask' });
  const asking = await tab.status(thread.id, 'needs');
  await new Promise((resolve) => setTimeout(resolve, 2));
  await serve([]);
  const after = await connect();
  // Nobody can answer any more, so the thread no longer waits for someone. That is news.
  expect(after.hello.threads).toMatchObject([{ id: thread.id, status: 'failed' }]);
  expect(after.hello.threads[0].updatedAt).toBeGreaterThan(asking.updatedAt);
  await after.open(thread.id);
  const screen = after.screen(thread.id);
  expect(screen.slice(0, 3)).toEqual(['message: read then write', 'Read done', 'Write failed']);
  expect(screen[3]).toMatch(/^error: The server restarted/);
});

test('a thread that was mid-answer when the server stopped says it failed after a restart', async () => {
  claude.pause(bubbleEnd); // never released: the old server dies mid-answer
  const thread = await startThread('make notes');
  await serve([]);
  const after = await connect();
  expect(after.hello.threads).toMatchObject([{ id: thread.id, status: 'failed', since: null }]);
  await after.open(thread.id);
  const screen = after.screen(thread.id);
  expect(screen.slice(0, 2)).toEqual(TURN_1.slice(0, 2));
  expect(screen[2]).toMatch(/^error: The server restarted/);
});

test('a thread says since when Claude has been busy, through a turn and the background work after it', async () => {
  await serve(recording('background'));
  const release = claude.pause(tasksOver);
  const tab = await connect();
  const thread = await startThread('run it in the background');
  const working = await tab.until('thread', (e) => e.thread.since !== null);
  expect(working.thread.status).toBe('working');
  expect(working.thread.since).toBeGreaterThanOrEqual(thread.updatedAt);
  // The turn ends and the background work goes on: still the same stretch of being busy.
  expect((await tab.status(thread.id, 'waiting')).since).toBe(working.thread.since);
  // A tab opened in the middle of it is told the same.
  expect((await connect()).hello.threads[0].since).toBe(working.thread.since);
  release();
  expect((await tab.status(thread.id, 'done')).since).toBeNull();
});

test('a thread on screen is seen by that person, on all their devices and after a reload, until something new happens in it', async () => {
  const jordan = await teammate('jordan', 'Jordan');
  const tab = await connect();
  const phone = await connect();
  const theirs = await as(jordan.cookie, connect);
  expect(tab.hello.seen).toEqual({});
  const thread = await startThread('make notes');
  const done = await tab.status(thread.id, 'done');

  const see = (at: unknown) => post(`/api/threads/${thread.id}/seen`, { at });
  expect((await see(done.updatedAt)).status).toBe(200);
  const seen = { [thread.id]: done.updatedAt };
  expect((await tab.until('seen')).seen).toEqual(seen);
  expect((await phone.until('seen')).seen).toEqual(seen);
  expect((await connect()).hello.seen).toEqual(seen);

  // What comes after is newer than what was seen, until that is seen too.
  await say(thread, 'what is in them?');
  await tab.status(thread.id, 'working');
  const again = await tab.status(thread.id, 'done');
  expect(again.updatedAt).toBeGreaterThan(done.updatedAt);
  expect((await connect()).hello.seen).toEqual(seen);
  // A browser cannot have seen more than there is: something may have happened since what it shows.
  await see(again.updatedAt + DAY);
  expect((await tab.until('seen')).seen).toEqual({ [thread.id]: again.updatedAt });
  expect((await connect()).hello.seen).toEqual({ [thread.id]: again.updatedAt });
  // A device that is behind cannot take back what was seen.
  await see(done.updatedAt);
  expect((await tab.until('seen')).seen).toEqual({ [thread.id]: again.updatedAt });

  // A teammate has not seen it, and is not told what others saw.
  expect((await as(jordan.cookie, connect)).hello.seen).toEqual({});
  expect(theirs.events.some((event) => event.type === 'seen')).toBe(false);

  expect((await post('/api/threads/nope/seen', { at: 1 })).status).toBe(404);
  expect((await see('yesterday')).status).toBe(400);
});

test('a thread is pinned and unpinned for everyone, stays pinned through a reload and a reply, and is not news', async () => {
  const jordan = await teammate('jordan', 'Jordan');
  const tab = await connect();
  const theirs = await as(jordan.cookie, connect);
  const thread = await startThread('make notes', PUBLIC);
  const done = await tab.status(thread.id, 'done');
  expect(done.pinnedAt).toBeNull();

  const pin = (pinned: unknown, id = thread.id) => post(`/api/threads/${id}/pin`, { pinned });
  const told = async (to: typeof tab, pinned: boolean) =>
    (await to.until('thread', (e) => (e.thread.pinnedAt !== null) === pinned)).thread;
  // A teammate pins it. Everyone is told, and nothing else about the thread changes: it is not new to anyone.
  expect((await as(jordan.cookie, () => pin(true))).status).toBe(200);
  const pinned = await told(tab, true);
  expect(pinned).toEqual({ ...done, pinnedAt: expect.any(Number) });
  expect(await told(theirs, true)).toEqual(pinned);
  expect((await connect()).hello.threads).toEqual([pinned]);

  // What Claude does in it afterwards leaves it pinned.
  await say(thread, 'what is in them?');
  await tab.status(thread.id, 'working');
  expect((await tab.status(thread.id, 'done')).pinnedAt).toBe(pinned.pinnedAt);

  expect((await pin(false)).status).toBe(200);
  expect((await told(theirs, false)).pinnedAt).toBeNull();
  expect((await connect()).hello.threads[0].pinnedAt).toBeNull();

  expect((await pin(true, 'nope')).status).toBe(404);
  expect((await pin('yes')).status).toBe(400);
  expect((await pin(undefined)).status).toBe(400);
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

const commands = (from: string) => ask(`${COMMANDS_PATH}?${from}`);
const names = (list: Command[], skill: boolean) => list.filter((c) => c.skill === skill).map((c) => c.name);

test('the message box is offered what Claude says it can run where the thread works', async () => {
  const tab = await connect();
  const channel = await addChannel(blog);
  const res = await post('/api/threads', { channelId: channel.id, text: 'make notes', from: 'main', ...HAIKU });
  const thread = (await res.json()) as Thread;
  await tab.status(thread.id, 'done');

  const list = (await (await commands(`thread=${thread.id}`)).json()) as Command[];
  // Skills come from the repository, the home folder and plugins. Claude picked them, so a skill only Claude
  // may start is not there and a name used twice is there once.
  expect(names(list, true)).toEqual(['release-notes', 'concise-mode', 'broken', 'ship', 'figma:figma-use']);
  // What only makes sense in a terminal, or would change the shared machine's settings, is left out.
  expect(names(list, false)).toEqual(['code-review', 'simplify', 'compact', 'context', 'usage', 'init']);
  expect(list[0]).toEqual({
    name: 'release-notes',
    description: 'Write release notes for the shop from the latest commits. (project)',
    hint: '[version]',
    skill: true,
  });

  // Claude was asked in the thread's own worktree, by a process that was closed again without a message.
  expect(claude.calls.map((call) => call.cwd)).toEqual([thread.path, thread.path]);
  expect(claude.said).toHaveLength(1);
  expect(claude.closed()).toBe(1);
  // The thread's own process was left alone.
  await say(thread, 'what is in them?');
  await tab.status(thread.id, 'working');
  await tab.status(thread.id, 'done');
  expect(claude.calls).toHaveLength(2);
});

test('before a thread exists the repository folder is asked, and the answer is kept for a minute', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const channel = await addChannel(blog);
  const first = await (await commands(`channel=${channel.id}`)).json();
  expect(claude.calls.map((call) => call.cwd)).toEqual([blog]);
  expect(first).toHaveLength(11);

  // Two tabs asking at once, or the same one again soon after, do not start more Claude processes.
  const again = await Promise.all([commands(`channel=${channel.id}`), commands(`channel=${channel.id}`)]);
  expect(await again[0].json()).toEqual(first);
  expect(claude.calls).toHaveLength(1);

  // Skills change on disk, so after a minute Claude is asked again.
  vi.advanceTimersByTime(60_000);
  await commands(`channel=${channel.id}`);
  expect(claude.calls).toHaveLength(2);
  expect(claude.closed()).toBe(2);
});

test('when Claude cannot say what it can run, the request fails and the next one asks again', async () => {
  const channel = await addChannel();
  claude.failListing();
  expect((await commands(`channel=${channel.id}`)).status).toBe(500);
  expect(claude.closed()).toBe(1);
  expect(await (await commands(`channel=${channel.id}`)).json()).toHaveLength(11);

  expect((await commands('channel=nope')).status).toBe(404);
  expect((await commands('thread=nope')).status).toBe(404);
  expect((await commands('')).status).toBe(404);
});

const PNG = readFileSync(new URL('./fixtures/image.png', import.meta.url));
const upload = (body: Uint8Array, type: string) =>
  ask('/api/images', { method: 'POST', body, headers: { 'content-type': type } });
const uploaded = async () => ((await (await upload(PNG, 'image/png')).json()) as { id: string }).id;

test('an uploaded image shows in the thread on every device and is handed to Claude before the words', async () => {
  const id = await uploaded();
  const back = await ask(`/api/images/${id}`);
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
  // With no words there is nothing to name the thread after.
  expect(claude.named).toEqual([]);
  expect((await say(thread, ' ', { ...HAIKU, images: [id, id] })).status).toBe(200);
  await tab.status(thread.id, 'done');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } };
  expect(claude.said).toEqual([[image], [image, image]]);
});

test('only png, jpeg, gif and webp up to 10MB are taken, and a message can only point at an uploaded image', async () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const res = await upload(PNG, type);
    expect(res.status, type).toBe(200);
    const back = await ask(`/api/images/${((await res.json()) as { id: string }).id}`);
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
    expect((await ask(`/api/images/${encodeURIComponent(id)}`)).status, String(id)).toBe(404);
  }
  expect((await say(thread, 'hi', { ...HAIKU, images: 'nope' })).status).toBe(400);
  expect((await say(thread, '', HAIKU)).status).toBe(400);
});

test('requests from another website are refused, our own pages are not', async () => {
  const channel = await addChannel();
  const body = JSON.stringify({ channelId: channel.id, text: 'hi', path: channel.path, ...HAIKU });
  const from = (headers: Record<string, string>) => ask('/api/threads', { method: 'POST', body, headers });
  const viaProxy = { origin: 'https://team.example:5273', 'x-forwarded-host': 'team.example:5273' };
  expect((await from({ origin: 'https://evil.example' })).status).toBe(403);
  expect((await from({ ...viaProxy, origin: 'https://evil.example' })).status).toBe(403);
  expect((await from({ origin: `http://127.0.0.1:${server.port}` })).status).toBe(200);
  expect((await from(viaProxy)).status).toBe(200);

  expect(await socketFrom({ origin: 'https://evil.example' })).toBe(403);
  expect(await socketFrom(viaProxy)).toBe('open');
});

test('bad requests are turned away', async () => {
  const thread = await startThread('make notes');
  const bad = [
    ['/api/threads', { channelId: 'nope', text: 'hi', path: shop, ...HAIKU }],
    ['/api/threads', { channelId: thread.channelId, text: '  ', path: shop, ...HAIKU }],
    ['/api/threads', { channelId: thread.channelId, text: 'hi', path: shop, ...HAIKU, model: 'gpt' }],
    ['/api/threads', { channelId: thread.channelId, text: 'hi', path: shop, ...HAIKU, access: 'root' }],
    // Only a branch or a worktree that git lists for this repository can be picked.
    ['/api/threads', { channelId: thread.channelId, text: 'hi', ...HAIKU }],
    ['/api/threads', { channelId: thread.channelId, text: 'hi', from: 'nope', ...HAIKU }],
    ['/api/threads', { channelId: thread.channelId, text: 'hi', from: '--detach', ...HAIKU }],
    ['/api/threads', { channelId: thread.channelId, text: 'hi', from: 'origin/main', ...HAIKU }],
    ['/api/threads', { channelId: thread.channelId, text: 'hi', path: blog, ...HAIKU }],
    ['/api/threads', { channelId: thread.channelId, text: 'hi', path: '/etc', ...HAIKU }],
    [`/api/threads/${thread.id}/messages`, { text: 'hi', ...HAIKU, effort: 'huge' }],
    [`/api/threads/${thread.id}/messages`, { text: 'hi', ...HAIKU, context: '2m' }],
    [`/api/threads/${thread.id}/messages`, { text: 'hi', ...HAIKU, fast: 'yes' }],
  ] as const;
  for (const [path, body] of bad) expect((await post(path, body)).status, JSON.stringify(body)).toBe(400);
  expect((await post('/api/threads/nope/messages', { text: 'hi', ...HAIKU })).status).toBe(404);
  expect((await answer(thread, { toolId: 'nope', decision: 'approve' })).status).toBe(409);
  expect((await answer(thread, { toolId: 'nope' } as never)).status).toBe(400);
  expect(db.select().from(threads).where(eq(threads.channelId, thread.channelId)).all()).toHaveLength(1);
});

// Runs `what` as the person this cookie belongs to.
async function as<T>(theirs: string, what: () => Promise<T>) {
  const mine = cookie;
  cookie = theirs;
  try {
    return await what();
  } finally {
    cookie = mine;
  }
}

const error = async (res: Response) => ((await res.json()) as { error: string }).error;
const whoAmI = async () => (await (await ask(ME_PATH)).json()) as Me;
const addUser = (username: string, name?: string) => post(USERS_PATH, { username, name });
// What the server answers when it has made a temporary password: the password, once.
const given = async (res: Response) => (await res.json()) as Person & Temporary;
const setPassword = (currentPassword: string, newPassword: string) =>
  post(`${ME_PATH}/password`, { currentPassword, newPassword });
const NEW = { username: 'Jordan.Lee', name: 'Jordan' };
// Long and random enough that nobody guesses it, in letters, digits, - and _.
const STRONG = /^[\w-]{16,}$/;

// A teammate who got an account from the admin, logged in and picked a password. Gives back their cookie.
async function teammate(username: string, name?: string) {
  const { password, ...person } = await given(await addUser(username, name));
  const theirs = await logIn(username, password);
  await as(theirs, () => setPassword(password, `${username} password`));
  return { ...person, cookie: theirs };
}

test('nothing is given out without a login', async () => {
  const thread = await startThread('make notes');
  const mine = cookie;
  const closed = () =>
    Promise.all([
      ask(ME_PATH),
      ask('/api/folders'),
      ask(`${COMMANDS_PATH}?thread=${thread.id}`),
      ask('/api/images/some-image.png'),
      post('/api/channels', { path: shop }),
      post('/api/threads', { channelId: thread.channelId, text: 'hi', path: shop, ...HAIKU }),
      post(`/api/threads/${thread.id}/messages`, { text: 'hi', ...HAIKU }),
      post(`/api/threads/${thread.id}/stop`),
      post(USERS_PATH, { username: 'sneaky', name: 'Sneaky', password: 'sneaky password' }),
      post('/api/auth/sign-up/email', { email: 'a@b.co', name: 'Sneaky', password: 'sneaky password' }),
    ]);

  cookie = '';
  for (const res of await closed()) expect(res.status, res.url).toBe(401);
  expect(await socketFrom()).toBe(401);
  // The page itself has to load, or there would be nowhere to log in.
  expect((await ask(HEALTH_PATH)).status).toBe(200);

  // A wrong password or a made-up cookie gets nowhere.
  expect(await logIn(FIRST_ADMIN.username, 'not the password')).toBe('');
  expect(await logIn('nobody', PASSWORD)).toBe('');
  cookie = mine.replace(/=.{8}/, '=AAAAAAAA');
  expect((await ask(ME_PATH)).status).toBe(401);

  // Logging out ends the login for good, even for someone who kept the cookie, and hangs up on open tabs.
  cookie = mine;
  const tab = await connect();
  expect((await post(LOGOUT_PATH, {})).status).toBe(200);
  await tab.closed;
  expect((await ask(ME_PATH)).status).toBe(401);
  expect(await socketFrom()).toBe(401);
  expect(claude.said).toHaveLength(1);
});

test('accounts cannot be made or changed through the login library, only through our own routes', async () => {
  const bodies = {
    '/api/auth/sign-up/email': { email: 'a@b.co', name: 'Sneaky', username: 'sneaky', password: 'sneaky password' },
    '/api/auth/update-user': { name: 'Boss', admin: true },
    '/api/auth/change-password': { currentPassword: PASSWORD, newPassword: 'another password' },
    '/api/auth/change-email': { newEmail: 'a@b.co' },
    '/api/auth/delete-user': {},
    '/api/auth/sign-in/email': { email: 'a@b.co', password: PASSWORD },
  };
  for (const [path, body] of Object.entries(bodies)) expect((await post(path, body)).status, path).toBe(404);
  const tab = await connect();
  expect(tab.hello.people).toEqual([
    { id: expect.any(String), name: 'Admin', username: 'admin', admin: true, deleted: false },
  ]);
  expect(await logIn(FIRST_ADMIN.username, PASSWORD)).not.toBe('');
});

test('the first start makes an admin who owns what was there before, and who must pick a password first', async () => {
  // A database from before there were logins: a thread, what its one user wrote, and what Claude did.
  db = openDb(':memory:');
  const old = { id: 'thread-1', channelId: 'channel-1', title: 'Make notes', createdAt: 1, updatedAt: 1 };
  db.insert(channels).values({ id: 'channel-1', name: 'shop', path: shop, createdAt: 1 }).run();
  db.insert(threads)
    .values({ ...old, model: HAIKU.model, effort: HAIKU.effort, status: 'done', branch: 'main' })
    .run();
  const before: Item[] = [
    { id: 'item-1', kind: 'message', by: 'user', text: 'make notes', images: [], at: 1 },
    { id: 'item-2', kind: 'message', by: 'claude', text: 'Done.', at: 2 },
    { id: 'item-3', kind: 'notice', text: 'Stopped.', at: 3 },
  ];
  db.insert(events)
    .values(before.map((item) => ({ threadId: old.id, item })))
    .run();
  await serve(TWO_TURNS);

  cookie = await logIn(FIRST_ADMIN.username, FIRST_ADMIN.password);
  const me = await whoAmI();
  expect(me).toEqual({ ...me, name: 'Admin', username: 'admin', admin: true, mustChangePassword: true });

  // Until the password is changed, the app stays shut.
  expect((await ask('/api/folders')).status).toBe(403);
  expect((await post(ME_PATH, { name: 'Boss' })).status).toBe(403);
  expect((await addUser('jordan')).status).toBe(403);
  expect(await socketFrom()).toBe(403);
  expect(await error(await setPassword(FIRST_ADMIN.password, FIRST_ADMIN.password))).toMatch(/different/);
  expect(await error(await setPassword(FIRST_ADMIN.password, 'short'))).toMatch(/too short/i);
  expect((await setPassword('not the password', PASSWORD)).status).toBe(400);
  expect((await setPassword(undefined as never, undefined as never)).status).toBe(400);
  expect((await whoAmI()).mustChangePassword).toBe(true);

  // Someone else who logged in with the default password is logged out the moment a new one is picked.
  const other = await logIn(FIRST_ADMIN.username, FIRST_ADMIN.password);
  expect((await setPassword(FIRST_ADMIN.password, PASSWORD)).status).toBe(200);
  expect((await as(other, () => ask(ME_PATH))).status).toBe(401);
  // That goes for later changes too, and for the tabs the other login has open.
  const theirs = await as(await logIn(FIRST_ADMIN.username, PASSWORD), connect);
  expect((await setPassword(PASSWORD, 'another password')).status).toBe(200);
  await theirs.closed;
  expect((await setPassword('another password', PASSWORD)).status).toBe(200);
  expect((await whoAmI()).mustChangePassword).toBe(false);
  expect((await ask('/api/folders')).status).toBe(200);
  expect(await logIn(FIRST_ADMIN.username, FIRST_ADMIN.password)).toBe('');
  expect(await logIn(FIRST_ADMIN.username, PASSWORD)).not.toBe('');

  // The old thread and the message in it are the admin's now. What Claude said is nobody's.
  const tab = await connect();
  // Like every thread from before threads could be shared, it is private to whoever it belongs to.
  expect(tab.hello.threads).toMatchObject([{ id: old.id, people: [me.id], createdBy: me.id, visibility: 'private' }]);
  await tab.open(old.id);
  expect(tab.items(old.id)).toEqual([{ ...before[0], userId: me.id }, before[1], before[2]]);
  expect(db.select().from(threads).get()!.createdBy).toBe(me.id);

  // A restart does not make a second admin, and leaves the password alone.
  await serve(TWO_TURNS);
  expect((await connect()).hello.people).toHaveLength(1);
  expect(await logIn(FIRST_ADMIN.username, FIRST_ADMIN.password)).toBe('');
});

test('an admin makes an account, and its owner picks a password of their own on first login', async () => {
  const tab = await connect();
  // The admin does not pick the temporary password. The server makes one and says it in its answer only.
  const { password, ...jordan } = await given(await post(USERS_PATH, { ...NEW, password: 'typed by the admin' }));
  expect(password).toMatch(STRONG);
  expect(await logIn('jordan.lee', 'typed by the admin')).toBe('');
  // Usernames are kept in small letters. Everyone connected hears about the new teammate, not the password.
  expect(jordan).toEqual({ id: jordan.id, name: 'Jordan', username: 'jordan.lee', admin: false, deleted: false });
  expect((await tab.until('person')).person).toEqual(jordan);

  // What cannot be an account says why, in words for the admin who typed it.
  expect(await error(await addUser('jordan.lee'))).toMatch(/already taken/i);
  expect(await error(await addUser('jo'))).toMatch(/too short/i);
  expect(await error(await addUser('jordan lee'))).toMatch(/username/i);
  expect((await post(USERS_PATH, {})).status).toBe(400);
  // Without a display name, the username stands in for it. Every account gets a password of its own.
  const robin = await given(await addUser('robin', '  '));
  expect(robin.name).toBe('robin');
  expect(robin.password).toMatch(STRONG);
  expect(robin.password).not.toBe(password);

  // The temporary password only opens the screen that asks for a new one.
  cookie = await logIn('JORDAN.LEE', password);
  expect(await whoAmI()).toEqual({ ...jordan, mustChangePassword: true });
  expect((await ask('/api/folders')).status).toBe(403);
  expect(await socketFrom()).toBe(403);
  expect((await setPassword(password, 'jordan password')).status).toBe(200);
  expect((await ask('/api/folders')).status).toBe(200);
  expect(await socketFrom()).toBe('open');

  // Someone who is not an admin cannot make or change accounts.
  for (const path of [USERS_PATH, `${USERS_PATH}/${jordan.id}/admin`, `${USERS_PATH}/${jordan.id}/delete`]) {
    expect((await post(path, { username: 'sam', admin: true })).status, path).toBe(403);
  }
  expect((await post(`${USERS_PATH}/${tab.hello.people[0].id}/password`, {})).status).toBe(403);
  expect((await connect()).hello.people.map((person) => person.username)).toEqual(['admin', 'jordan.lee', 'robin']);
});

test('a message says who wrote it, and a thread lists everyone who wrote in it', async () => {
  const admin = await whoAmI();
  const jordan = await teammate('jordan', 'Jordan');
  const tab = await connect();
  const thread = await startThread('make notes', PUBLIC);
  expect(thread.people).toEqual([admin.id]);
  await tab.open(thread.id);
  await tab.status(thread.id, 'done');

  await as(jordan.cookie, () => say(thread, 'read both files'));
  const joined = await tab.until('thread', (e) => e.thread.people.length === 2);
  expect(joined.thread.people).toEqual([admin.id, jordan.id]);
  await tab.status(thread.id, 'done');
  const wrote = tab
    .items(thread.id)
    .flatMap((item) => (item.kind === 'message' ? [[item.by, item.text.slice(0, 15), item.userId]] : []));
  expect(wrote).toEqual([
    ['user', 'make notes', admin.id],
    ['claude', 'Done — notes.tx', undefined],
    ['user', 'read both files', jordan.id],
    ['claude', 'math.js is a si', undefined],
  ]);

  // Writing again does not list a person twice. A tab opened later is told the same.
  await say(thread, 'thanks');
  await as(jordan.cookie, () => say(thread, 'thanks'));
  const late = await as(jordan.cookie, connect);
  expect(late.hello.threads[0].people).toEqual([admin.id, jordan.id]);
  expect(late.hello.people.map((person) => person.name)).toEqual(['Admin', 'Jordan']);
  expect(db.select().from(threads).get()!.createdBy).toBe(admin.id);
});

test('a new display name is told to everyone', async () => {
  const tab = await connect();
  const me = await whoAmI();
  expect((await post(ME_PATH, { name: '  Marcho  ' })).status).toBe(200);
  expect((await tab.until('person')).person).toEqual({ ...tab.hello.people[0], name: 'Marcho' });
  expect((await whoAmI()).name).toBe('Marcho');
  expect((await connect()).hello.people).toMatchObject([{ id: me.id, name: 'Marcho', username: 'admin' }]);

  for (const name of ['', '   ', 'x'.repeat(51), 7, undefined]) {
    expect((await post(ME_PATH, { name })).status, String(name)).toBe(400);
  }
  expect((await whoAmI()).name).toBe('Marcho');
  expect((await addUser('jordan', 'x'.repeat(51))).status).toBe(400);
});

test('a login that is used does not run out, and a site that is not ours cannot log anyone in or out', async () => {
  // Three days on, the login has four of its seven days left.
  const [row] = db.select().from(sessions).all();
  db.update(sessions)
    .set({ updatedAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() + 4 * DAY) })
    .run();
  const res = await ask('/api/folders');
  expect(res.status).toBe(200);
  // The browser gets a cookie that lasts the full week again, and the login itself does too.
  expect(res.headers.getSetCookie().join()).toMatch(/Max-Age=604800/);
  expect(db.select().from(sessions).get()!.expiresAt.getTime()).toBeGreaterThan(row.expiresAt.getTime() - DAY);

  // Behind a tunnel, our own pages come from the address the tunnel has.
  const viaProxy = { origin: 'https://team.example', 'x-forwarded-host': 'team.example' };
  const login = { method: 'POST', body: JSON.stringify({ username: FIRST_ADMIN.username, password: PASSWORD }) };
  expect((await ask(LOGIN_PATH, { ...login, headers: viaProxy })).status).toBe(200);
  expect((await ask(LOGIN_PATH, { ...login, headers: { origin: 'https://evil.example' } })).status).toBe(403);
  const logout = { method: 'POST', body: '{}' };
  expect((await ask(LOGOUT_PATH, { ...logout, headers: { origin: 'https://evil.example' } })).status).toBe(403);
  // Neither can a request that does not say which site it comes from.
  const { origin: _, ...noSite } = browser();
  expect((await fetch(url(LOGOUT_PATH), { ...logout, headers: noSite })).status).toBe(403);
  expect((await ask(ME_PATH)).status).toBe(200);
});

test('admins make and unmake admins, but one always stays', async () => {
  const admin = await whoAmI();
  const jordan = await teammate('jordan');
  const tab = await connect();
  const setAdmin = (id: string, admin: boolean) => post(`${USERS_PATH}/${id}/admin`, { admin });

  expect((await as(jordan.cookie, () => addUser('robin'))).status).toBe(403);
  expect((await setAdmin(jordan.id, true)).status).toBe(200);
  expect((await tab.until('person')).person).toMatchObject({ id: jordan.id, admin: true });
  expect((await as(jordan.cookie, () => addUser('robin'))).status).toBe(200);

  // With two admins, either can step down or be taken down. The one left cannot.
  expect((await as(jordan.cookie, () => setAdmin(admin.id, false))).status).toBe(200);
  expect((await addUser('sam')).status).toBe(403);
  expect(await error(await as(jordan.cookie, () => setAdmin(jordan.id, false)))).toMatch(/at least one admin/);
  expect((await as(jordan.cookie, whoAmI)).admin).toBe(true);
  expect((await as(jordan.cookie, () => setAdmin('nobody', true))).status).toBe(404);
});

test('a deleted account is logged out at once, keeps its name on what it wrote, and frees its username', async () => {
  const admin = await whoAmI();
  const jordan = await teammate('jordan', 'Jordan');
  const thread = await startThread('make notes', PUBLIC);
  await as(jordan.cookie, () => say(thread, 'read both files'));
  const theirs = await as(jordan.cookie, connect);
  const tab = await connect();
  const remove = (id: string) => post(`${USERS_PATH}/${id}/delete`);

  expect(await error(await remove(admin.id))).toMatch(/your own account/);
  expect((await remove(jordan.id)).status).toBe(200);
  await theirs.closed;
  expect((await as(jordan.cookie, () => ask(ME_PATH))).status).toBe(401);
  expect(await as(jordan.cookie, socketFrom)).toBe(401);
  expect(await logIn('jordan', 'jordan password')).toBe('');

  // Everyone still knows whose messages those were.
  const left = { id: jordan.id, name: 'Jordan', username: null, admin: false, deleted: true };
  expect((await tab.until('person')).person).toEqual(left);
  const late = await connect();
  expect(late.hello.people).toEqual([tab.hello.people[0], left]);
  expect(late.hello.threads[0].people).toEqual([admin.id, jordan.id]);
  await late.open(thread.id);
  expect(late.items(thread.id).filter((item) => item.kind === 'message' && item.userId === jordan.id)).toHaveLength(1);

  // An account that is gone cannot be changed, and its username can go to someone new.
  expect((await remove(jordan.id)).status).toBe(404);
  expect((await post(`${USERS_PATH}/${jordan.id}/admin`, { admin: true })).status).toBe(404);
  expect((await post(`${USERS_PATH}/${jordan.id}/password`, {})).status).toBe(404);
  const next = await teammate('jordan', 'Jordan B');
  expect(next.id).not.toBe(jordan.id);
  expect((await as(next.cookie, () => ask('/api/folders'))).status).toBe(200);
});

test('a password reset by an admin logs the person out and makes them pick a new one', async () => {
  const jordan = await teammate('jordan');
  const theirs = await as(jordan.cookie, connect);
  const reset = async (body: object) => given(await post(`${USERS_PATH}/${jordan.id}/password`, body));

  // The admin does not pick this one either. The server's answer is the password it made and nothing else.
  const { password: first, ...rest } = await reset({ password: 'typed by the admin' });
  expect(first).toMatch(STRONG);
  expect(rest).toEqual({});
  await theirs.closed;
  expect((await as(jordan.cookie, () => ask(ME_PATH))).status).toBe(401);
  expect(await logIn('jordan', 'jordan password')).toBe('');
  expect(await logIn('jordan', 'typed by the admin')).toBe('');

  // A password that was shown and lost is replaced by resetting again. Only the newest one works.
  const { password: second } = await reset({});
  expect(second).toMatch(STRONG);
  expect(second).not.toBe(first);
  expect(await logIn('jordan', first)).toBe('');

  cookie = await logIn('jordan', second);
  expect((await whoAmI()).mustChangePassword).toBe(true);
  expect((await ask('/api/folders')).status).toBe(403);
  expect((await setPassword(second, 'jordan password 2')).status).toBe(200);
  expect((await ask('/api/folders')).status).toBe(200);
  expect(await logIn('jordan', second)).toBe('');
});

test('told that people come in over https, the login cookie is for https only', async () => {
  const cookieLine = async () =>
    (await post(LOGIN_PATH, { username: FIRST_ADMIN.username, password: PASSWORD })).headers.getSetCookie()[0];
  expect(await cookieLine()).not.toMatch(/Secure/);

  server.close();
  const deps = { db, query: claude.query, home, images, worktrees, secret: 'test' };
  server = await startServer(0, { ...deps, https: true });
  const secure = await cookieLine();
  expect(secure).toMatch(/; Secure/);
  // The cookie from before the switch has another name and no longer counts. The new one does.
  expect((await ask(ME_PATH)).status).toBe(401);
  cookie = secure.split(';')[0];
  expect((await ask(ME_PATH)).status).toBe(200);
  expect(await socketFrom()).toBe('open');
});

// What an automation is made with. It runs every day unless a test says otherwise.
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const DIGEST = { text: 'write a digest', time: '09:00', days: EVERY_DAY, from: 'main', ...HAIKU };
async function automate(parts: object = {}) {
  const channel = await addChannel();
  const res = await post(AUTOMATIONS_PATH, { channelId: channel.id, ...DIGEST, ...parts });
  return (await res.json()) as Automation;
}
const change = (automation: Automation, parts: object) =>
  post(`${AUTOMATIONS_PATH}/${automation.id}`, { ...automation, ...parts });
const remove = (automation: Automation) => post(`${AUTOMATIONS_PATH}/${automation.id}/delete`);
const allThreads = () => db.select().from(threads).all();

// Stops the clock at half a minute past a minute, so that the server's next look falls in the minute after.
// Gives back what a schedule needs to name a moment that many minutes from now.
function stopClock() {
  const now = new Date();
  now.setSeconds(30, 0);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now });
  return (minutes: number) => {
    const at = new Date(now.getTime() + minutes * 60_000 - 30_000);
    return { time: at.toTimeString().slice(0, 5), days: [(at.getDay() + 6) % 7] };
  };
}
const aMinuteLater = () => vi.advanceTimersByTime(CHECK_MS);

test('an automation is made, changed, paused and deleted, and every device hears of it', async () => {
  const tab = await connect();
  const made = await automate();
  expect(made).toMatchObject({ ...DIGEST, on: true, createdBy: tab.hello.people[0].id });
  // It runs next at nine, today or tomorrow (a day that can be an hour longer when the clocks change).
  expect(new Date(made.nextAt!).toTimeString().slice(0, 5)).toBe('09:00');
  expect(made.nextAt! - Date.now()).toBeLessThanOrEqual(DAY + 60 * 60_000);
  // The first message says how far the server's clock is ahead of UTC, so the web app can name that nine.
  // JavaScript counts the other way around, so the two add up to nothing.
  expect(tab.hello.utcOffset + new Date().getTimezoneOffset()).toBe(0);
  expect((await tab.until('automation')).automation).toEqual(made);

  const paused = {
    ...made,
    text: 'write a long digest',
    time: '18:30',
    days: [0, 4],
    ...OPUS,
    on: false,
    nextAt: null,
  };
  expect(await (await change(made, paused)).json()).toEqual(paused);
  expect((await tab.until('automation')).automation).toEqual(paused);
  // A device that connects later gets it too.
  expect((await connect()).hello.automations).toEqual([paused]);

  expect((await remove(made)).status).toBe(200);
  expect(await tab.until('automation-gone')).toMatchObject({ id: made.id });
  expect((await connect()).hello.automations).toEqual([]);
  expect((await remove(made)).status).toBe(404);
});

test('when its time comes, an automation sends its message in a fresh thread in a new worktree, as whoever made it', async () => {
  const at = stopClock();
  await serve(TWO_TURNS, NAMING);
  const jordan = await teammate('jordan', 'Jordan');
  const tab = await connect();
  const digest = await as(jordan.cookie, () => automate({ ...at(1), visibility: 'public' }));
  // These three are due at the same moment, and must not run: one is paused, one is deleted, one is for another day.
  await automate({ ...at(1), text: 'paused' }).then((made) => change(made, { on: false }));
  await automate({ ...at(1), text: 'deleted' }).then(remove);
  await automate({ ...at(1), text: 'another day', days: [(at(1).days[0] + 1) % 7] });

  aMinuteLater();
  const { thread } = await tab.until('thread', (e) => e.thread.automationId !== null);
  expect(thread).toMatchObject({ automationId: digest.id, title: 'write a digest', people: [jordan.id], ...PUBLIC });
  expect(thread).toMatchObject({
    branch: `acocrew/${thread.id.slice(0, 8)}`,
    path: join(worktrees, 'shop', thread.id.slice(0, 8)),
  });
  // Every device is told when it runs next: at the same time on that day a week later.
  const next = await tab.until(
    'automation',
    (e) => e.automation.id === digest.id && e.automation.nextAt !== digest.nextAt,
  );
  expect(Math.round((next.automation.nextAt! - digest.nextAt!) / DAY)).toBe(7);

  await tab.open(thread.id);
  await tab.status(thread.id, 'done');
  expect(tab.screen(thread.id)[0]).toBe('message: write a digest');
  expect(claude.calls).toMatchObject([{ cwd: thread.path, model: HAIKU.model, resume: undefined }]);
  expect(claude.said).toEqual(['write a digest']);
  // Like any new thread, it gets a proper name.
  expect(claude.named).toHaveLength(1);

  // One run per moment, and only of what was due: a minute later it is another automation's turn.
  const second = await automate({ ...at(2), text: 'second' });
  aMinuteLater();
  await tab.until('thread', (e) => e.thread.automationId === second.id);
  expect(allThreads().map((row) => row.automationId)).toEqual([digest.id, second.id]);
});

test('a run that was missed while the server was off is skipped', async () => {
  const at = stopClock();
  await serve(TWO_TURNS);
  const tab = await connect();
  await automate({ ...at(1), text: 'missed' });
  const later = await automate({ ...at(6), text: 'on time' });
  server.close();
  vi.advanceTimersByTime(5 * CHECK_MS);

  await serve(TWO_TURNS);
  const back = await connect();
  aMinuteLater();
  const { thread } = await back.until('thread', (e) => e.thread.automationId !== null);
  expect(thread).toMatchObject({ automationId: later.id, title: 'on time' });
  // Long enough for the missed one to have started too, if it were going to.
  await back.status(thread.id, 'done');
  expect(allThreads()).toHaveLength(1);
  expect(tab.events.filter((e) => e.type === 'thread')).toEqual([]);
});

test('an automation can be run right away, also while paused, and its threads stay when it is deleted', async () => {
  const tab = await connect();
  const made = await automate();
  await change(made, { on: false });
  const thread = (await (await post(`${AUTOMATIONS_PATH}/${made.id}/run`)).json()) as Thread;
  expect(thread).toMatchObject({ automationId: made.id, title: 'write a digest', status: 'working' });
  await tab.status(thread.id, 'done');

  await remove(made);
  expect((await connect()).hello.threads).toMatchObject([{ id: thread.id, automationId: null }]);
  expect((await post(`${AUTOMATIONS_PATH}/${made.id}/run`)).status).toBe(404);
});

test('an automation whose branch is gone starts no thread and says why, and can still be paused', async () => {
  git(shop, 'branch', 'short-lived');
  const made = await automate({ from: 'short-lived' });
  git(shop, 'branch', '-D', 'short-lived');
  const res = await post(`${AUTOMATIONS_PATH}/${made.id}/run`);
  expect([res.status, await error(res)]).toEqual([400, 'Pick a branch to start from, or a worktree that exists.']);
  expect(allThreads()).toEqual([]);
  expect(await (await change(made, { on: false })).json()).toMatchObject({ on: false, from: 'short-lived' });
});

test('a time that had passed already when the automation was saved waits for its next day', async () => {
  const at = stopClock();
  await serve(TWO_TURNS);
  const tab = await connect();
  // Half a minute after its time, one is made and another is switched back on. Both say they run next week.
  const paused = await automate({ ...at(1), text: 'switched on late' }).then(async (made) => {
    await change(made, { on: false });
    return made;
  });
  vi.advanceTimersByTime(CHECK_MS / 2 + 1000);
  const late = await automate({ ...at(1), text: 'made late' });
  await change(paused, { on: true });
  expect(Math.round((late.nextAt! - Date.now()) / DAY)).toBe(7);
  const due = await automate({ ...at(2), text: 'on time' });

  // The server's next look comes half a minute after that time. Neither runs. A look later, the one for the
  // minute after does.
  vi.advanceTimersByTime(CHECK_MS / 2 - 1000);
  aMinuteLater();
  const { thread } = await tab.until('thread', (e) => e.thread.automationId !== null);
  await tab.status(thread.id, 'done');
  expect(allThreads().map((row) => row.automationId)).toEqual([due.id]);
});

test('an automation needs a message, a real time, a day, a branch git lists and a full set of settings', async () => {
  const made = await automate();
  const bad = [
    { channelId: 'nope' },
    { text: '  ' },
    { time: '9:00' },
    { time: '24:00' },
    { time: '09:60' },
    { days: [] },
    { days: [7] },
    { days: 'monday' },
    { from: 'nope' },
    { from: undefined },
    { model: 'gpt' },
    { access: 'root' },
  ];
  for (const parts of bad) {
    const body = { channelId: made.channelId, ...DIGEST, ...parts };
    expect((await post(AUTOMATIONS_PATH, body)).status, JSON.stringify(parts)).toBe(400);
  }
  expect((await change(made, { time: 'noon' })).status).toBe(400);
  expect((await change(made, { on: 'yes' })).status).toBe(400);
  expect((await post(`${AUTOMATIONS_PATH}/nope`, made)).status).toBe(404);
  expect((await connect()).hello.automations).toEqual([made]);
  // Without a login there is nothing to make, change, run or delete.
  cookie = '';
  for (const path of ['', `/${made.id}`, `/${made.id}/run`, `/${made.id}/delete`])
    expect((await post(AUTOMATIONS_PATH + path, made)).status, path).toBe(401);
});

// Who can see what. A thread and an automation are private unless made public.
const show = (thread: Thread, visibility: unknown) => post(`/api/threads/${thread.id}/visibility`, { visibility });
const share = (thread: Thread, userId: unknown, shared: unknown = true) =>
  post(`/api/threads/${thread.id}/shares`, { userId, shared });
// Everything a browser can ask about one thread.
const reach = (thread: Thread) =>
  Promise.all([
    say(thread, 'let me in'),
    answer(thread, { toolId: 'nope', decision: 'approve' }),
    post(`/api/threads/${thread.id}/stop`),
    post(`/api/threads/${thread.id}/pin`, { pinned: true }),
    post(`/api/threads/${thread.id}/seen`, { at: 1 }),
    show(thread, 'public'),
    share(thread, 'nobody'),
    ask(`${COMMANDS_PATH}?thread=${thread.id}`),
  ]);
// What this tab was told about threads and what is in them.
const heard = (tab: Awaited<ReturnType<typeof connect>>) =>
  tab.events.filter((e) => ['thread', 'thread-gone', 'items', 'item', 'delta'].includes(e.type));

test('a new thread is private: only whoever started it gets it, and to anyone else it does not exist', async () => {
  const admin = await whoAmI();
  const jordan = await teammate('jordan', 'Jordan');
  const tab = await connect();
  const theirs = await as(jordan.cookie, connect);
  const thread = await startThread('make notes');
  expect(thread).toMatchObject({ visibility: 'private', createdBy: admin.id, shared: [] });
  await tab.open(thread.id);
  await tab.status(thread.id, 'done');
  expect(tab.screen(thread.id)).toEqual(TURN_1);

  // The teammate heard nothing while it ran, gets nothing on a reload, and cannot ask for what is in it.
  const late = await as(jordan.cookie, connect);
  expect(late.hello.threads).toEqual([]);
  for (const res of await as(jordan.cookie, () => reach(thread))) expect(res.status, res.url).toBe(404);
  // Nor does opening it by its id get them what is in it, or what happens in it next.
  void late.open(thread.id);
  await say(thread, 'what is in them?');
  await tab.status(thread.id, 'working');
  await tab.status(thread.id, 'done');
  expect(heard(late)).toEqual([]);
  expect(heard(theirs)).toEqual([]);
  expect(claude.said).toHaveLength(2);
  expect((await connect()).hello.threads[0]).toMatchObject({ pinnedAt: null, visibility: 'private' });

  // Being an admin changes nothing about that.
  await post(`${USERS_PATH}/${jordan.id}/admin`, { admin: true });
  expect((await as(jordan.cookie, connect)).hello.threads).toEqual([]);
  expect((await as(jordan.cookie, () => say(thread, 'let me in'))).status).toBe(404);

  // A new thread has to say who sees it.
  for (const visibility of ['secret', undefined]) {
    const odd = { channelId: thread.channelId, text: 'hi', path: shop, ...HAIKU, visibility };
    expect((await post('/api/threads', odd)).status).toBe(400);
  }
});

test('a public thread is for everyone, and when its owner makes it private it leaves the other screens at once', async () => {
  const admin = await whoAmI();
  const jordan = await teammate('jordan', 'Jordan');
  const tab = await connect();
  const theirs = await as(jordan.cookie, connect);
  const thread = await startThread('make notes', PUBLIC);
  expect(thread.visibility).toBe('public');
  await theirs.open(thread.id);
  await theirs.status(thread.id, 'done');
  expect(theirs.screen(thread.id)).toEqual(TURN_1);
  expect((await as(jordan.cookie, connect)).hello.threads).toMatchObject([{ id: thread.id }]);

  // Only whoever started it decides who sees it.
  const refused = await as(jordan.cookie, () => show(thread, 'private'));
  expect([refused.status, await error(refused)]).toEqual([403, 'Only the person who started a thread can share it.']);

  expect((await show(thread, 'private')).status).toBe(200);
  expect(await theirs.until('thread-gone')).toEqual({ type: 'thread-gone', id: thread.id });
  expect((await tab.until('thread', (e) => e.thread.visibility === 'private')).thread).toMatchObject({
    id: thread.id,
    createdBy: admin.id,
  });
  // The tab that had it open hears nothing of what happens in it from now on.
  const before = heard(theirs).length;
  await say(thread, 'what is in them?');
  await tab.status(thread.id, 'working');
  await tab.status(thread.id, 'done');
  expect(heard(theirs)).toHaveLength(before);
  for (const res of await as(jordan.cookie, () => reach(thread))) expect(res.status, res.url).toBe(404);
  expect(claude.said).toHaveLength(2);
});

test('the owner shares a private thread with people and takes that back, and the list is kept while the thread is public', async () => {
  const jordan = await teammate('jordan', 'Jordan');
  const robin = await teammate('robin', 'Robin');
  const tab = await connect();
  const theirs = await as(jordan.cookie, connect);
  const robins = await as(robin.cookie, connect);
  const thread = await startThread('make notes');
  await tab.status(thread.id, 'done');

  // Shared with Jordan: it shows up on their screen, and they can do what the owner can, except share it.
  expect((await share(thread, jordan.id)).status).toBe(200);
  const got = (await theirs.until('thread')).thread;
  expect(got).toMatchObject({ id: thread.id, visibility: 'private', shared: [jordan.id], status: 'done' });
  expect((await tab.until('thread', (e) => e.thread.shared.length === 1)).thread).toEqual(got);
  await as(jordan.cookie, async () => {
    await theirs.open(thread.id);
    expect(theirs.screen(thread.id)).toEqual(TURN_1);
    expect((await say(thread, 'read both files')).status).toBe(200);
    await theirs.status(thread.id, 'done');
    expect((await post(`/api/threads/${thread.id}/pin`, { pinned: true })).status).toBe(200);
    expect((await post(`/api/threads/${thread.id}/stop`)).status).toBe(200);
    // Claude is not asking anything right now, but the answer got as far as Claude.
    expect((await answer(thread, { toolId: 'nope', decision: 'approve' })).status).toBe(409);
    expect((await show(thread, 'public')).status).toBe(403);
    expect((await share(thread, robin.id)).status).toBe(403);
    expect((await share(thread, jordan.id, false)).status).toBe(403);
    expect((await connect()).hello.threads).toMatchObject([{ id: thread.id, people: [got.createdBy, jordan.id] }]);
  });
  expect(heard(robins)).toEqual([]);

  // Public: Robin gets it too. Private again: Robin loses it, and Jordan is still on the list.
  await show(thread, 'public');
  expect((await robins.until('thread')).thread).toMatchObject({ visibility: 'public', shared: [jordan.id] });
  await show(thread, 'private');
  expect(await robins.until('thread-gone')).toMatchObject({ id: thread.id });
  expect((await theirs.until('thread', (e) => e.thread.visibility === 'private')).thread.shared).toEqual([jordan.id]);
  expect(theirs.events.some((e) => e.type === 'thread-gone')).toBe(false);

  // Taken back: gone from Jordan's screen, and no longer theirs to write in.
  await share(thread, jordan.id, false);
  expect(await theirs.until('thread-gone')).toMatchObject({ id: thread.id });
  expect((await as(jordan.cookie, () => say(thread, 'still here?'))).status).toBe(404);
  expect((await as(jordan.cookie, connect)).hello.threads).toEqual([]);
  expect((await connect()).hello.threads).toMatchObject([{ id: thread.id, shared: [] }]);

  // Two changes made at the same moment both count, and adding someone twice lists them once.
  await Promise.all([share(thread, jordan.id), share(thread, robin.id), share(thread, jordan.id)]);
  expect((await connect()).hello.threads[0].shared.toSorted()).toEqual([jordan.id, robin.id].toSorted());
  await Promise.all([share(thread, jordan.id, false), share(thread, robin.id, false)]);

  // Only someone else with an account can be added.
  await post(`${USERS_PATH}/${robin.id}/delete`);
  for (const bad of ['nobody', robin.id, got.createdBy, undefined]) {
    expect((await share(thread, bad)).status, String(bad)).toBe(400);
  }
  expect((await share(thread, jordan.id, 'yes')).status).toBe(400);
  expect((await show(thread, 'secret')).status).toBe(400);
  expect((await show(thread, undefined)).status).toBe(400);
  expect((await post('/api/threads/nope/visibility', { visibility: 'public' })).status).toBe(404);
  expect((await connect()).hello.threads).toMatchObject([{ visibility: 'private', shared: [] }]);
});

test('a private automation and the threads it starts are its maker’s alone, a public one is for everyone, and a change only counts for new runs', async () => {
  const admin = await whoAmI();
  const jordan = await teammate('jordan', 'Jordan');
  const tab = await connect();
  const theirs = await as(jordan.cookie, connect);
  const made = await automate();
  expect(made).toMatchObject({ visibility: 'private', createdBy: admin.id });
  const run = async () => (await (await post(`${AUTOMATIONS_PATH}/${made.id}/run`)).json()) as Thread;
  const first = await run();
  expect(first.visibility).toBe('private');
  await tab.status(first.id, 'done');

  // To the teammate there is no automation and no thread.
  await as(jordan.cookie, async () => {
    expect((await connect()).hello).toMatchObject({ automations: [], threads: [] });
    for (const path of [`/${made.id}`, `/${made.id}/run`, `/${made.id}/delete`])
      expect((await post(AUTOMATIONS_PATH + path, made)).status, path).toBe(404);
  });
  expect(theirs.events.filter((e) => e.type !== 'hello' && e.type !== 'channel')).toEqual([]);

  // Made public: the automation shows up for everyone, and so do the threads it starts from now on.
  const open = { ...made, visibility: 'public' };
  expect(await (await change(made, open)).json()).toMatchObject({ visibility: 'public' });
  expect((await theirs.until('automation')).automation).toMatchObject({ id: made.id, visibility: 'public' });
  const second = await as(jordan.cookie, run);
  expect(second).toMatchObject({ visibility: 'public', createdBy: admin.id, automationId: made.id });
  await theirs.status(second.id, 'done');
  expect((await as(jordan.cookie, connect)).hello.threads.map((t) => t.id)).toEqual([second.id]);

  // A teammate can change a public automation, but not who sees it.
  await as(jordan.cookie, async () => {
    expect((await change(made, { ...open, text: 'write a short digest' })).status).toBe(200);
    expect((await change(made, { ...open, visibility: 'private' })).status).toBe(403);
    expect((await change(made, { ...open, visibility: 'secret' })).status).toBe(400);
  });

  // Private again: it leaves the teammate's screen. The thread from while it was public stays theirs to see.
  await change(made, { ...open, visibility: 'private' });
  expect(await theirs.until('automation-gone')).toMatchObject({ id: made.id });
  const late = (await as(jordan.cookie, connect)).hello;
  expect(late.automations).toEqual([]);
  expect(late.threads.map((t) => t.id)).toEqual([second.id]);
  expect((await remove(made)).status).toBe(200);
  await tab.until('automation-gone');
  expect(theirs.events.filter((e) => e.type === 'automation-gone')).toHaveLength(1);
});

test('a private automation that runs when its time comes is heard of by its maker alone', async () => {
  const at = stopClock();
  await serve(TWO_TURNS);
  const jordan = await teammate('jordan', 'Jordan');
  const tab = await connect();
  const theirs = await as(jordan.cookie, connect);
  const digest = await as(jordan.cookie, () => automate(at(1)));

  aMinuteLater();
  const { thread } = await theirs.until('thread');
  expect(thread).toMatchObject({ automationId: digest.id, visibility: 'private', createdBy: jordan.id });
  // Its maker is told when it runs next.
  expect((await theirs.until('automation', (e) => e.automation.nextAt !== digest.nextAt)).automation.id).toBe(
    digest.id,
  );
  await theirs.status(thread.id, 'done');
  expect(tab.events.filter((e) => e.type === 'automation')).toEqual([]);
  expect(heard(tab)).toEqual([]);
});

test('a deleted account’s private threads stay hidden, and its private automations stop running', async () => {
  const jordan = await teammate('jordan', 'Jordan');
  const robin = await teammate('robin', 'Robin');
  const tab = await connect();
  const made = await as(jordan.cookie, async () => {
    const theirs = await connect();
    const thread = await startThread('make notes');
    await theirs.status(thread.id, 'done');
    await automate();
    await share(await startThread('for robin'), robin.id);
    const open = await automate({ visibility: 'public', text: 'for everyone' });
    return { thread, open };
  });
  await post(`${USERS_PATH}/${jordan.id}/delete`);

  const late = (await connect()).hello;
  expect(late.threads).toEqual([]);
  expect(late.automations).toMatchObject([{ id: made.open.id, on: true }]);
  expect((await say(made.thread, 'whose is this?')).status).toBe(404);
  // What they shared before stays with whoever it was shared with.
  expect((await as(robin.cookie, connect)).hello.threads).toMatchObject([{ title: 'for robin', shared: [robin.id] }]);
  expect(heard(tab)).toEqual([]);
  const kept = db.select().from(automations).all();
  expect(kept.map((row) => [row.text, row.on])).toEqual([
    ['write a digest', false],
    ['for everyone', true],
  ]);
});
