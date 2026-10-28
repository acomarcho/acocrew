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
