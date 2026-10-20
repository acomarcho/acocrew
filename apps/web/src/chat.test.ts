import type { Chat, Item, Person, Thread } from '@acocrew/shared';
import { tagsIn } from '@acocrew/shared';
import { expect, test } from 'vite-plus/test';
import { byDay, dayLabel, peopleOf, suggestPeople, timeline } from './chat';

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

// A moment on this machine's clock. Months count from 0, like `Date`.
const on = (month: number, day: number, hours = 12, minutes = 0, year = 2026) =>
  new Date(year, month, day, hours, minutes).getTime();
const OCT = 9;

test("the timeline is cut where the day changes on this machine's clock, not every 24 hours", () => {
  const row = (id: string, at: number) => ({ id, at });
  const rows = [
    row('a', on(OCT, 16, 0, 0)),
    row('b', on(OCT, 16, 23, 59)),
    row('c', on(OCT, 17, 0, 1)),
    row('d', on(OCT, 20, 9)),
    row('e', on(OCT, 20, 21)),
  ];
  expect(byDay(rows).map((day) => day.map((one) => one.id))).toEqual([['a', 'b'], ['c'], ['d', 'e']]);
  expect(byDay([])).toEqual([]);
});

test('a day is called Today, Yesterday, or its date, with the year only when it is not this year', () => {
  // How this machine writes a date, so the test does not hang on its language.
  const date = (at: number, year?: 'numeric') =>
    new Date(at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year });
  const now = on(OCT, 20, 15);
  expect(dayLabel(on(OCT, 20, 0, 0), now)).toBe('Today');
  expect(dayLabel(on(OCT, 20, 23, 59), now)).toBe('Today');
  expect(dayLabel(on(OCT, 19, 23, 59), now)).toBe('Yesterday');
  expect(dayLabel(on(OCT, 19, 0, 0), now)).toBe('Yesterday');
  expect(dayLabel(on(OCT, 16), now)).toBe(date(on(OCT, 16)));
  expect(dayLabel(on(OCT, 16), now)).not.toMatch(/2026/);
  expect(dayLabel(on(11, 31, 12, 0, 2025), now)).toBe(date(on(11, 31, 12, 0, 2025), 'numeric'));
  // Just after New Year, last night is still Yesterday, and a day last year has its year.
  const newYear = on(0, 1, 9, 0, 2027);
  expect(dayLabel(on(11, 31, 22, 0, 2026), newYear)).toBe('Yesterday');
  expect(dayLabel(on(11, 30, 22, 0, 2026), newYear)).toMatch(/2026/);
  // Yesterday is the day before on the calendar, also across the end of a month.
  expect(dayLabel(on(OCT, 31, 8), on(10, 1, 8))).toBe('Yesterday');
});
