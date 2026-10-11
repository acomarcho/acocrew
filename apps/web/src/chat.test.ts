import type { Chat, Item, Person, Thread } from '@acocrew/shared';
import { tagsIn } from '@acocrew/shared';
import { expect, test } from 'vite-plus/test';
import { peopleOf, suggestPeople, timeline } from './chat';

const person = (name: string, username: string | null = name.toLowerCase()): Person => ({
  id: username ?? name,
  name,
  username,
  admin: false,
  deleted: username === null,
});
// A team as the server lists it. Sam's account is gone, and Jordan's username is not their display name.
const TEAM = [person('Ann'), person('Jordan', 'jordan.lee'), person('Joan'), person('Bo'), person('Sam', null)];

// Who is suggested when `text` has been typed and the caret is at its end, or where `|` is.
const typed = (text: string, list = TEAM.slice(0, 4)) => {
  const caret = text.includes('|') ? text.indexOf('|') : text.length;
  const found = suggestPeople(list, text.replace('|', ''), caret);
  return found && { start: found.start, names: found.items.map((one) => one.name) };
};

test('an @ suggests the people of the thread, and typing narrows them by display name or username', () => {
  expect(typed('@')).toEqual({ start: 0, names: ['Ann', 'Jordan', 'Joan', 'Bo'] });
  expect(typed('can you look @jo')).toEqual({ start: 13, names: ['Jordan', 'Joan'] });
  // A name that starts with what was typed comes before one that only contains it.
  expect(typed('@an')?.names).toEqual(['Ann', 'Jordan', 'Joan']);
  expect(typed('@LEE')?.names).toEqual(['Jordan']);
  expect(typed('line one\n@b')).toEqual({ start: 9, names: ['Bo'] });
});

test('only the name the caret is in counts, and an email address or a name nobody has suggests nobody', () => {
  expect(typed('hey @jo| what now')).toEqual({ start: 4, names: ['Jordan', 'Joan'] });
  for (const text of ['@ann |', '|@ann', 'mail ann@example.com', 'a@', '@nobody', 'no at sign', ''])
    expect(typed(text), text).toBeNull();
  expect(typed('@', [])).toBeNull();
});

test('only people who see the thread, and still have an account, are offered', () => {
  const thread = (visibility: string, shared: string[] = []) => ({ visibility, createdBy: 'ann', shared }) as Thread;
  const names = (of: Thread) => peopleOf(of, TEAM).map((one) => one.name);
  expect(names(thread('private'))).toEqual(['Ann']);
  expect(names(thread('private', ['bo', 'Sam']))).toEqual(['Ann', 'Bo']);
  expect(names(thread('public'))).toEqual(['Ann', 'Jordan', 'Joan', 'Bo']);
});

test('the usernames a message tags: at the start of a word, in small letters, without the full stop after', () => {
  expect(tagsIn('@Ann can you ask @jordan.lee. Or (@bo)? Mail joan@example.com, @_x_!')).toEqual([
    'ann',
    'jordan.lee',
    '_x_',
  ]);
  expect(tagsIn('nobody here @ all')).toEqual([]);
});

test('the timeline puts what people wrote to each other between what Claude did, by time, and can leave either out', () => {
  const item = (id: string, at: number) => ({ id, at, kind: 'message', by: 'claude', text: id }) as Item;
  const chat = (id: number, at: number): Chat => ({ id, at, userId: 'ann', text: `#${id}`, tagged: [] });
  const items = [item('a', 10), item('b', 30), item('c', 50)];
  const chats = [chat(1, 20), chat(2, 40), chat(3, 60)];
  const ids = (show: Parameters<typeof timeline>[2]) => timeline(items, chats, show).map((row) => row.id);
  expect(ids('all')).toEqual(['a', 1, 'b', 2, 'c', 3]);
  expect(ids('claude')).toEqual(['a', 'b', 'c']);
  expect(ids('people')).toEqual([1, 2, 3]);
  expect(timeline(items, chats, 'all')[1]).toEqual({ kind: 'chat', ...chats[0] });
  expect(timeline(items, [], 'all')).toEqual(items);
});
