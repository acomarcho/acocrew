import type { Command } from '@acocrew/shared';
import { expect, test } from 'vite-plus/test';
import { suggest } from './commands';

// The names a real Claude gave for a repository with skills of its own, as the server passes them on.
const some = (skill: boolean, names: string[]): Command[] =>
  names.map((name) => ({ name, description: '', hint: '', skill }));
const LIST = [
  ...some(true, ['release-notes', 'concise-mode', 'broken', 'ship', 'figma:figma-use']),
  ...some(false, ['code-review', 'simplify', 'compact', 'context', 'usage', 'init']),
];

// What is suggested when `text` has been typed and the caret is at its end, or where `|` is.
const typed = (text: string) => {
  const caret = text.includes('|') ? text.indexOf('|') : text.length;
  const found = suggest(LIST, text.replace('|', ''), caret);
  return found && { start: found.start, names: found.items.map((c) => c.name) };
};

test('a slash that starts the message suggests every command, then every skill', () => {
  expect(typed('/')).toEqual({
    start: 0,
    names: [
      ...['code-review', 'simplify', 'compact', 'context', 'usage', 'init'],
      ...['release-notes', 'concise-mode', 'broken', 'ship', 'figma:figma-use'],
    ],
  });
  // Blank space in front does not count: it is cut off when the message is sent.
  expect(typed('  \n/')?.names).toHaveLength(11);
});

test('a slash later in the message suggests skills only', () => {
  expect(typed('make it short /')).toEqual({
    start: 14,
    names: ['release-notes', 'concise-mode', 'broken', 'ship', 'figma:figma-use'],
  });
  expect(typed('first line\n/comp')).toBeNull();
});

test('typing narrows the list: names that start with it first, then names that contain it', () => {
  expect(typed('/co')?.names).toEqual(['code-review', 'compact', 'context', 'concise-mode']);
  expect(typed('/s')?.names).toEqual(['simplify', 'usage', 'ship', 'release-notes', 'concise-mode', 'figma:figma-use']);
  expect(typed('/FIGMA:')?.names).toEqual(['figma:figma-use']);
  expect(typed('use /con')?.names).toEqual(['concise-mode']);
});

test('only the name the caret is in counts', () => {
  expect(typed('/comp| and then more')).toEqual({ start: 0, names: ['compact'] });
  expect(typed('do /ship| it')).toEqual({ start: 3, names: ['ship'] });
  // The caret has left the name.
  expect(typed('/compact |')).toBeNull();
  expect(typed('|/compact')).toBeNull();
});

test('nothing is suggested for a path, a link, a fraction or a name nobody has', () => {
  for (const text of [
    'look at src/',
    'see https://example.com/s',
    'half is 1/2',
    'open /usr/bin',
    // Later in a message a slash is often part of the words, so there a name has to start with what was typed.
    'the /notes folder',
    '/nothing-like-it',
    '',
  ])
    expect(typed(text), text).toBeNull();
});
