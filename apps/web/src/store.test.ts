import type { Automation, Channel, ServerEvent, Status, Thread } from '@acocrew/shared';
import { expect, test } from 'vite-plus/test';
import { needsYou, pinnedOf, reduce, START } from './store';

const repo = (name: string): Channel => ({ id: name, name, path: `/home/me/${name}` });
const names = (state: typeof START) => state.channels.map((channel) => channel.name);

test('a new order moves the repositories, and one the order does not name stays last', () => {
  const state = { ...START, channels: ['shop', 'blog', 'journal'].map(repo) };
  expect(names(reduce(state, { type: 'order', ids: ['journal', 'shop', 'blog'] }))).toEqual([
    'journal',
    'shop',
    'blog',
  ]);
  // Someone dragged before this browser's new repository reached them.
  expect(names(reduce(state, { type: 'order', ids: ['blog', 'shop'] }))).toEqual(['blog', 'shop', 'journal']);
});

// A thread as the server sends it: last changed at 100, with `me` in it.
const thread = (status: Status, people = ['me']) => ({ id: 't', status, people, updatedAt: 100 }) as Thread;

test('a thread needs you when Claude waits for an answer, or stopped with something you have not seen', () => {
  const needs = (status: Status, seenAt?: number, people?: string[]) =>
    needsYou(thread(status, people), seenAt === undefined ? {} : { t: seenAt }, 'me');
  // Finished or failed: until you have seen it. Never opened counts as not seen.
  for (const stopped of ['done', 'failed'] as const) {
    expect(needs(stopped)).toBe(true);
    expect(needs(stopped, 99)).toBe(true);
    expect(needs(stopped, 100)).toBe(false);
  }
  // A question or an approval: until someone answers, seen or not.
  expect(needs('needs', 100)).toBe(true);
  // Still busy: nothing to look at yet.
  expect(needs('working')).toBe(false);
  expect(needs('waiting')).toBe(false);
  // A thread you never wrote in is someone else's to look at.
  expect(needs('done', undefined, ['teammate'])).toBe(false);
  expect(needs('needs', undefined, ['teammate'])).toBe(false);
});

test('a pin reaches the list though the thread is no newer, and pinned threads come out newest pin first', () => {
  const rows = [
    { ...thread('done'), id: 'a', pinnedAt: 5 },
    { ...thread('done'), id: 'b', pinnedAt: null },
    { ...thread('done'), id: 'c', pinnedAt: 9 },
  ];
  expect(pinnedOf(rows).map((t) => t.id)).toEqual(['c', 'a']);
  // Pinning leaves `updatedAt` as it is.
  let state = reduce({ ...START, threads: rows }, { type: 'thread', thread: { ...rows[1], pinnedAt: 12 } });
  expect(pinnedOf(state.threads).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  state = reduce(state, { type: 'thread', thread: { ...rows[2], pinnedAt: null } });
  expect(pinnedOf(state.threads).map((t) => t.id)).toEqual(['b', 'a']);
});

test('what was seen comes with the first message, and is added to as threads are looked at', () => {
  const hello: ServerEvent = {
    type: 'hello',
    channels: [],
    threads: [],
    people: [],
    seen: { a: 1, b: 2 },
    automations: [],
  };
  const state = reduce(reduce(START, hello), { type: 'seen', seen: { b: 5, c: 7 } });
  expect(state.seen).toEqual({ a: 1, b: 5, c: 7 });
  // A reconnect brings what the server has, which is what counts.
  expect(reduce(state, hello).seen).toEqual(hello.seen);
});

test('an automation is added, changed and taken away, and the threads it started stay without it', () => {
  const digest = { id: 'a', text: 'write a digest', on: true } as Automation;
  const started = { ...thread('done'), automationId: 'a' };
  const other = { ...thread('done'), id: 'u', automationId: 'b' };
  let state = reduce({ ...START, threads: [started, other] }, { type: 'automation', automation: digest });
  state = reduce(state, { type: 'automation', automation: { ...digest, on: false } });
  expect(state.automations).toEqual([{ ...digest, on: false }]);

  state = reduce(state, { type: 'automation-gone', id: 'a' });
  expect(state.automations).toEqual([]);
  expect(state.threads.map((t) => t.automationId)).toEqual([null, 'b']);
});
