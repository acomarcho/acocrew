import type { Item, NewMessage, Thread } from '@acocrew/shared';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { loadItems, saveItem, threadCols, type Db } from './db.ts';
import type { Hub } from './hub.ts';
import { channels, threads } from './schema.ts';
import { createTranslator, nextAt } from './translate.ts';

// The part of the Claude Agent SDK we use. Tests pass a fake with the same shape.
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close(): void };

type Session = {
  input: ReturnType<typeof queue<SDKUserMessage>>;
  messages: AsyncIterator<SDKMessage>;
  close: () => void;
  model: string;
  effort: string;
  translator: ReturnType<typeof createTranslator>;
  idle?: NodeJS.Timeout;
};

// A Claude process nobody has talked to for this long is closed. The next message starts a new one.
const IDLE_MS = 10 * 60_000;

// A list you can keep adding to while someone else is reading from it.
function queue<T>() {
  const items: T[] = [];
  let closed = false;
  let wake = () => {};
  return {
    push(item: T) {
      items.push(item);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        while (items.length) yield items.shift()!;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

// Runs Claude for threads: one process per thread, one message at a time.
export function createRunner(db: Db, hub: Hub, query: QueryFn) {
  const sessions = new Map<string, Session>();
  const turns = new Map<string, Promise<void>>();

  function addItem(threadId: string, item: Item) {
    saveItem(db, threadId, item);
    hub.toThread(threadId, { type: 'item', threadId, item });
  }

  // A turn that ended badly: tools still running are marked failed, and the reason is shown.
  function cutShort(threadId: string, reason: string) {
    for (const item of loadItems(db, threadId)) {
      if (item.kind === 'tool' && !item.done) addItem(threadId, { ...item, done: true, failed: true });
    }
    addItem(threadId, { id: randomUUID(), kind: 'error', text: reason, at: nextAt() });
  }

  function setThread(threadId: string, patch: Partial<Thread>) {
    const set = { ...patch, updatedAt: Date.now() };
    const thread = db.update(threads).set(set).where(eq(threads.id, threadId)).returning(threadCols).get();
    hub.toAll({ type: 'thread', thread });
  }

  function start(threadId: string, model: string, effort: string): Session {
    const { cwd, sessionId } = db
      .select({ cwd: channels.path, sessionId: threads.sessionId })
      .from(threads)
      .innerJoin(channels, eq(channels.id, threads.channelId))
      .where(eq(threads.id, threadId))
      .get()!;
    const input = queue<SDKUserMessage>();
    const running = query({
      prompt: input,
      options: {
        cwd,
        model,
        effort: effort as Options['effort'],
        resume: sessionId ?? undefined,
        // Full access for now. Approval prompts come later.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
      },
    });
    const close = () => {
      input.close();
      running.close();
    };
    return { input, messages: running[Symbol.asyncIterator](), close, model, effort, translator: createTranslator() };
  }

  function stop(threadId: string) {
    const session = sessions.get(threadId);
    if (!session) return;
    clearTimeout(session.idle);
    session.close();
    sessions.delete(threadId);
  }

  // Hands one message to Claude and reads its answer until the turn ends.
  async function runTurn(threadId: string, { text, model, effort }: NewMessage) {
    let ok = false;
    try {
      setThread(threadId, { status: 'working', model, effort });
      // The model and reasoning level are fixed when a process starts, so a change means a fresh process.
      const old = sessions.get(threadId);
      if (old && (old.model !== model || old.effort !== effort)) stop(threadId);
      const session = sessions.get(threadId) ?? start(threadId, model, effort);
      sessions.set(threadId, session);
      clearTimeout(session.idle);

      session.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      for (;;) {
        const next = await session.messages.next();
        if (next.done) throw new Error('Claude stopped before finishing.');
        const msg = next.value;
        if (msg.type === 'system' && msg.subtype === 'init') {
          db.update(threads).set({ sessionId: msg.session_id }).where(eq(threads.id, threadId)).run();
        }
        for (const out of session.translator.translate(msg)) {
          if (out.type === 'item' && out.save) addItem(threadId, out.item);
          else hub.toThread(threadId, { ...out, threadId });
        }
        if (msg.type === 'result') {
          ok = !msg.is_error;
          break;
        }
      }
      session.idle = setTimeout(() => stop(threadId), IDLE_MS).unref();
    } catch (err) {
      stop(threadId);
      cutShort(threadId, err instanceof Error ? err.message : String(err));
    }
    setThread(threadId, { status: ok ? 'done' : 'needs' });
  }

  // Threads that were mid-answer when the server last stopped.
  for (const { id } of db.select({ id: threads.id }).from(threads).where(eq(threads.status, 'working')).all()) {
    cutShort(id, 'The server restarted while Claude was working. Send a message to continue.');
    setThread(id, { status: 'needs' });
  }

  return {
    // Saves the user's message right away, then queues the turn behind any turn still running in this thread.
    send(threadId: string, message: NewMessage) {
      addItem(threadId, { id: randomUUID(), kind: 'message', by: 'user', text: message.text, at: nextAt() });
      const turn = (turns.get(threadId) ?? Promise.resolve()).then(() => runTurn(threadId, message));
      turns.set(threadId, turn.catch(console.error));
    },
    // The bubble Claude is writing right now, if any.
    live: (threadId: string) => sessions.get(threadId)?.translator.live() ?? null,
  };
}
