import type { Item } from '@acocrew/shared';
import Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channels, events, threads } from './schema.ts';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

// Opens the database file (or ':memory:') and applies any migrations that have not run yet.
export function openDb(file: string) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
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
  access: threads.access,
  status: threads.status,
  updatedAt: threads.updatedAt,
};

export const listChannels = (db: Db) => db.select(channelCols).from(channels).orderBy(asc(channels.createdAt)).all();
export const listThreads = (db: Db) => db.select(threadCols).from(threads).orderBy(asc(threads.createdAt)).all();

export const saveItem = (db: Db, threadId: string, item: Item) => db.insert(events).values({ threadId, item }).run();

// Replays the log. An item keeps the place where it first appeared and takes its newest content.
export function loadItems(db: Db, threadId: string): Item[] {
  const rows = db.select().from(events).where(eq(events.threadId, threadId)).orderBy(asc(events.seq)).all();
  const items = new Map<string, Item>();
  for (const row of rows) items.set(row.item.id, row.item);
  return [...items.values()];
}
