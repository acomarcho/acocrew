import type { Item, Seen, Thread, Unread, Visibility } from '@acocrew/shared';
import Database from 'better-sqlite3';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { automations, channels, chats, events, seen, threads } from './schema.ts';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

// Opens the database file (or ':memory:', or a copy of a database held in memory) and applies any migrations
// that have not run yet.
export function openDb(file: string | Buffer) {
  if (typeof file === 'string' && file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  // Every query blocks the server (better-sqlite3 is synchronous), so a write must not wait for the disk to
  // flush. With WAL, commits are appended to a side file and flushed only at checkpoints, and NORMAL is still
  // crash-safe there: a power cut can lose the last few commits but never corrupts the file. A database held
  // in memory stays in its own 'memory' mode.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
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
  contextUsed: threads.contextUsed,
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

export const chatCols = { id: chats.id, at: chats.at, userId: chats.userId, text: chats.text, tagged: chats.tagged };
export const loadChats = (db: Db, threadId: string) =>
  db.select(chatCols).from(chats).where(eq(chats.threadId, threadId)).orderBy(asc(chats.id)).all();

// The id of the last chat message of a thread that this person had on screen. 0 when none.
export const chatSeen = (db: Db, userId: string, threadId: string) =>
  db
    .select({ chat: seen.chat })
    .from(seen)
    .where(and(eq(seen.userId, userId), eq(seen.threadId, threadId)))
    .get()?.chat ?? 0;

// The one rule for which chat messages are new to a person: it came after the last one they had on screen
// (their own are on screen as they write them), and they take part in the thread or it tags them. Counted per
// thread, for every thread or for one. A thread with nothing new is not in the answer.
export function listUnread(db: Db, userId: string, threadId?: string): Record<string, Unread> {
  const has = (list: unknown) => sql`exists (select 1 from json_each(${list}) where value = ${userId})`;
  const rows = db.all<{ threadId: string; count: number; tagged: number }>(sql`
    select ${chats.threadId} as threadId, count(*) as count, max(${has(chats.tagged)}) as tagged
    from ${chats}
    join ${threads} on ${threads.id} = ${chats.threadId}
    left join ${seen} on ${seen.threadId} = ${chats.threadId} and ${seen.userId} = ${userId}
    where ${chats.id} > coalesce(${seen.chat}, 0)
      and (${has(threads.people)} or ${has(chats.tagged)})
      and ${threadId ? eq(chats.threadId, threadId) : sql`true`}
    group by ${chats.threadId}`);
  return Object.fromEntries(rows.map((row) => [row.threadId, { count: row.count, tagged: Boolean(row.tagged) }]));
}
