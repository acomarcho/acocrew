import type { Model, Thread } from '@acocrew/shared';
import { expect, test } from 'vite-plus/test';
import { agentName, codexMessage, nearestEffort, NEW_THREAD, newThreadSettings, sends } from './ui';

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

const CODEX: Model = {
  id: 'gpt-5.5',
  name: 'gpt-5.5',
  hint: 'Through Codex',
  bigContext: false,
  fast: false,
  efforts: ['low', 'medium', 'high', 'xhigh'],
  window: null,
};

test('new Codex threads use the configured model, separate settings and text-only wire values', () => {
  const draft = {
    text: 'hello',
    images: ['cat.png'],
    files: ['notes.txt'],
    settings: { fast: true, model: 'proxy-gpt', effort: 'max' },
  };
  const codex = { ...draft, agent: 'codex' as const };
  expect(newThreadSettings(draft, CODEX)).toEqual({ ...NEW_THREAD, ...draft.settings });
  expect(newThreadSettings(codex, CODEX)).toEqual({
    model: CODEX.id,
    effort: 'medium',
    access: 'ask',
    context: '200k',
    fast: false,
  });
  const picked = newThreadSettings({ ...codex, codexSettings: { access: 'full', effort: 'high' } }, CODEX);
  expect(codexMessage(codex.text, picked)).toEqual({
    text: 'hello',
    images: [],
    files: [],
    model: CODEX.id,
    effort: 'high',
    access: 'full',
    context: '200k',
    fast: false,
  });
});

test('Codex replies keep the thread settings and do not send a runtime switch', () => {
  const thread = {
    agent: 'codex' as const,
    model: 'retired-model',
    effort: 'xhigh',
    access: 'ask' as const,
    context: '1m',
    fast: true,
  };
  expect(codexMessage('carry on', thread)).toEqual({
    text: 'carry on',
    images: [],
    files: [],
    model: 'retired-model',
    effort: 'xhigh',
    access: 'ask',
    context: '200k',
    fast: false,
  });
  const label = (thread: Pick<Thread, 'agent' | 'model'>) => agentName(thread.agent);
  expect(label(thread)).toBe('Codex');
  expect(label({ ...thread, agent: 'claude' })).toBe('Claude');
});
