import type { Item, Question, Todo } from '@acocrew/shared';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

type Message = Extract<Item, { kind: 'message' }>;
type Tool = Extract<Item, { kind: 'tool' }>;

// `save: false` is a bubble Claude is still writing: shown live, not stored.
export type Out = { type: 'item'; item: Item; save: boolean } | { type: 'delta'; itemId: string; text: string };

// Items are shown in `at` order, so no two may share a time. This clock never repeats and never goes back.
let last = 0;
export const nextAt = () => (last = Math.max(Date.now(), last + 1));

// The most text we keep of one tool's input or output.
const MAX_TEXT = 20_000;

const saved = (item: Item): Out => ({ type: 'item', item, save: true });

// Shown next to the tool name: the command for Bash, the file for Read, and so on.
function detailOf(input: unknown) {
  const first = Object.values(input ?? {}).find((value) => typeof value === 'string');
  return (first ?? '').slice(0, 300);
}

// A tool result is either plain text or a list of blocks. Only the text blocks are kept.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, MAX_TEXT);
  if (!Array.isArray(content)) return '';
  const texts = content.map((block) => (block?.type === 'text' ? String(block.text) : ''));
  return texts.join('\n').slice(0, MAX_TEXT);
}

// True for a turn that ended because someone stopped it, not because something broke.
export const wasAborted = (msg: SDKMessage) =>
  msg.type === 'result' && (msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools');

// Turns raw Claude messages into our own items. One translator per Claude process.
// `todos` is the to-do list as it was last saved, so updates after a restart still land on it.
export function createTranslator(todos: Todo[] = []) {
  // Bubbles being written right now, one per speaker: the main agent ('') and each subagent (its card's id).
  const live = new Map<string, Message>();
  const openTools = new Map<string, Tool>();
  // Work that Claude started through a tool and that keeps running on its own: task id -> who started it.
  const tasks = new Map<string, { toolId?: string; background: boolean }>();

  function newTool(id: string, name: string, input: unknown, parent?: string): Tool {
    const text = JSON.stringify(input, null, 2).slice(0, MAX_TEXT);
    const at = nextAt();
    return {
      id,
      kind: 'tool',
      name,
      detail: detailOf(input),
      input: text,
      output: '',
      done: false,
      failed: false,
      at,
      parent,
    };
  }

  function update(tool: Tool, patch: Partial<Tool>): Out[] {
    const next = { ...tool, ...patch };
    if (next.done) openTools.delete(tool.id);
    else openTools.set(tool.id, next);
    return [saved(next.done ? { ...next, endAt: nextAt() } : next)];
  }

  const inBackground = (toolId: string) =>
    [...tasks.values()].some((task) => task.toolId === toolId && task.background);

  function translate(msg: SDKMessage): Out[] {
    const parent = ('parent_tool_use_id' in msg && msg.parent_tool_use_id) || undefined;
    const speaker = parent ?? '';

    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event.type === 'content_block_start' && event.content_block.type === 'text') {
        const bubble: Message = { id: randomUUID(), kind: 'message', by: 'claude', text: '', at: nextAt(), parent };
        live.set(speaker, bubble);
        return [{ type: 'item', item: bubble, save: false }];
      }
      const bubble = live.get(speaker);
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && bubble) {
        live.set(speaker, { ...bubble, text: bubble.text + event.delta.text });
        return [{ type: 'delta', itemId: bubble.id, text: event.delta.text }];
      }
      return [];
    }

    // Claude sends one `assistant` message per finished block.
    if (msg.type === 'assistant') {
      if (msg.error === 'authentication_failed') {
        const text = 'Claude is signed out on the server machine. Run `claude` there and sign in again.';
        return [saved({ id: randomUUID(), kind: 'error', text, at: nextAt(), parent })];
      }
      return msg.message.content.flatMap((block): Out[] => {
        if (block.type === 'text') {
          const base: Message = live.get(speaker) ?? {
            id: randomUUID(),
            kind: 'message',
            by: 'claude',
            text: '',
            at: nextAt(),
            parent,
          };
          live.delete(speaker);
          return [saved({ ...base, text: block.text })];
        }
        if (block.type === 'tool_use') {
          // The permission prompt for this tool can arrive before this message. Keep what it set.
          const asked = openTools.get(block.id);
          return update(newTool(block.id, block.name, block.input, parent), {
            ask: asked?.ask,
            questions: asked?.questions,
          });
        }
        return [];
      });
    }

    // Tool results come back as `user` messages.
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      const outs = msg.message.content.flatMap((block): Out[] => {
        const tool = block.type === 'tool_result' && openTools.get(block.tool_use_id);
        if (!tool) return [];
        const output = tool.output || textOf(block.content);
        // A tool that only launched background work is not done yet. Its card stays open until the work ends.
        if (inBackground(tool.id)) return update(tool, { output });
        return update(tool, { output, done: true, failed: block.is_error === true });
      });
      return parent ? outs : [...outs, ...todoUpdate(msg.tool_use_result)];
    }

    if (msg.type === 'system' && msg.subtype === 'task_started') {
      tasks.set(msg.task_id, { toolId: msg.tool_use_id, background: msg.is_backgrounded === true });
      return [];
    }
    if (msg.type === 'system' && msg.subtype === 'task_updated') {
      const task = tasks.get(msg.task_id);
      if (task && msg.patch.is_backgrounded !== undefined) task.background = msg.patch.is_backgrounded;
      return [];
    }
    if (msg.type === 'system' && msg.subtype === 'task_notification') {
      const task = tasks.get(msg.task_id);
      tasks.delete(msg.task_id);
      const tool = task?.toolId ? openTools.get(task.toolId) : undefined;
      if (!tool) return [];
      // The summary is the task's result in plain words, so it is what the card shows as its output.
      const output = msg.summary || tool.output;
      // Work that ran in the background is over now. Otherwise the tool's own result is still to come.
      return update(tool, task?.background ? { output, done: true, failed: msg.status !== 'completed' } : { output });
    }

    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      return [notice('The conversation got long, so Claude summarized the earlier part to keep going.')];
    }
    if (msg.type === 'system' && msg.subtype === 'api_retry') {
      return [notice(`Claude's servers did not answer. Trying again (attempt ${msg.attempt} of ${msg.max_retries}).`)];
    }
    if (msg.type === 'rate_limit_event' && msg.rate_limit_info.status === 'rejected') {
      const resets = msg.rate_limit_info.resetsAt;
      const when = resets ? ` It resets at ${new Date(resets * 1000).toLocaleString()}.` : '';
      return [notice(`The usage limit of this Claude account is reached.${when}`)];
    }

    // A turn the user cut short (Cancel on a prompt) is not a failure.
    if (msg.type === 'result' && wasAborted(msg)) return [notice('Stopped.')];
    if (msg.type === 'result' && msg.is_error) {
      const text = msg.subtype === 'success' ? msg.result : msg.errors.join('\n');
      return [saved({ id: randomUUID(), kind: 'error', text, at: nextAt() })];
    }

    return [];
  }

  const notice = (text: string) => saved({ id: randomUUID(), kind: 'notice', text, at: nextAt() });

  // Claude keeps a to-do list through tools. Their structured results say what was added or changed.
  function todoUpdate(result: unknown): Out[] {
    const { task, taskId, statusChange } = (result ?? {}) as Record<string, any>;
    if (task?.id && task.subject) todos = [...todos, { id: task.id, subject: task.subject, status: 'pending' }];
    else if (taskId && statusChange?.to)
      todos = todos.map((t) => (t.id === taskId ? { ...t, status: statusChange.to } : t));
    else return [];
    return [saved({ id: 'todos', kind: 'todos', todos, at: nextAt() })];
  }

  // Claude wants to run a tool and needs a yes first, or asks the user a question.
  function ask(id: string, name: string, input: Record<string, unknown>): Out[] {
    const questions = name === 'AskUserQuestion' ? (input.questions as Question[]) : undefined;
    return update(openTools.get(id) ?? newTool(id, name, input), { ask: 'pending', questions });
  }

  function answered(id: string, result: 'approved' | 'declined'): Out[] {
    const tool = openTools.get(id);
    return tool ? update(tool, { ask: result }) : [];
  }

  return { translate, ask, answered, live: () => [...live.values()] };
}
