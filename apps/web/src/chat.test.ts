import type { Chat, Item, Person, Thread } from '@acocrew/shared';
import { tagsIn } from '@acocrew/shared';
import { expect, test } from 'vite-plus/test';
import { byDay, dayLabel, follows, peopleOf, suggestPeople, timeline } from './chat';

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

// A thread's scroll box the way ThreadView drives it: new text makes the page taller and, while following,
// jumps to the bottom (remembering where it landed). The reader's scrolls come in as scroll events.
function scrollBox(height = 120_000, view = 560) {
  const box = { height, top: height - view, lastTop: height - view, stick: true };
  const fromBottom = () => box.height - box.top - view;
  // A scroll event at the box's current position.
  const scrolled = () => {
    box.stick = follows(box.stick, box.top, box.lastTop, fromBottom());
    box.lastTop = box.top;
  };
  return {
    box,
    fromBottom,
    // Claude wrote `px` more. Like the effect in ThreadView, a jump happens only while following.
    grow(px: number) {
      box.height += px;
      if (!box.stick) return;
      box.top = box.height - view;
      box.lastTop = box.top;
    },
    // The browser reports the jump a moment later, sometimes after the reader already moved.
    jumpEventArrives: scrolled,
    scroll(dy: number) {
      box.top = Math.max(0, Math.min(box.top + dy, box.height - view));
      scrolled();
    },
    // The page got shorter (a card closed) and the browser pulled the view up with it.
    shrink(px: number) {
      box.height -= px;
      box.top = Math.min(box.top, box.height - view);
      scrolled();
    },
  };
}

test('a thread follows what Claude writes while the reader stays at the bottom', () => {
  const page = scrollBox();
  for (let i = 0; i < 50; i++) {
    page.grow(24);
    page.jumpEventArrives();
  }
  expect(page.box.stick).toBe(true);
  expect(page.fromBottom()).toBe(0);
});

test('any scroll up stops following, even a few pixels from a trackpad, and new text then leaves the view alone', () => {
  for (const steps of [[-8], [-8, -8, -8], [-40], [-100, -100, -100]]) {
    const page = scrollBox();
    for (const dy of steps) page.scroll(dy);
    const top = page.box.top;
    for (let i = 0; i < 50; i++) page.grow(24);
    expect(page.box.stick, String(steps)).toBe(false);
    expect(page.box.top, String(steps)).toBe(top);
  }
});

test("the scroll event of our own jump does not undo the reader's scroll up", () => {
  const page = scrollBox();
  page.grow(24);
  // The reader turns the wheel up before the jump's scroll event comes in. The wheel stops following right
  // away (ThreadView's onWheel), and the late event must not start it again.
  page.box.stick = false;
  page.jumpEventArrives();
  page.scroll(-40);
  page.grow(500);
  expect(page.box.stick).toBe(false);
});

test('coming back down near the bottom follows again, though the bottom keeps moving away', () => {
  const page = scrollBox();
  page.scroll(-2000);
  page.grow(300);
  // Each notch down lands short of a bottom that grew in the meantime.
  for (let i = 0; i < 6; i++) {
    page.scroll(400);
    page.grow(30);
  }
  expect(page.box.stick).toBe(true);
  expect(page.fromBottom()).toBe(0);
});

test('scrolling down far from the bottom does not follow yet', () => {
  const page = scrollBox();
  page.scroll(-3000);
  page.scroll(1000);
  expect(page.box.stick).toBe(false);
});

test('the page getting shorter at the bottom does not count as the reader scrolling up', () => {
  const page = scrollBox();
  page.shrink(200);
  expect(page.box.stick).toBe(true);
  page.grow(100);
  expect(page.fromBottom()).toBe(0);
});
