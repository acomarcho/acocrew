import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { loadItems, openDb, saveItem } from './db.ts';

const workDir = join(homedir(), 'acocrew-work');
mkdirSync(workDir, { recursive: true });

// A write must not wait for the disk to flush (issue #40): the server stalled for seconds behind every write
// while other programs kept the disk busy.
test('a database file keeps writes in a side log that is not flushed on every write, and keeps them', () => {
  const dir = mkdtempSync(join(workDir, 'test-db-'));
  const file = join(dir, 'acocrew.db');
  const db = openDb(file);
  expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.$client.pragma('synchronous', { simple: true })).toBe(1); // NORMAL

  db.$client.pragma('foreign_keys = OFF');
  const item = { id: 'a', type: 'text', role: 'assistant', text: 'hi' } as never;
  saveItem(db, 't1', item);
  expect(existsSync(`${file}-wal`)).toBe(true);
  expect(existsSync(`${file}-journal`)).toBe(false);

  db.$client.close();
  expect(loadItems(openDb(file), 't1')).toEqual([item]);
  rmSync(dir, { recursive: true });
});

test('existing threads stay on Claude with their original session ID after migration', () => {
  const legacy = new Database(':memory:');
  legacy.exec('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  const folder = new URL('../drizzle', import.meta.url).pathname;
  // The 14 migrations released before the agent column was added.
  for (const migration of readMigrationFiles({ migrationsFolder: folder }).slice(0, 14)) {
    for (const sql of migration.sql) legacy.exec(sql);
    legacy
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run(migration.hash, migration.folderMillis);
  }
  legacy.exec(`INSERT INTO channels (id, name, path, created_at) VALUES ('repo', 'Repo', '/old', 1);
    INSERT INTO threads (id, channel_id, title, model, effort, status, session_id, created_at, updated_at)
    VALUES ('old', 'repo', 'Old thread', 'gpt-example', 'high', 'done', 'old-session', 1, 1)`);
  const db = openDb(legacy.serialize());
  legacy.close();
  try {
    expect(db.$client.prepare('SELECT agent, session_id FROM threads WHERE id = ?').get('old')).toEqual({
      agent: 'claude',
      session_id: 'old-session',
    });
  } finally {
    db.$client.close();
  }
});
