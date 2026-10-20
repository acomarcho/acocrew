import { expect, test } from 'vite-plus/test';
import { sends } from './ui';

// A key press in a message box, as the browser reports it.
const press = (key: string, held: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...held,
});

test('Enter and Shift+Enter start a new line, so a phone keyboard never sends by itself', () => {
  expect(sends(press('Enter'))).toBe(false);
  expect(sends(press('Enter', { shiftKey: true }))).toBe(false);
});

test('Cmd+Enter on a Mac and Ctrl+Enter elsewhere send', () => {
  expect(sends(press('Enter', { metaKey: true }))).toBe(true);
  expect(sends(press('Enter', { ctrlKey: true }))).toBe(true);
});

test('other keys never send, held keys or not', () => {
  for (const key of ['a', 'Tab', 'Escape', ' ']) {
    expect(sends(press(key)), key).toBe(false);
    expect(sends(press(key, { metaKey: true, ctrlKey: true })), key).toBe(false);
  }
});
