import type { Item, Seen } from '@acocrew/shared';
import Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { automations, channels, events, seen, threads } from './schema.ts';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

// Opens the database file (or ':memory:', or a copy of a database held in memory) and applies any migrations
// that have not run yet.
export function openDb(file: string | Buffer) {
  if (typeof file === 'string' && file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

export type Db = ReturnType<typeof openDb>;

// The columns the web app sees.
export const channelCols = { id: channels.id, name: channels.name, path: channels.path };
export const threadCols = {
  id: threads.id,
  channelId: threads.channelId,
  title: threads.title,
  model: threads.model,
  effort: threads.effort,
  context: threads.context,
  fast: threads.fast,
  access: threads.access,
  status: threads.status,
  path: threads.path,
  branch: threads.branch,
  people: threads.people,
  automationId: threads.automationId,
  updatedAt: threads.updatedAt,
  pinnedAt: threads.pinnedAt,
};

export const automationCols = {
  id: automations.id,
  channelId: automations.channelId,
  text: automations.text,
  time: automations.time,
  days: automations.days,
  from: automations.from,
  on: automations.on,
  model: automations.model,
  effort: automations.effort,
  context: automations.context,
  fast: automations.fast,
  access: automations.access,
  createdBy: automations.createdBy,
};

export const listChannels = (db: Db) => db.select(channelCols).from(channels).orderBy(asc(channels.position)).all();
export const listThreads = (db: Db) => db.select(threadCols).from(threads).orderBy(asc(threads.createdAt)).all();
export const listAutomations = (db: Db) =>
  db.select(automationCols).from(automations).orderBy(asc(automations.createdAt)).all();

// What this person has seen of every thread they ever opened.
export const listSeen = (db: Db, userId: string): Seen =>
  Object.fromEntries(
    db
      .select()
      .from(seen)
      .where(eq(seen.userId, userId))
      .all()
      .map((row) => [row.threadId, row.at]),
  );

export const saveItem = (db: Db, threadId: string, item: Item) => db.insert(events).values({ threadId, item }).run();

// Replays the log. An item keeps the place where it first appeared and takes its newest content.
export function loadItems(db: Db, threadId: string): Item[] {
  const rows = db.select().from(events).where(eq(events.threadId, threadId)).orderBy(asc(events.seq)).all();
  const items = new Map<string, Item>();
  for (const row of rows) items.set(row.item.id, row.item);
  return [...items.values()];
}
