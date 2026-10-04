// Database tables. After changing this file, run `pnpm db:generate` to create a migration.
import type { Access, Item, Status } from '@acocrew/shared';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The four tables below are Better Auth's own (see auth.ts). It reads and writes them by these names.
// `admin`, `mustChangePassword` and `deleted` are ours.
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  // The display name. Each person picks their own.
  name: text('name').notNull(),
  // Better Auth needs an email for every user. We never show or use it, so it is a made-up one.
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  // What the person logs in with. Empty once the account is deleted, so the name can be given out again.
  username: text('username').unique(),
  admin: integer('admin', { mode: 'boolean' }).notNull().default(false),
  // The password was set by someone else (the first admin's default, or an admin). It has to be changed
  // before the app can be used.
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(true),
  // A deleted account can no longer log in. The row stays, so what the person wrote keeps their name.
  deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
});

// Holds the password (hashed) of a user.
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  // Where it sits in the sidebar, counted from 0.
  position: integer('position').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

// A message that is sent in a fresh thread of a repository at set times. See automations.ts.
export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  channelId: text('channel_id')
    .notNull()
    .references(() => channels.id),
  text: text('text').notNull(),
  // 'HH:MM' on the server machine's clock, and the days of the week it runs on (0 is Monday).
  time: text('time').notNull(),
  days: text('days', { mode: 'json' }).$type<number[]>().notNull(),
  // The branch each run's new worktree starts from.
  from: text('from_branch').notNull(),
  on: integer('is_on', { mode: 'boolean' }).notNull().default(true),
  model: text('model').notNull(),
  effort: text('effort').notNull(),
  context: text('context').notNull(),
  fast: integer('fast', { mode: 'boolean' }).notNull(),
  access: text('access').$type<Access>().notNull(),
  // Who made it. Its threads are started as this person.
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id),
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
  context: text('context').notNull().default('1m'),
  fast: integer('fast', { mode: 'boolean' }).notNull().default(false),
  access: text('access').$type<Access>().notNull().default('full'),
  status: text('status').$type<Status>().notNull(),
  // The worktree this thread works in. Null when it works right in the repository folder.
  path: text('path'),
  // The branch that folder was on when Claude last finished a turn there. Null when it was on no branch.
  branch: text('branch'),
  // Claude's own id for the conversation. Lets a new Claude process pick up where the last one stopped.
  sessionId: text('session_id'),
  // Who started the thread.
  createdBy: text('created_by').references(() => user.id),
  // The automation that started it. Empty when a person did, and emptied when that automation is deleted.
  automationId: text('automation_id').references(() => automations.id, { onDelete: 'set null' }),
  // Everyone who sent a message in the thread, as user ids, in the order they first did.
  people: text('people', { mode: 'json' }).$type<string[]>().notNull().default([]),
  // When someone pinned it to the top of the thread list. Empty when it is not pinned.
  pinnedAt: integer('pinned_at'),
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

// Who has looked at which thread: the thread's `updatedAt` when the person last had it on screen.
export const seen = sqliteTable(
  'seen',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    at: integer('at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.threadId] })],
);
