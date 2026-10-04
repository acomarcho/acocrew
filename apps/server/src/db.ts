import type { Item, Seen, Thread, Visibility } from '@acocrew/shared';
import Database from 'better-sqlite3';
import { asc, eq, sql } from 'drizzle-orm';
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
  visibility: threads.visibility,
  createdBy: threads.createdBy,
  // Read with the row, so that a thread never goes anywhere without the people it is shared with. The ones
  // added first come first.
  shared: sql<string>`(select json_group_array(user_id order by created_at, rowid) from shares
    where thread_id = threads.id)`.mapWith((ids): string[] => JSON.parse(ids)),
};

// A thread as it is stored: without what is only known while Claude runs.
export type StoredThread = Omit<Thread, 'tasks' | 'since'>;

// The one rule for who sees a thread or an automation: everyone when it is public, otherwise whoever made
// it and, for a thread, the people it is shared with.
type Owned = { visibility: Visibility; createdBy: string | null; shared?: string[] };
export const canSee = (thing: Owned, userId: string) =>
  thing.visibility === 'public' || thing.createdBy === userId || Boolean(thing.shared?.includes(userId));

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
  visibility: automations.visibility,
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
