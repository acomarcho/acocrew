import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, test } from 'vite-plus/test';
import { createTranslator } from './translate.ts';

// Hand-made messages in the same shape as the recorded ones, for cases the recording does not have.
const assistant = (content: unknown[], parent: string | null = null) =>
  ({ type: 'assistant', message: { content }, parent_tool_use_id: parent }) as unknown as SDKMessage;
const toolResult = (id: string, isError: boolean) =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage;
const bash = { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls -la', description: 'List files' } };

test('a tool card shows the command, then finishes as failed when the tool reports an error', () => {
  const { translate } = createTranslator();
  expect(translate(assistant([bash]))).toMatchObject([
    { save: true, item: { id: 'tool-1', kind: 'tool', name: 'Bash', detail: 'ls -la', done: false, failed: false } },
  ]);
  expect(translate(toolResult('tool-1', true))).toMatchObject([
    { save: true, item: { id: 'tool-1', done: true, failed: true } },
  ]);
  expect(translate(toolResult('tool-1', true))).toEqual([]);
});

test('messages from subagents are skipped', () => {
  const { translate } = createTranslator();
  expect(translate(assistant([{ type: 'text', text: 'inner' }, bash], 'tool-9'))).toEqual([]);
});

test('thinking is skipped and a plain user message is ignored', () => {
  const { translate } = createTranslator();
  expect(translate(assistant([{ type: 'thinking', thinking: '' }]))).toEqual([]);
  const plain = { type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null } as SDKMessage;
  expect(translate(plain)).toEqual([]);
});

test('a turn that ends in an error becomes an error item', () => {
  const { translate } = createTranslator();
  const result = { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Too many steps'] };
  expect(translate(result as unknown as SDKMessage)).toMatchObject([
    { save: true, item: { kind: 'error', text: 'Too many steps' } },
  ]);
});
