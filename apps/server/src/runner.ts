import type { Access, Answer, Item, NewMessage, Status, Thread } from '@acocrew/shared';
import type { Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { loadItems, saveItem, threadCols, type Db } from './db.ts';
import type { Hub } from './hub.ts';
import { channels, threads } from './schema.ts';
import { createTranslator, nextAt, wasAborted, type Out } from './translate.ts';

// The part of the Claude Agent SDK we use. Tests pass a fake with the same shape.
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close(): void; interrupt(): Promise<unknown> };

type Tool = Extract<Item, { kind: 'tool' }>;

// One running Claude process and what we know about it right now.
type Session = {
  input: ReturnType<typeof queue<SDKUserMessage>>;
  running: ReturnType<QueryFn>;
  translator: ReturnType<typeof createTranslator>;
  model: string;
  effort: string;
  access: Access;
  // Claude is in the middle of a turn.
  busy: boolean;
  // The last turn ended in an error.
  failed: boolean;
  // Background work Claude is waiting on, in its own words.
  tasks: string[];
  // Approval prompts and questions waiting for the user: tool id -> how to hand over the answer.
  asks: Map<string, (answer: Answer | null) => void>;
  // We closed it on purpose, so whatever it still says is ignored.
  closed: boolean;
  idle?: NodeJS.Timeout;
};

// A Claude process with nothing to do for this long is closed. The next message starts a new one.
const IDLE_MS = 10 * 60_000;
// How long Stop waits for Claude to wind down politely before the process is closed anyway.
const INTERRUPT_MS = 3000;

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

// Runs Claude for threads: one process per thread, listened to for as long as it lives.
export function createRunner(db: Db, hub: Hub, query: QueryFn) {
  const sessions = new Map<string, Session>();

  function addItem(threadId: string, item: Item) {
    saveItem(db, threadId, item);
    hub.toThread(threadId, { type: 'item', threadId, item });
  }

  function emit(threadId: string, outs: Out[]) {
    for (const out of outs) {
      if (out.type === 'item' && out.save) addItem(threadId, out.item);
      else hub.toThread(threadId, { ...out, threadId });
    }
  }

  // Adds what is only known while the process runs to a stored thread row.
  const withTasks = (row: Omit<Thread, 'tasks'>): Thread => ({ ...row, tasks: sessions.get(row.id)?.tasks ?? [] });

  function setThread(threadId: string, patch: Partial<Omit<Thread, 'tasks'>>) {
    const set = { ...patch, updatedAt: Date.now() };
    const row = db.update(threads).set(set).where(eq(threads.id, threadId)).returning(threadCols).get();
    hub.toAll({ type: 'thread', thread: withTasks(row) });
  }

  // Tools that never finished are marked failed, and `closing` says why.
  function cutShort(threadId: string, closing: (wasOpen: boolean) => Item | false) {
    const open = loadItems(db, threadId).filter((item) => item.kind === 'tool' && !item.done) as Tool[];
    for (const item of open) addItem(threadId, { ...item, done: true, failed: true, endAt: nextAt() });
    const last = closing(open.length > 0);
    if (last) addItem(threadId, last);
  }

  const note = (kind: 'error' | 'notice', text: string): Item => ({ id: randomUUID(), kind, text, at: nextAt() });

  // Works out the thread's status from what Claude is doing, and tells everyone when it changed.
  function sync(threadId: string) {
    const session = sessions.get(threadId);
    if (!session) return;
    const waitingOnUser = session.asks.size > 0;
    const quiet = !session.busy && !session.tasks.length && !waitingOnUser;
    let status: Status = 'done';
    if (session.tasks.length) status = 'waiting';
    if (session.busy) status = 'working';
    if (waitingOnUser || (quiet && session.failed)) status = 'needs';

    clearTimeout(session.idle);
    if (quiet) session.idle = setTimeout(() => close(threadId), IDLE_MS).unref();

    const shown = JSON.stringify([status, session.tasks]);
    if (shown === lastShown.get(threadId)) return;
    lastShown.set(threadId, shown);
    setThread(threadId, { status });
  }
  const lastShown = new Map<string, string>();

  function start(threadId: string, { model, effort, access }: NewMessage): Session {
    const { cwd, sessionId } = db
      .select({ cwd: channels.path, sessionId: threads.sessionId })
      .from(threads)
      .innerJoin(channels, eq(channels.id, threads.channelId))
      .where(eq(threads.id, threadId))
      .get()!;
    const before = loadItems(db, threadId).find((item) => item.kind === 'todos');
    const input = queue<SDKUserMessage>();
    let session!: Session;

    // Claude calls this before any tool that is not plainly safe, and for its questions to the user.
    const canUseTool: Options['canUseTool'] = async (name, toolInput, { signal, suggestions, toolUseID }) => {
      // After Stop the process may still ask for things while it winds down. The answer is no.
      if (session.closed) return { behavior: 'deny', message: 'Stopped.' };
      const allow: PermissionResult = { behavior: 'allow', updatedInput: toolInput };
      if (session.access === 'full' && name !== 'AskUserQuestion') return allow;

      emit(threadId, session.translator.ask(toolUseID, name, toolInput));
      const answer = await new Promise<Answer | null>((resolve) => {
        session.asks.set(toolUseID, resolve);
        signal.addEventListener('abort', () => resolve(null));
        sync(threadId);
      });
      session.asks.delete(toolUseID);
      if (session.closed) return { behavior: 'deny', message: 'Stopped.' };
      const approved = answer?.decision === 'approve' || answer?.decision === 'always';
      emit(threadId, session.translator.answered(toolUseID, approved ? 'approved' : 'declined'));
      sync(threadId);

      // Cancel is a no that also ends Claude's turn, instead of letting it try something else.
      if (!approved) {
        return {
          behavior: 'deny',
          message: 'The user declined this action.',
          interrupt: answer?.decision === 'cancel',
        };
      }
      if (answer.answers) return { behavior: 'allow', updatedInput: { ...toolInput, answers: answer.answers } };
      // "Always allow" passes back the rule Claude itself suggests for this action. It lasts as long as the
      // process lives. Without a suggestion it is a plain yes, since a rule of our own would be too broad.
      if (answer.decision !== 'always' || !suggestions?.length) return allow;
      const rules = suggestions.map((rule) => ({ ...rule, destination: 'session' as const }));
      return { ...allow, updatedPermissions: rules };
    };

    const running = query({
      prompt: input,
      options: {
        cwd,
        model,
        effort: effort as Options['effort'],
        resume: sessionId ?? undefined,
        // Claude asks us about every action. With full access we say yes right away.
        permissionMode: 'default',
        canUseTool,
        includePartialMessages: true,
      },
    });
    session = {
      input,
      running,
      translator: createTranslator(before?.todos),
      model,
      effort,
      access,
      busy: false,
      failed: false,
      tasks: [],
      asks: new Map(),
      closed: false,
    };
    sessions.set(threadId, session);
    void listen(threadId, session);
    return session;
  }

  // Reads everything Claude says for as long as the process lives, whether or not anyone just wrote to it.
  async function listen(threadId: string, session: Session) {
    try {
      for await (const msg of session.running) {
        // Once closed on purpose, keep reading (and ignoring) until the stream ends by itself. Walking away
        // from the stream would kill the process before it has wound down.
        if (!session.closed) hear(threadId, session, msg);
      }
      if (!session.closed) throw new Error('Claude stopped unexpectedly.');
    } catch (err) {
      if (session.closed) return;
      fail(threadId, err);
    }
  }

  // The process died or could not start: say why, and ask for attention.
  function fail(threadId: string, err: unknown) {
    close(threadId);
    cutShort(threadId, () => note('error', err instanceof Error ? err.message : String(err)));
    setThread(threadId, { status: 'needs' });
  }

  function hear(threadId: string, session: Session, msg: SDKMessage) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      db.update(threads).set({ sessionId: msg.session_id }).where(eq(threads.id, threadId)).run();
    }
    if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
      session.tasks = msg.tasks.filter((task) => !task.ambient).map((task) => task.description);
    }
    // A turn is on from the main agent's first word until its `result`. Claude also starts turns on its own,
    // for example when background work finishes.
    const fromMainAgent = (msg.type === 'stream_event' || msg.type === 'assistant') && !msg.parent_tool_use_id;
    // When background work ends, Claude is told about it and reacts, which is a turn of its own.
    const wakesClaude =
      msg.type === 'system' && msg.subtype === 'task_notification' && !msg.ambient && !msg.skip_transcript;
    if ((fromMainAgent || wakesClaude) && !session.busy) {
      session.busy = true;
      session.failed = false;
    }
    if (msg.type === 'result') {
      session.busy = false;
      session.failed = msg.is_error && !wasAborted(msg);
    }
    emit(threadId, session.translator.translate(msg));
    sync(threadId);
  }

  // Takes the process out of service: from now on what it says is ignored, a new message gets a new process,
  // and anyone waiting on an answer from the user is let go. The process itself still runs.
  function detach(threadId: string) {
    const session = sessions.get(threadId);
    if (!session) return;
    session.closed = true;
    clearTimeout(session.idle);
    for (const letGo of session.asks.values()) letGo(null);
    sessions.delete(threadId);
    lastShown.delete(threadId);
    return session;
  }

  function kill(session: Session) {
    session.input.close();
    session.running.close();
  }

  function close(threadId: string) {
    const session = detach(threadId);
    if (session) kill(session);
  }

  // Threads that were in the middle of something when the server last stopped.
  for (const { id, status } of db.select(threadCols).from(threads).where(ne(threads.status, 'done')).all()) {
    const interrupted = status === 'working' || status === 'waiting';
    cutShort(
      id,
      (wasOpen) =>
        (interrupted || wasOpen) &&
        note('error', 'The server restarted while Claude was busy. Send a message to continue.'),
    );
    if (interrupted) setThread(id, { status: 'needs' });
  }

  return {
    withTasks,

    // Saves the user's message and hands it to Claude. If Claude is busy, it picks the message up when it can.
    send(threadId: string, message: NewMessage) {
      addItem(threadId, { id: randomUUID(), kind: 'message', by: 'user', text: message.text, at: nextAt() });
      const { model, effort, access } = message;
      db.update(threads).set({ model, effort, access }).where(eq(threads.id, threadId)).run();
      try {
        // The model and reasoning level are fixed when a process starts. A change takes a fresh process, which
        // would kill whatever the current one is doing, so it only happens when that one has nothing going on.
        const old = sessions.get(threadId);
        const changed = old && (old.model !== model || old.effort !== effort);
        if (changed && !old.busy && !old.tasks.length && !old.asks.size) close(threadId);
        const session = sessions.get(threadId) ?? start(threadId, message);
        session.access = access;
        session.busy = true;
        session.failed = false;
        session.input.push({
          type: 'user',
          message: { role: 'user', content: message.text },
          parent_tool_use_id: null,
        });
        // Always tell everyone, even if the status did not change: the model or access may have.
        lastShown.delete(threadId);
        sync(threadId);
      } catch (err) {
        fail(threadId, err);
      }
    },

    // Hands the user's reply to the approval prompt or question that is waiting for it.
    answer(threadId: string, answer: Answer) {
      const waiting = sessions.get(threadId)?.asks.get(answer.toolId);
      waiting?.(answer);
      return Boolean(waiting);
    },

    // Stops whatever Claude is doing in this thread, background work included.
    async stop(threadId: string) {
      const session = detach(threadId);
      if (!session) return;
      cutShort(threadId, () => note('notice', 'Stopped.'));
      setThread(threadId, { status: 'done' });
      // Ask Claude to wind down first, so its own record of the conversation ends cleanly.
      if (session.busy) {
        const giveUp = new Promise((resolve) => setTimeout(resolve, INTERRUPT_MS).unref());
        await Promise.race([session.running.interrupt().catch(() => {}), giveUp]);
      }
      kill(session);
    },

    // The bubbles Claude is writing right now.
    live: (threadId: string) => sessions.get(threadId)?.translator.live() ?? [],
  };
}
