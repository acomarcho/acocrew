import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, test } from 'vite-plus/test';
import { contextUsed, createTranslator } from './translate.ts';

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

const system = (subtype: string, rest: object) => ({ type: 'system', subtype, ...rest }) as unknown as SDKMessage;

test('a tool card shows the command, then finishes as failed when the tool reports an error', () => {
  const { translate } = createTranslator();
  expect(translate(assistant([bash]))).toMatchObject([
    { save: true, item: { id: 'tool-1', kind: 'tool', name: 'Bash', detail: 'ls -la', done: false, failed: false } },
  ]);
  expect(translate(toolResult('tool-1', true))).toMatchObject([
    { save: true, item: { id: 'tool-1', done: true, failed: true, output: 'x' } },
  ]);
  expect(translate(toolResult('tool-1', true))).toEqual([]);
});

test('what a subagent does is filed under the card that started it', () => {
  const { translate } = createTranslator();
  expect(translate(assistant([{ type: 'text', text: 'inner' }, bash], 'tool-9'))).toMatchObject([
    { item: { kind: 'message', text: 'inner', parent: 'tool-9' } },
    { item: { kind: 'tool', id: 'tool-1', parent: 'tool-9' } },
  ]);
});

test('background work that fails or is stopped closes its card as failed', () => {
  const { translate } = createTranslator();
  translate(assistant([bash]));
  translate(system('task_started', { task_id: 'task-1', tool_use_id: 'tool-1', is_backgrounded: true }));
  expect(translate(toolResult('tool-1', false))).toMatchObject([{ item: { done: false, output: 'x' } }]);
  const over = system('task_notification', { task_id: 'task-1', status: 'stopped', summary: 'Stopped by Claude' });
  expect(translate(over)).toMatchObject([
    { item: { id: 'tool-1', done: true, failed: true, output: 'Stopped by Claude' } },
  ]);
});

test('work that is moved to the background later also keeps its card open', () => {
  const { translate } = createTranslator();
  translate(assistant([bash]));
  translate(system('task_started', { task_id: 'task-1', tool_use_id: 'tool-1', is_backgrounded: false }));
  translate(system('task_updated', { task_id: 'task-1', patch: { is_backgrounded: true } }));
  expect(translate(toolResult('tool-1', false))).toMatchObject([{ item: { done: false } }]);
});

test('a permission prompt that arrives before its tool card still ends up on that card', () => {
  const { translate, ask, answered } = createTranslator();
  expect(ask('tool-1', 'Bash', bash.input)).toMatchObject([
    { item: { id: 'tool-1', ask: 'pending', detail: 'ls -la' } },
  ]);
  expect(translate(assistant([bash]))).toMatchObject([{ item: { id: 'tool-1', ask: 'pending' } }]);
  expect(answered('tool-1', 'approved')).toMatchObject([{ item: { id: 'tool-1', ask: 'approved', done: false } }]);
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

test('a turn the user cut short ends with a plain note, not an error', () => {
  const { translate } = createTranslator();
  const result = {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'aborted_streaming',
    errors: ['[ede_diagnostic] x'],
  };
  expect(translate(result as unknown as SDKMessage)).toMatchObject([{ item: { kind: 'notice', text: 'Stopped.' } }]);
});

test('retries, usage limits, compaction and a signed-out machine each leave a plain note', () => {
  const { translate } = createTranslator();
  const text = (msg: unknown) =>
    translate(msg as SDKMessage).map(
      (out) => out.type === 'item' && 'text' in out.item && `${out.item.kind}: ${out.item.text}`,
    );
  expect(text(system('api_retry', { attempt: 2, max_retries: 10 }))).toEqual([
    "notice: Claude's servers did not answer. Trying again (attempt 2 of 10).",
  ]);
  const summarized = (compact_metadata: object) => text(system('compact_boundary', { compact_metadata }));
  expect(summarized({ pre_tokens: 181_300, post_tokens: 12_040 })).toEqual([
    'notice: Claude summarized the earlier conversation. Context went from 181K to 12K.',
  ]);
  // An older Claude does not say how big the conversation is afterwards.
  expect(summarized({ pre_tokens: 181_300 })).toEqual(['notice: Claude summarized the earlier conversation.']);
  expect(text({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791049200 } })[0]).toMatch(
    /^notice: The usage limit of this Claude account is reached. It resets at /,
  );
  expect(text({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })).toEqual([]);
  expect(text({ ...(assistant([]) as object), error: 'authentication_failed' })[0]).toMatch(
    /^error: Claude is signed out/,
  );
});

test('how full the conversation is comes from a finished call of the main agent, never from a subagent', () => {
  const usage = {
    input_tokens: 8,
    cache_creation_input_tokens: 320,
    cache_read_input_tokens: 17671,
    output_tokens: 123,
  };
  const call = (parent: string | null) =>
    ({
      type: 'stream_event',
      event: { type: 'message_delta', usage },
      parent_tool_use_id: parent,
    }) as unknown as SDKMessage;
  expect(contextUsed(call(null))).toBe(18122);
  expect(contextUsed(call('tool-9'))).toBeUndefined();
  // This one has the numbers too, but the count of what Claude wrote is not final in it.
  expect(contextUsed({ ...(assistant([]) as object), usage } as SDKMessage)).toBeUndefined();
});
