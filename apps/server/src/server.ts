import {
  ACCESS,
  DECISIONS,
  EFFORTS,
  HEALTH_PATH,
  MODELS,
  WS_PATH,
  type Answer,
  type ClientEvent,
  type NewMessage,
} from '@acocrew/shared';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { WebSocketServer } from 'ws';
import { channelCols, listChannels, listThreads, loadItems, threadCols, type Db } from './db.ts';
import { folderInside, isRepo, listFolders } from './folders.ts';
import { createHub } from './hub.ts';
import { createRunner, type QueryFn } from './runner.ts';
import { channels, threads } from './schema.ts';

// `home` is the only folder tree that repositories can be picked from.
// `web` is the folder with the built web app. Without it the server only answers `/api` and `/ws`.
export type Deps = { db: Db; query: QueryFn; home: string; web?: string };

// The parts of a message, or null if any of them is not usable.
function readMessage(body: Partial<NewMessage>): NewMessage | null {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const { model, effort, access } = body;
  const known = (list: { id: string }[], id?: string) => list.some((option) => option.id === id);
  if (!text || !known(MODELS, model) || !known(EFFORTS, effort) || !known(ACCESS, access)) return null;
  return { text, model: model!, effort: effort!, access: access! };
}

export function createApp({ db, query, home, web }: Deps) {
  const hub = createHub();
  const runner = createRunner(db, hub, query);
  const app = new Hono();

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
    const row = { id: randomUUID(), name: basename(path), path, createdAt: Date.now() };
    const channel = db.insert(channels).values(row).returning(channelCols).get();
    hub.toAll({ type: 'channel', channel });
    return c.json(channel);
  });

  app.post('/api/threads', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const message = readMessage(body);
    const channel = db
      .select()
      .from(channels)
      .where(eq(channels.id, String(body.channelId)))
      .get();
    if (!message || !channel)
      return c.json({ error: 'Needs a channel, a message, a model, a reasoning level and an access level.' }, 400);
    const now = Date.now();
    const row = {
      id: randomUUID(),
      channelId: channel.id,
      title: message.text.split('\n')[0].slice(0, 70),
      model: message.model,
      effort: message.effort,
      access: message.access,
      status: 'working' as const,
      createdAt: now,
      updatedAt: now,
    };
    const thread = runner.withTasks(db.insert(threads).values(row).returning(threadCols).get());
    hub.toAll({ type: 'thread', thread });
    runner.send(thread.id, message);
    return c.json(thread);
  });

  app.post('/api/threads/:id/messages', async (c) => {
    const message = readMessage(await c.req.json().catch(() => ({})));
    const thread = db
      .select()
      .from(threads)
      .where(eq(threads.id, c.req.param('id')))
      .get();
    if (!message || !thread)
      return c.json({ error: 'Needs a thread, a message, a model, a reasoning level and an access level.' }, 400);
    runner.send(thread.id, message);
    return c.json({ ok: true });
  });

  app.post('/api/threads/:id/answers', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Answer;
    if (!DECISIONS.includes(body.decision)) return c.json({ error: 'Not an answer.' }, 400);
    const taken = runner.answer(c.req.param('id'), body);
    return taken ? c.json({ ok: true }) : c.json({ error: 'Claude is no longer waiting for this answer.' }, 409);
  });

  app.post('/api/threads/:id/stop', async (c) => {
    await runner.stop(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get(
    WS_PATH,
    upgradeWebSocket(() => ({
      onOpen(_, ws) {
        hub.add(ws);
        const threads = listThreads(db).map(runner.withTasks);
        hub.send(ws, { type: 'hello', channels: listChannels(db), threads });
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
export function startServer(port: number, deps: Deps) {
  const app = createApp(deps);
  const websocket = { server: new WebSocketServer({ noServer: true }) };
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1', websocket }, (info) =>
      resolve({ port: info.port, close: () => server.close() }),
    );
  });
}
