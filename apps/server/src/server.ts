import {
  ACCESS,
  COMMANDS_PATH,
  CONTEXTS,
  DECISIONS,
  EFFORTS,
  HEALTH_PATH,
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  IMAGES_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  ME_PATH,
  MODELS,
  USERS_PATH,
  WS_PATH,
  type Answer,
  type ClientEvent,
  type Me,
  type NewMessage,
  type Places,
} from '@acocrew/shared';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { and, eq, ne, sql } from 'drizzle-orm';
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
import { channelCols, listChannels, listSeen, listThreads, loadItems, threadCols, type Db } from './db.ts';
import { folderInside, isRepo, listFolders } from './folders.ts';
import { addWorktree, listPlaces } from './git.ts';
import { createHub } from './hub.ts';
import { openImages, type Images } from './images.ts';
import { createRunner, type QueryFn } from './runner.ts';
import { channels, seen, session as sessions, threads, user } from './schema.ts';
import { firstLine } from './title.ts';

// `home` is the only folder tree that repositories can be picked from.
// `images` is the folder where images attached to messages are kept.
// `worktrees` is the folder where threads get their own working copy of a repository.
// `web` is the folder with the built web app. Without it the server only answers `/api` and `/ws`.
// `secret` signs the login cookies. `https` marks them as for https only.
export type Deps = {
  db: Db;
  query: QueryFn;
  home: string;
  images: string;
  worktrees: string;
  secret: string;
  https?: boolean;
  web?: string;
};

const NAME_MAX = 50;
// A display name as it is kept, or nothing when it cannot be used.
function readName(value: unknown) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length <= NAME_MAX ? name : '';
}

// Says no to a request, with the reason as words a person can read.
const refuse = (c: Context, err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 400);

// The parts of a message, or null if any of them is not usable.
function readMessage(body: Partial<NewMessage>, store: Images): NewMessage | null {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const { images = [], model, effort, context, fast, access } = body;
  const known = (list: { id: string }[], id?: string) => list.some((option) => option.id === id);
  const usable =
    Array.isArray(images) &&
    images.every(store.find) &&
    (text || images.length) &&
    known(MODELS, model) &&
    known(EFFORTS, effort) &&
    known(CONTEXTS, context) &&
    typeof fast === 'boolean' &&
    known(ACCESS, access);
  if (!usable) return null;
  return { text, images, model: model!, effort: effort!, context: context!, fast, access: access! };
}

export async function createApp({ db, query, home, images, worktrees, secret, https = false, web }: Deps) {
  const auth = createAuth(db, secret, https);
  await seedAdmin(auth, db);
  const hub = createHub();
  const store = openImages(images);
  const runner = createRunner(db, hub, query, store);
  // `user` is whoever is logged in on the browser that sent the request, and `login` is the id of that login.
  const app = new Hono<{ Variables: { user: Me; login: string } }>();

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

  // Accounts are made and changed by admins only.
  for (const path of [USERS_PATH, `${USERS_PATH}/*`]) {
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

  app.post('/api/threads', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const message = readMessage(body, store);
    const channel = db
      .select()
      .from(channels)
      .where(eq(channels.id, String(body.channelId)))
      .get();
    if (!message || !channel) return c.json({ error: 'Needs a channel, a message and a full set of settings.' }, 400);
    const id = randomUUID();
    const short = id.slice(0, 8);
    // The thread works in a folder that exists already, or in a new worktree: a second working copy of the
    // repository, on a new branch. Only what git itself lists can be picked.
    let place: Places['worktrees'][number];
    try {
      const places = await listPlaces(channel.path);
      const existing = places.worktrees.find((worktree) => worktree.path === body.path);
      const from = places.branches.find((branch) => branch.name === body.from);
      if (!existing && !from) return c.json({ error: 'Pick a branch to start from, or a worktree that exists.' }, 400);
      place = existing ?? { path: join(worktrees, channel.name, short), branch: `acocrew/${short}` };
      if (!existing) await addWorktree(channel.path, place.path, place.branch!, from!);
    } catch (err) {
      return c.json({ error: `Could not make a worktree: ${(err as { stderr?: string }).stderr || err}` }, 500);
    }
    const now = Date.now();
    const row = {
      id,
      channelId: channel.id,
      path: place.path === channel.path ? null : place.path,
      branch: place.branch,
      title: firstLine(message.text) || 'Image',
      model: message.model,
      effort: message.effort,
      context: message.context,
      fast: message.fast,
      access: message.access,
      status: 'working' as const,
      createdBy: c.get('user').id,
      people: [c.get('user').id],
      createdAt: now,
      updatedAt: now,
    };
    const thread = runner.withLive(db.insert(threads).values(row).returning(threadCols).get());
    hub.toAll({ type: 'thread', thread });
    runner.send(thread.id, message, c.get('user').id);
    if (message.text) runner.name(thread.id, message.text);
    return c.json(thread);
  });

  app.post('/api/threads/:id/messages', async (c) => {
    const message = readMessage(await c.req.json().catch(() => ({})), store);
    const thread = db
      .select()
      .from(threads)
      .where(eq(threads.id, c.req.param('id')))
      .get();
    if (!message || !thread) return c.json({ error: 'Needs a thread, a message and a full set of settings.' }, 400);
    runner.send(thread.id, message, c.get('user').id);
    return c.json({ ok: true });
  });

  app.post('/api/threads/:id/answers', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Answer;
    if (!DECISIONS.includes(body.decision)) return c.json({ error: 'Not an answer.' }, 400);
    const taken = runner.answer(c.req.param('id'), body);
    return taken ? c.json({ ok: true }) : c.json({ error: 'Claude is no longer waiting for this answer.' }, 409);
  });

  // The person has the thread on screen, as it was at `at` (its `updatedAt` in their browser). What happened
  // after that is still new to them. Their other devices are told.
  app.post('/api/threads/:id/seen', async (c) => {
    const { at } = await c.req.json().catch(() => ({}));
    const thread = db
      .select()
      .from(threads)
      .where(eq(threads.id, c.req.param('id')))
      .get();
    if (!thread || !Number.isFinite(at)) return c.json({ error: 'Needs a thread and a time.' }, 400);
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

  app.post('/api/threads/:id/stop', async (c) => {
    await runner.stop(c.req.param('id'));
    return c.json({ ok: true });
  });

  // What the message box suggests after a `/`: what Claude can run where the thread works, or in the
  // channel's repository for a thread that has not been started yet.
  app.get(COMMANDS_PATH, async (c) => {
    const thread = db
      .select()
      .from(threads)
      .where(eq(threads.id, c.req.query('thread') ?? ''))
      .get();
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
        const threads = listThreads(db).map(runner.withLive);
        const seen = listSeen(db, id);
        hub.send(ws, { type: 'hello', channels: listChannels(db), threads, people: listPeople(db), seen });
      },
      // The browser says which thread it is looking at. It is signed up for that thread's events and gets
      // everything so far in the same step, so nothing can slip in between.
      onMessage(message, ws) {
        const { threadId } = JSON.parse(String(message.data)) as ClientEvent;
        hub.open(ws, threadId);
        const items = [...loadItems(db, threadId), ...runner.live(threadId)].sort((a, b) => a.at - b.at);
        hub.send(ws, { type: 'items', threadId, items });
      },
      onClose: (_, ws) => void hub.remove(ws),
    })),
  );

  // The built web app. A path that is not a file gets the app itself, which then shows the right screen.
  if (web) {
    app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
    app.use(serveStatic({ root: web }));
    app.get('*', serveStatic({ root: web, path: 'index.html' }));
  }

  return app;
}

// Listens on localhost only. Tailscale or a tunnel sits in front of it.
export async function startServer(port: number, deps: Deps) {
  const app = await createApp(deps);
  const websocket = { server: new WebSocketServer({ noServer: true }) };
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1', websocket }, (info) =>
      resolve({ port: info.port, close: () => server.close() }),
    );
  });
}
