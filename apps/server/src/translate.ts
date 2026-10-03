import type { Item } from '@acocrew/shared';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

type Message = Extract<Item, { kind: 'message' }>;
type Tool = Extract<Item, { kind: 'tool' }>;

// `save: false` is a bubble Claude is still writing: shown live, not stored.
export type Out = { type: 'item'; item: Item; save: boolean } | { type: 'delta'; itemId: string; text: string };

// Items are shown in `at` order, so no two may share a time. This clock never repeats and never goes back.
let last = 0;
export const nextAt = () => (last = Math.max(Date.now(), last + 1));

// Shown next to the tool name: the command for Bash, the file for Read, and so on.
function detailOf(input: unknown) {
  const first = Object.values(input ?? {}).find((value) => typeof value === 'string');
  return (first ?? '').slice(0, 300);
}

// Turns raw Claude messages into our own items. One translator per Claude process.
export function createTranslator() {
  let live: Message | null = null;
  const openTools = new Map<string, Tool>();

  function translate(msg: SDKMessage): Out[] {
    // Messages from subagents are not shown yet.
    if ('parent_tool_use_id' in msg && msg.parent_tool_use_id) return [];

    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event.type === 'content_block_start' && event.content_block.type === 'text') {
        live = { id: randomUUID(), kind: 'message', by: 'claude', text: '', at: nextAt() };
        return [{ type: 'item', item: live, save: false }];
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && live) {
        live = { ...live, text: live.text + event.delta.text };
        return [{ type: 'delta', itemId: live.id, text: event.delta.text }];
      }
      return [];
    }

    // Claude sends one `assistant` message per finished block.
    if (msg.type === 'assistant') {
      return msg.message.content.flatMap((block): Out[] => {
        if (block.type === 'text') {
          const base: Message = live ?? { id: randomUUID(), kind: 'message', by: 'claude', text: '', at: nextAt() };
          live = null;
          return [{ type: 'item', item: { ...base, text: block.text }, save: true }];
        }
        if (block.type === 'tool_use') {
          const tool: Tool = {
            id: block.id,
            kind: 'tool',
            name: block.name,
            detail: detailOf(block.input),
            done: false,
            failed: false,
            at: nextAt(),
          };
          openTools.set(tool.id, tool);
          return [{ type: 'item', item: tool, save: true }];
        }
        return [];
      });
    }

    // Tool results come back as `user` messages.
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      return msg.message.content.flatMap((block): Out[] => {
        const tool = block.type === 'tool_result' && openTools.get(block.tool_use_id);
        if (!tool) return [];
        openTools.delete(tool.id);
        return [{ type: 'item', item: { ...tool, done: true, failed: block.is_error === true }, save: true }];
      });
    }

    if (msg.type === 'result' && msg.is_error) {
      const text = msg.subtype === 'success' ? msg.result : msg.errors.join('\n');
      return [{ type: 'item', item: { id: randomUUID(), kind: 'error', text, at: nextAt() }, save: true }];
    }

    return [];
  }

  return { translate, live: () => live };
}
