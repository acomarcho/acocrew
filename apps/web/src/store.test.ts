import type { Channel } from '@acocrew/shared';
import { expect, test } from 'vite-plus/test';
import { reduce, START } from './store';

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
