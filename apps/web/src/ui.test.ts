import { expect, test } from 'vite-plus/test';
import { nearestEffort, sends } from './ui';

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

// The levels some real OpenCode Go models have, as the model proxy lists them.
const DEEPSEEK_PRO = ['high', 'max'];
const KIMI_K3 = ['max'];
const QWEN_MAX = ['low', 'medium', 'xhigh'];

test('switching models keeps the level when the new model has it, and otherwise takes the closest one', () => {
  expect(nearestEffort(DEEPSEEK_PRO, 'max')).toBe('max');
  expect(nearestEffort(DEEPSEEK_PRO, 'low')).toBe('high');
  expect(nearestEffort(DEEPSEEK_PRO, 'medium')).toBe('high');
  expect(nearestEffort(KIMI_K3, 'low')).toBe('max');
  // Between medium and xhigh, high is as far from both. The higher one wins, as in the proxy.
  expect(nearestEffort(QWEN_MAX, 'high')).toBe('xhigh');
  expect(nearestEffort(QWEN_MAX, 'max')).toBe('xhigh');
});

test('a model whose thinking cannot be set keeps whatever level was picked', () => {
  expect(nearestEffort([], 'medium')).toBe('medium');
});
