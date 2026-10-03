// Database tables. After changing this file, run `pnpm db:generate` to create a migration.
import type { Item, Status } from '@acocrew/shared';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  createdAt: integer('created_at').notNull(),
});

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  channelId: text('channel_id')
    .notNull()
    .references(() => channels.id),
  title: text('title').notNull(),
  model: text('model').notNull(),
  effort: text('effort').notNull(),
  status: text('status').$type<Status>().notNull(),
  // Claude's own id for the conversation. Lets a new Claude process pick up where the last one stopped.
  sessionId: text('session_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Append-only log. A tool card shows up twice (started, finished); the newest row per item id wins.
export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    item: text('item', { mode: 'json' }).$type<Item>().notNull(),
  },
  (t) => [index('events_thread').on(t.threadId, t.seq)],
);
