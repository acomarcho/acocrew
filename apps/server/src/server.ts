import {
  ACCESS,
  AUTOMATIONS_PATH,
  COMMANDS_PATH,
  CONTEXTS,
  DECISIONS,
  EFFORTS,
  FILE_MAX_BYTES,
  FILES_PATH,
  GITHUB_PATH,
  HEALTH_PATH,
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  IMAGES_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  ME_PATH,
  MODELS_PATH,
  PROXY_PATH,
  USERS_PATH,
  VISIBILITY,
  WS_PATH,
  fileName,
  tagsIn,
  type Answer,
  type ClientEvent,
  type Me,
  type NewAutomation,
  type NewMessage,
  type Places,
  type Thread,
  type Visibility,
} from '@acocrew/shared';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { and, eq, max, ne, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  createAuth,
  createUser,
  deleteUser,
  findPerson,
  listPeople,
  resetPassword,
  seedAdmin,
  temporaryPassword,
} from './auth.ts';
import { CHECK_MS, nextRun, readSchedule, shown, type Stored } from './automations.ts';
import {
  automationCols,
  canSee,
  channelCols,
  chatCols,
  chatSeen,
  listAutomations,
  listChannels,
  listSeen,
  listThreads,
  listUnread,
  loadChats,
  loadItems,
  threadCols,
  type Db,
  type StoredThread,
} from './db.ts';
import { folderInside, isRepo, listFolders } from './folders.ts';
import { addWorktree, listPlaces } from './git.ts';
import { listAccounts, switchAccount } from './github.ts';
import { createHub } from './hub.ts';
import { openFiles, type Files } from './files.ts';
import { openImages, type Images } from './images.ts';
import { createProxy } from './proxy.ts';
import { createRunner, type QueryFn } from './runner.ts';
import { automations, channels, chats, seen, session as sessions, shares, threads, user } from './schema.ts';
import { firstLine } from './title.ts';
import { threadTools } from './tools.ts';

// `home` is the only folder tree that repositories can be picked from.
// `images` is the folder where images and other files attached to messages are kept.
// `worktrees` is the folder where threads get their own working copy of a repository.
// `web` is the folder with the built web app. Without it the server only answers `/api` and `/ws`.
// `secret` signs the login cookies. `https` marks them as for https only.
// `gh` is the GitHub CLI: the program that is asked which GitHub accounts the machine is logged in to.
export type Deps = {
  db: Db;
  query: QueryFn;
  home: string;
  images: string;
  worktrees: string;
  secret: string;
  https?: boolean;
  web?: string;
  gh?: string;
};

const NAME_MAX = 50;
// A display name as it is kept, or nothing when it cannot be used.
function readName(value: unknown) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length <= NAME_MAX ? name : '';
}

// Says no to a request, with the reason as words a person can read.
const refuse = (c: Context, err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 400);

// The parts of a message, or null if any of them is not usable. Whether the model is one a thread can run on
// right now is for the caller to ask (see `unoffered`).
function readMessage(body: Partial<NewMessage>, store: Images, attached: Files): NewMessage | null {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const { images = [], files = [], model, effort, context, fast, access } = body;
  const known = (list: { id: string }[], id?: string) => list.some((option) => option.id === id);
  const usable =
    Array.isArray(images) &&
    images.every(store.find) &&
    Array.isArray(files) &&
    files.every(attached.has) &&
    (text || images.length || files.length) &&
    known(EFFORTS, effort) &&
    known(CONTEXTS, context) &&
    typeof fast === 'boolean' &&
    known(ACCESS, access) &&
    typeof model === 'string';
  if (!usable) return null;
  return { text, images, files, model: model!, effort: effort!, context: context!, fast, access: access! };
}

// Who sees a thread or an automation, or null if the value is not one of the choices.
const readVisibility = (value: unknown) =>
  VISIBILITY.some((option) => option.id === value) ? (value as Visibility) : null;

export async function createApp({ db, query, home, images, worktrees, secret, https = false, web, gh = 'gh' }: Deps) {
  const auth = createAuth(db, secret, https);
  await seedAdmin(auth, db);
  const hub = createHub();
  const store = openImages(images);
  const attached = openFiles(join(images, 'files'));
  const proxy = createProxy(db);
  const runner = createRunner(db, hub, query, store, attached, proxy, tools);
  // Why a thread cannot run on this model right now, or nothing when it can. A proxy model is off the list while
  // the proxy is away, which is worth saying in so many words.
  const unoffered = async (model: string) =>
    !(await proxy.offers(model)) && `${model} is not offered right now. Is the model proxy running?`;
  // `user` is whoever is logged in on the browser that sent the request, and `login` is the id of that login.
  // `thread` is the thread a request is about (see the routes under `/api/threads/:id`).
  const app = new Hono<{ Variables: { user: Me; login: string; thread: StoredThread } }>();

  // Browsers say which site a request comes from. Only our own pages may talk to the server, so that some
  // other website open in a teammate's browser cannot start threads here. A proxy in front (Tailscale, the
  // dev server) passes the address the browser used as `x-forwarded-host`.
  app.use(async (c, next) => {
    const origin = c.req.header('origin');
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
    if (origin && new URL(origin).host !== host) return c.json({ error: 'Wrong site.' }, 403);
    await next();
  });

  app.get(HEALTH_PATH, (c) => c.json({ ok: true }));

  // Logging in and out is Better Auth's. Nothing else of it can be reached from outside: accounts are made
  // and changed only through the routes below, which follow our own rules.
  app.post(LOGIN_PATH, (c) => auth.handler(c.req.raw));
  // Logging out also hangs up on the person's open tabs. The ones still logged in connect again by themselves.
  app.post(LOGOUT_PATH, async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const res = await auth.handler(c.req.raw);
    if (session) hub.kick(session.user.id);
    return res;
  });

  // From here on, everything needs a login.
  for (const path of ['/api/*', WS_PATH]) {
    app.use(path, async (c, next) => {
      const found = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
      if (!found.response) return c.json({ error: 'Log in first.' }, 401);
      const { id, name, username = null, admin, deleted, mustChangePassword } = found.response.user;
      c.set('user', { id, name, username, admin, deleted, mustChangePassword });
      c.set('login', found.response.session.id);
      // A login that is used keeps getting longer. The browser is handed the cookie that says so.
      for (const cookie of found.headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
      await next();
    });
  }

  app.get(ME_PATH, (c) => c.json(c.get('user')));

  app.post(`${ME_PATH}/password`, async (c) => {
    const { currentPassword, newPassword } = await c.req.json().catch(() => ({}));
    if (currentPassword === newPassword) return refuse(c, 'The new password has to be a different one.');
    try {
      await auth.api.changePassword({ body: { currentPassword, newPassword }, headers: c.req.raw.headers });
    } catch (err) {
      return refuse(c, err);
    }
    const { id } = c.get('user');
    db.update(user).set({ mustChangePassword: false }).where(eq(user.id, id)).run();
    // Whoever else was logged in to this account (with the old password) is not any more.
    db.delete(sessions)
      .where(and(eq(sessions.userId, id), ne(sessions.id, c.get('login'))))
      .run();
    hub.kick(id);
    return c.json({ ok: true });
  });

  // And everything from here on needs a password the person picked themselves.
  for (const path of ['/api/*', WS_PATH]) {
    app.use(path, async (c, next) => {
      if (c.get('user').mustChangePassword) return c.json({ error: 'Set a new password first.' }, 403);
      await next();
    });
  }

  const changed = (id: string) => hub.toAll({ type: 'person', person: findPerson(db, id)! });

  app.post(ME_PATH, async (c) => {
    const name = readName((await c.req.json().catch(() => ({}))).name);
    if (!name) return refuse(c, `A name needs 1 to ${NAME_MAX} characters.`);
    db.update(user)
      .set({ name })
      .where(eq(user.id, c.get('user').id))
      .run();
    changed(c.get('user').id);
    return c.json({ ok: true });
  });

  // Accounts are made and changed by admins only. So are which GitHub account the machine works as, and how it
  // reaches the model proxy.
  for (const path of [USERS_PATH, `${USERS_PATH}/*`, GITHUB_PATH, PROXY_PATH]) {
    app.use(path, async (c, next) => {
      if (!c.get('user').admin) return c.json({ error: 'Only an admin can do this.' }, 403);
      await next();
    });
  }
  // The account a request is about, unless it is gone.
  const target = (c: Context) => {
    const person = findPerson(db, c.req.param('id')!);
    return person && !person.deleted ? person : null;
  };
  const gone = (c: Context) => c.json({ error: 'User not found.' }, 404);

  // The password of a new or reset account is made here and said once, in the answer to the admin who asked.
  app.post(USERS_PATH, async (c) => {
    const { username, name } = await c.req.json().catch(() => ({}));
    // Without a display name, the username stands in for it.
    const typed = typeof name === 'string' ? name.trim() : '';
    const shown = typed ? readName(typed) : username;
    if (!shown) return refuse(c, `A name can have ${NAME_MAX} characters at most.`);
    const password = temporaryPassword();
    try {
      const id = await createUser(auth, { username, password, name: shown });
      changed(id);
      return c.json({ ...findPerson(db, id), password });
    } catch (err) {
      return refuse(c, err);
    }
  });

  app.post(`${USERS_PATH}/:id/password`, async (c) => {
    const person = target(c);
    if (!person) return gone(c);
    const password = await resetPassword(auth, db, person.id);
    hub.kick(person.id);
    return c.json({ password });
  });

  app.post(`${USERS_PATH}/:id/admin`, async (c) => {
    const person = target(c);
    if (!person) return gone(c);
    const admin = (await c.req.json().catch(() => ({}))).admin === true;
    const others = db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.admin, true), ne(user.id, person.id)))
      .all();
    if (!admin && !others.length) return refuse(c, 'There has to be at least one admin.');
    db.update(user).set({ admin }).where(eq(user.id, person.id)).run();
    changed(person.id);
    return c.json({ ok: true });
  });

  // Whoever deletes is an admin and cannot delete themselves, so an admin is always left.
  app.post(`${USERS_PATH}/:id/delete`, (c) => {
    const person = target(c);
    if (!person) return gone(c);
    if (person.id === c.get('user').id) return refuse(c, 'You cannot delete your own account.');
    deleteUser(db, person.id);
    hub.kick(person.id);
    changed(person.id);
    return c.json({ ok: true });
  });

  // The GitHub accounts logged in on the machine. Null when it has no GitHub CLI, so there is nothing to show.
  app.get(GITHUB_PATH, (c) =>
    listAccounts(gh).then(
      (accounts) => c.json(accounts),
      (err) => refuse(c, err),
    ),
  );

  // Switches which GitHub account is the active one. That goes for the whole machine: every thread, and
  // everyone. Only an account gh itself lists can be picked. The other admins are told.
  app.post(GITHUB_PATH, async (c) => {
    const { host, login } = await c.req.json().catch(() => ({}));
    try {
      const before = (await listAccounts(gh)) ?? [];
      const picked = before.find((account) => account.host === host && account.login === login);
      if (!picked) return refuse(c, 'That GitHub account is not logged in on this machine.');
      await switchAccount(gh, picked);
      // A host has one active account, so the rest of the list is as it was.
      const accounts = before.map((account) =>
        account.host === host ? { ...account, active: account === picked } : account,
      );
      hub.toSome({ type: 'github', accounts }, (id) => findPerson(db, id)!.admin);
      return c.json(accounts);
    } catch (err) {
      return refuse(c, err);
    }
  });

  app.get(PROXY_PATH, async (c) => c.json(await proxy.shown()));

  app.post(PROXY_PATH, async (c) => {
    const why = proxy.save(await c.req.json().catch(() => ({})));
    return why ? refuse(c, why) : c.json(await proxy.shown());
  });

  // The models a thread can run on, for the model picker.
  app.get(MODELS_PATH, async (c) => c.json(await proxy.models()));

  app.get('/api/folders', (c) => {
    const list = listFolders(home, c.req.query('path') ?? home);
    return list ? c.json(list) : c.json({ error: 'Folder not found.' }, 404);
  });

  app.post('/api/channels', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = folderInside(home, String(body.path));
    if (!path || !isRepo(path)) return c.json({ error: 'Pick a git repository inside the home folder.' }, 400);
    const existing = db.select(channelCols).from(channels).where(eq(channels.path, path)).get();
    if (existing) return c.json(existing);
    const position = sql`(select count(*) from ${channels})`;
    const row = { id: randomUUID(), name: basename(path), path, position, createdAt: Date.now() };
    const channel = db.insert(channels).values(row).returning(channelCols).get();
    hub.toAll({ type: 'channel', channel });
    return c.json(channel);
  });

  // The sidebar's new order: the id of every channel, each one once.
  app.post('/api/channels/order', async (c) => {
    const { ids } = await c.req.json().catch(() => ({}));
    const known = new Set(listChannels(db).map((channel) => channel.id));
    const full = Array.isArray(ids) && ids.length === known.size && new Set(ids).size === known.size;
    if (!full || !ids.every((id) => known.has(id))) return c.json({ error: 'Needs every repository once.' }, 400);
    db.transaction((tx) => {
      ids.forEach((id, position) => tx.update(channels).set({ position }).where(eq(channels.id, id)).run());
    });
    hub.toAll({ type: 'order', ids });
    return c.json({ ok: true });
  });

  // What the start screen offers: branches a new worktree can start from, and worktrees that exist.
  app.get('/api/channels/:id/places', async (c) => {
    const channel = db
      .select()
      .from(channels)
      .where(eq(channels.id, c.req.param('id')))
      .get();
    if (!channel) return c.json({ error: 'Channel not found.' }, 404);
    return c.json(await listPlaces(channel.path));
  });

  // Starts a thread: saves it, tells everyone and hands the first message to Claude. People and automations
  // both start threads through here. Gives back the thread, or why there is none.
  type Where = { from?: unknown; path?: unknown };
  type Refusal = { error: string; status: 400 | 500 };
  type Starter = { userId: string; visibility: Visibility; automationId?: string };
  async function startThread(
    channel: typeof channels.$inferSelect,
    message: NewMessage,
    pick: Where,
    { userId, visibility, automationId }: Starter,
  ): Promise<Thread | Refusal> {
    const id = randomUUID();
    const short = id.slice(0, 8);
    // The thread works in a folder that exists already, or in a new worktree: a second working copy of the
    // repository, on a new branch. Only what git itself lists can be picked.
    let place: Places['worktrees'][number];
    try {
      const places = await listPlaces(channel.path);
      const existing = places.worktrees.find((worktree) => worktree.path === pick.path);
      const from = places.branches.find((branch) => branch.name === pick.from);
      if (!existing && !from) return { error: 'Pick a branch to start from, or a worktree that exists.', status: 400 };
      place = existing ?? { path: join(worktrees, channel.name, short), branch: `acocrew/${short}` };
      if (!existing) await addWorktree(channel.path, place.path, place.branch!, from!);
    } catch (err) {
      return { error: `Could not make a worktree: ${(err as { stderr?: string }).stderr || err}`, status: 500 };
    }
    const now = Date.now();
    const row = {
      id,
      channelId: channel.id,
      path: place.path === channel.path ? null : place.path,
      branch: place.branch,
      title: firstLine(message.text) || (message.files[0] ? fileName(message.files[0]) : 'Image'),
      model: message.model,
      effort: message.effort,
      context: message.context,
      fast: message.fast,
      access: message.access,
      status: 'working' as const,
      createdBy: userId,
      visibility,
      automationId,
      people: [userId],
      createdAt: now,
      updatedAt: now,
    };
    const thread = runner.withLive(db.insert(threads).values(row).returning(threadCols).get());
    hub.thread(thread);
    runner.send(thread.id, message, userId);
    if (message.text) runner.name(thread.id, message.text);
    return thread;
  }
  // What Claude in a thread can do on acocrew itself, checked like what a person sends.
  function tools(threadId: string) {
    return threadTools(threadId, {
      db,
      async start(channelId, message, pick, starter) {
        const why = await unoffered(message.model);
        return why ? { error: why } : startThread(findChannel(channelId)!, message, pick, starter);
      },
      async send(id, message, userId) {
        const why = await unoffered(message.model);
        if (!why) runner.send(id, message, userId);
        return why || undefined;
      },
    });
  }
  const findChannel = (id: unknown) =>
    db
      .select()
      .from(channels)
      .where(eq(channels.id, String(id)))
      .get();

  app.post('/api/threads', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const message = readMessage(body, store, attached);
    const channel = findChannel(body.channelId);
    const visibility = readVisibility(body.visibility);
    if (!message || !channel || !visibility)
      return c.json({ error: 'Needs a channel, a message and a full set of settings.' }, 400);
    const why = await unoffered(message.model);
    if (why) return refuse(c, why);
    const thread = await startThread(channel, message, body, { userId: c.get('user').id, visibility });
    return 'error' in thread ? c.json({ error: thread.error }, thread.status) : c.json(thread);
  });

  // One run of an automation: its message in a fresh thread, in a new worktree, as the person who made it.
  // The thread is seen by whoever sees the automation at that moment.
  const runAutomation = ({ id, channelId, from, createdBy, visibility, ...message }: Stored) => {
    const starter = { userId: createdBy, visibility, automationId: id };
    return startThread(findChannel(channelId)!, { ...message, images: [], files: [] }, { from }, starter);
  };
  // How an automation is now, to everyone who sees it.
  const announce = (row: Stored) =>
    hub.toSome({ type: 'automation', automation: shown(row) }, (userId) => canSee(row, userId));

  // Once a minute, every automation that is on and whose time came since the last look is run. The first look
  // counts from when the server started, so a run that was missed while the server was off is skipped.
  // A time that had passed already when the automation was saved does not count either: it was told to
  // everyone as running next on another day.
  let looked = Date.now();
  const saved = new Map<string, number>();
  const check = setInterval(() => {
    const before = looked;
    looked = Date.now();
    for (const automation of listAutomations(db).filter((automation) => automation.on)) {
      if (nextRun(automation, Math.max(before, saved.get(automation.id) ?? 0)) > looked) continue;
      // Nobody is there to be told when it fails, so the reason goes to the server's log.
      const failed = (why: unknown) => console.error(`Automation ${automation.id} did not run:`, why);
      runAutomation(automation).then((thread) => 'error' in thread && failed(thread.error), failed);
      // It runs next at another time now.
      announce(automation);
    }
    // What was saved before this look is behind it from now on.
    saved.clear();
  }, CHECK_MS).unref();

  // What an automation is made of, or null if any part cannot be used. A newly picked branch has to be one
  // git lists, and a newly picked model one a thread can run on. The branch and model it had (`kept`) are taken
  // as they are, so that an automation whose branch is gone, or whose proxy model is away, can still be paused.
  async function readAutomation(body: Partial<NewAutomation>, kept?: Stored) {
    const message = readMessage({ ...body, images: [], files: [] }, store, attached);
    const schedule = readSchedule(body);
    const channel = findChannel(body.channelId);
    const visibility = readVisibility(body.visibility);
    if (!message?.text || !schedule || !channel || !visibility || typeof body.from !== 'string') return null;
    const listed =
      body.from === kept?.from || (await listPlaces(channel.path)).branches.some((b) => b.name === body.from);
    if (!listed || (message.model !== kept?.model && (await unoffered(message.model)))) return null;
    const { images: _, files: __, ...settings } = message;
    return { ...settings, ...schedule, channelId: channel.id, from: body.from, visibility };
  }
  const NOT_AN_AUTOMATION =
    'Needs a channel, a message, a time, at least one day, a branch and a full set of settings.';
  // The automation a request is about. One the person may not see does not exist for them.
  const findAutomation = (c: Context) => {
    const row = db
      .select(automationCols)
      .from(automations)
      .where(eq(automations.id, c.req.param('id')!))
      .get();
    return row && canSee(row, c.get('user').id) ? row : undefined;
  };
  const noAutomation = (c: Context) => c.json({ error: 'Automation not found.' }, 404);
  const tellAutomation = (c: Context, row: Stored) => {
    saved.set(row.id, Date.now());
    announce(row);
    return c.json(shown(row));
  };

  app.post(AUTOMATIONS_PATH, async (c) => {
    const parts = await readAutomation(await c.req.json().catch(() => ({})));
    if (!parts) return refuse(c, NOT_AN_AUTOMATION);
    const row = { ...parts, id: randomUUID(), createdBy: c.get('user').id, createdAt: Date.now() };
    return tellAutomation(c, db.insert(automations).values(row).returning(automationCols).get());
  });

  // Changes what it sends, when and how, and whether it is on. It stays in its repository.
  app.post(`${AUTOMATIONS_PATH}/:id`, async (c) => {
    const old = findAutomation(c);
    if (!old) return noAutomation(c);
    const body = await c.req.json().catch(() => ({}));
    const parts = await readAutomation({ ...body, channelId: old.channelId }, old);
    if (!parts || typeof body.on !== 'boolean') return refuse(c, NOT_AN_AUTOMATION);
    if (parts.visibility !== old.visibility && old.createdBy !== c.get('user').id)
      return c.json({ error: 'Only the person who made an automation can change who sees it.' }, 403);
    const set = { ...parts, on: body.on as boolean };
    const row = db.update(automations).set(set).where(eq(automations.id, old.id)).returning(automationCols).get();
    // Whoever saw it and no longer does is told it is gone.
    hub.toSome({ type: 'automation-gone', id: old.id }, (userId) => canSee(old, userId) && !canSee(row, userId));
    return tellAutomation(c, row);
  });

  // The threads it started stay, and no longer say an automation started them.
  app.post(`${AUTOMATIONS_PATH}/:id/delete`, (c) => {
    const old = findAutomation(c);
    if (!old) return noAutomation(c);
    db.delete(automations).where(eq(automations.id, old.id)).run();
    hub.toSome({ type: 'automation-gone', id: old.id }, (userId) => canSee(old, userId));
    return c.json({ ok: true });
  });

  // Runs it right now, whatever its schedule says, also while it is paused.
  app.post(`${AUTOMATIONS_PATH}/:id/run`, async (c) => {
    const automation = findAutomation(c);
    if (!automation) return noAutomation(c);
    const thread = await runAutomation(automation);
    return 'error' in thread ? c.json({ error: thread.error }, thread.status) : c.json(thread);
  });

  // The thread with this id, if this person sees it. A thread they may not see does not exist for them.
  const findThread = (id: string, userId: string) => {
    const thread = db.select(threadCols).from(threads).where(eq(threads.id, id)).get();
    return thread && canSee(thread, userId) ? thread : undefined;
  };

  // Every route about one thread starts here.
  app.use('/api/threads/:id/*', async (c, next) => {
    const thread = findThread(c.req.param('id'), c.get('user').id);
    if (!thread) return c.json({ error: 'Thread not found.' }, 404);
    c.set('thread', thread);
    await next();
  });

  app.post('/api/threads/:id/messages', async (c) => {
    const message = readMessage(await c.req.json().catch(() => ({})), store, attached);
    if (!message) return c.json({ error: 'Needs a message and a full set of settings.' }, 400);
    const why = await unoffered(message.model);
    if (why) return refuse(c, why);
    runner.send(c.get('thread').id, message, c.get('user').id);
    return c.json({ ok: true });
  });

  // Who sees a thread is for whoever started it to decide: whether it is private or public, and who it is
  // shared with. The people stay on the list while it is public, for when it is private again.
  for (const part of ['visibility', 'shares']) {
    app.use(`/api/threads/:id/${part}`, async (c, next) => {
      if (c.get('thread').createdBy !== c.get('user').id)
        return c.json({ error: 'Only the person who started a thread can share it.' }, 403);
      await next();
    });
  }
  // Makes such a change and tells everyone how the thread is now. Whoever saw it and no longer does is told
  // it is gone. How the thread was is read right before the change, so that two changes made close together
  // cannot miss each other. This is not news: the thread keeps its `updatedAt`.
  const reshare = (id: string, change: () => unknown) => {
    const read = () => db.select(threadCols).from(threads).where(eq(threads.id, id)).get()!;
    const old = read();
    change();
    const row = read();
    hub.drop(id, (userId) => canSee(old, userId) && !canSee(row, userId));
    hub.thread(runner.withLive(row));
    return { ok: true };
  };

  app.post('/api/threads/:id/visibility', async (c) => {
    const visibility = readVisibility((await c.req.json().catch(() => ({}))).visibility);
    if (!visibility) return c.json({ error: 'Needs private or public.' }, 400);
    const { id } = c.get('thread');
    return c.json(reshare(id, () => db.update(threads).set({ visibility }).where(eq(threads.id, id)).run()));
  });

  // Shares the thread with one person, or takes that back. One person at a time, so that two changes made
  // close together cannot undo each other.
  app.post('/api/threads/:id/shares', async (c) => {
    const { userId, shared } = await c.req.json().catch(() => ({}));
    const thread = c.get('thread');
    const person = findPerson(db, String(userId));
    const addable = person && !person.deleted && person.id !== thread.createdBy;
    if (typeof shared !== 'boolean' || (shared && !addable))
      return c.json({ error: 'Needs someone else with an account, and shared or not.' }, 400);
    const row = { threadId: thread.id, userId: String(userId), createdAt: Date.now() };
    const mine = and(eq(shares.threadId, row.threadId), eq(shares.userId, row.userId));
    return c.json(
      reshare(thread.id, () =>
        shared ? db.insert(shares).values(row).onConflictDoNothing().run() : db.delete(shares).where(mine).run(),
      ),
    );
  });

  app.post('/api/threads/:id/answers', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Answer;
    if (!DECISIONS.includes(body.decision)) return c.json({ error: 'Not an answer.' }, 400);
    const taken = runner.answer(c.get('thread').id, body);
    return taken ? c.json({ ok: true }) : c.json({ error: 'Claude is no longer waiting for this answer.' }, 409);
  });

  // The person has the thread on screen, as it was at `at` (its `updatedAt` in their browser). What happened
  // after that is still new to them. Their other devices are told.
  app.post('/api/threads/:id/seen', async (c) => {
    const { at } = await c.req.json().catch(() => ({}));
    const thread = c.get('thread');
    if (!Number.isFinite(at)) return c.json({ error: 'Needs a time.' }, 400);
    // What was seen once stays seen: a device that is behind cannot take it back.
    const row = { userId: c.get('user').id, threadId: thread.id, at: Math.min(at, thread.updatedAt) };
    const kept = db
      .insert(seen)
      .values(row)
      .onConflictDoUpdate({ target: [seen.userId, seen.threadId], set: { at: sql`max(${seen.at}, excluded.at)` } })
      .returning()
      .get();
    hub.toUser(kept.userId, { type: 'seen', seen: { [kept.threadId]: kept.at } });
    return c.json({ ok: true });
  });

  // How much of a thread's chat is new to this person, as they are told.
  const unreadIn = (userId: string, threadId: string) => ({
    type: 'unread' as const,
    unread: { [threadId]: listUnread(db, userId, threadId)[threadId] ?? { count: 0, tagged: false } },
  });

  // Notes that the person had the thread's chat on screen up to the message with this id. What was read once
  // stays read: a device that is behind cannot take it back.
  const readChat = (userId: string, threadId: string, chat: number) =>
    db
      .insert(seen)
      .values({ userId, threadId, at: 0, chat })
      .onConflictDoUpdate({
        target: [seen.userId, seen.threadId],
        set: { chat: sql`max(${seen.chat}, excluded.chat)` },
      })
      .run();

  // Something a person writes to the other people in the thread. It is kept apart from what is said to Claude
  // and never handed to it. Everyone who sees the thread is told, wherever they are in the app. This is not
  // news about Claude: the thread keeps its `updatedAt`.
  app.post('/api/threads/:id/chats', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'Needs a message.' }, 400);
    const me = c.get('user').id;
    // How the thread is right now: who sees it may have changed while the message came in.
    const thread = findThread(c.get('thread').id, me);
    if (!thread) return c.json({ error: 'Thread not found.' }, 404);
    // Only someone else who sees the thread can be tagged.
    const names = tagsIn(text);
    const tagged = listPeople(db)
      .filter((person) => person.id !== me && canSee(thread, person.id))
      .filter((person) => person.username && names.includes(person.username.toLowerCase()))
      .map((person) => person.id);
    const chat = db
      .insert(chats)
      .values({ threadId: thread.id, userId: me, text, tagged, at: Date.now() })
      .returning(chatCols)
      .get();
    // Whoever writes has the chat in front of them, so everything up to their own message is read.
    readChat(me, thread.id, chat.id);
    // Writing in the chat is taking part in the thread.
    if (!thread.people.includes(me)) {
      thread.people.push(me);
      const set = { people: thread.people };
      hub.thread(
        runner.withLive(db.update(threads).set(set).where(eq(threads.id, thread.id)).returning(threadCols).get()),
      );
    }
    hub.toSome({ type: 'chat', threadId: thread.id, chat }, (userId) => canSee(thread, userId));
    hub.toEach((userId) => (canSee(thread, userId) ? unreadIn(userId, thread.id) : undefined));
    return c.json(chat);
  });

  // The person had the thread's chat on screen, up to the message with this id. Their other devices are told.
  app.post('/api/threads/:id/chats/seen', async (c) => {
    const { id } = await c.req.json().catch(() => ({}));
    const thread = c.get('thread');
    if (!Number.isInteger(id)) return c.json({ error: 'Needs the id of a chat message.' }, 400);
    // Nobody can have read more than there is.
    const me = c.get('user').id;
    const { last } = db
      .select({ last: max(chats.id) })
      .from(chats)
      .where(eq(chats.threadId, thread.id))
      .get()!;
    readChat(me, thread.id, Math.min(id, last ?? 0));
    hub.toUser(me, unreadIn(me, thread.id));
    return c.json({ ok: true });
  });

  // Pins the thread to the top of the list for everyone who sees it, or takes it off again. This is not news:
  // the thread keeps its `updatedAt`, so it does not turn up as new for anyone.
  app.post('/api/threads/:id/pin', async (c) => {
    const { pinned } = await c.req.json().catch(() => ({}));
    if (typeof pinned !== 'boolean') return c.json({ error: 'Needs pinned or not.' }, 400);
    const set = { pinnedAt: pinned ? Date.now() : null };
    const row = db
      .update(threads)
      .set(set)
      .where(eq(threads.id, c.get('thread').id))
      .returning(threadCols)
      .get();
    hub.thread(runner.withLive(row));
    return c.json({ ok: true });
  });

  app.post('/api/threads/:id/stop', async (c) => {
    await runner.stop(c.get('thread').id);
    return c.json({ ok: true });
  });

  // What the message box suggests after a `/`: what Claude can run where the thread works, or in the
  // channel's repository for a thread that has not been started yet.
  app.get(COMMANDS_PATH, async (c) => {
    const thread = findThread(c.req.query('thread') ?? '', c.get('user').id);
    const channel = db
      .select()
      .from(channels)
      .where(eq(channels.id, thread?.channelId ?? c.req.query('channel') ?? ''))
      .get();
    if (!channel) return c.json({ error: 'Needs a thread or a channel.' }, 404);
    return c.json(await runner.commands(thread?.path ?? channel.path));
  });

  // The browser sends one image as the whole request, and puts the id it gets back in the message.
  const tooBig = bodyLimit({
    maxSize: IMAGE_MAX_BYTES,
    onError: (c) => c.json({ error: 'An image can be 10MB at most.' }, 413),
  });
  app.post(IMAGES_PATH, tooBig, async (c) => {
    const type = c.req.header('content-type') ?? '';
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!Object.hasOwn(IMAGE_TYPES, type) || !bytes.length)
      return c.json({ error: 'Only PNG, JPEG, GIF and WebP images can be attached.' }, 400);
    return c.json({ id: store.save(IMAGE_TYPES[type], bytes) });
  });

  // Any other file is sent the same way, with its name in the address.
  const fileTooBig = bodyLimit({
    maxSize: FILE_MAX_BYTES,
    onError: (c) => c.json({ error: 'A file can be 100MB at most.' }, 413),
  });
  app.post(FILES_PATH, fileTooBig, async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) return c.json({ error: 'The file is empty.' }, 400);
    return c.json({ id: attached.save(c.req.query('name') ?? '', bytes) });
  });

  // An image never changes, so browsers may keep it. `nosniff` makes them treat it as an image and nothing else.
  app.get(`${IMAGES_PATH}/:id`, (c) => {
    const image = store.find(c.req.param('id'));
    if (!image) return c.json({ error: 'Image not found.' }, 404);
    return c.body(readFileSync(image.file), 200, {
      'content-type': image.type,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    });
  });

  app.get(
    WS_PATH,
    upgradeWebSocket((c) => ({
      onOpen(_, ws) {
        const { id } = c.get('user');
        hub.add(ws, id);
        // Only what this person sees.
        const mine = (row: Parameters<typeof canSee>[0]) => canSee(row, id);
        const threads = listThreads(db).filter(mine).map(runner.withLive);
        const seen = listSeen(db, id);
        // Chat in a thread the person no longer sees is not theirs any more.
        const unread = Object.fromEntries(
          Object.entries(listUnread(db, id)).filter(([threadId]) => threads.some((thread) => thread.id === threadId)),
        );
        const automated = listAutomations(db).filter(mine).map(shown);
        const channels = listChannels(db);
        const lists = { channels, threads, people: listPeople(db), seen, unread, automations: automated };
        // JavaScript counts how far UTC is ahead of this machine. We say it the other way around.
        hub.send(ws, { type: 'hello', ...lists, utcOffset: -new Date().getTimezoneOffset() });
      },
      // The browser says which thread it is looking at. It is signed up for that thread's events and gets
      // everything so far in the same step, so nothing can slip in between.
      onMessage(message, ws) {
        const { threadId } = JSON.parse(String(message.data)) as ClientEvent;
        const { id } = c.get('user');
        if (!findThread(threadId, id)) return;
        hub.open(ws, threadId);
        const items = [...loadItems(db, threadId), ...runner.live(threadId)].sort((a, b) => a.at - b.at);
        const chat = { chats: loadChats(db, threadId), chatSeen: chatSeen(db, id, threadId) };
        hub.send(ws, { type: 'items', threadId, items, ...chat });
      },
      onClose: (_, ws) => void hub.remove(ws),
    })),
  );

  // The built web app. A path that is not a file gets the app itself, which then shows the right screen.
  // Files in assets/ get a new name each build. All others (index.html, the manifest, icons) keep theirs, so
  // the browser must ask before reusing its copy. Otherwise a phone can keep running the old app after an update.
  if (web) {
    const onFound = (path: string, c: Context) => {
      if (!path.includes('/assets/')) c.header('Cache-Control', 'no-cache');
    };
    app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
    app.use(serveStatic({ root: web, onFound }));
    app.get('*', serveStatic({ root: web, path: 'index.html', onFound }));
  }

  return { app, close: () => clearInterval(check) };
}

// Listens on localhost only. Tailscale or a tunnel sits in front of it.
export async function startServer(port: number, deps: Deps) {
  const { app, close } = await createApp(deps);
  const websocket = { server: new WebSocketServer({ noServer: true }) };
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1', websocket }, (info) =>
      resolve({
        port: info.port,
        close() {
          close();
          server.close();
        },
      }),
    );
  });
}
