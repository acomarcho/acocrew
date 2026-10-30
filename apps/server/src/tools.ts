// Tools that Claude in a thread can use on acocrew itself: start a thread, list threads, read one, write in one.
// They run inside the server. Each Claude process gets its own set, made for the thread it runs in, so the tools
// know who is asking without any login: they act as the person who owns that thread.
import { ACCESS, CONTEXTS, EFFORTS, type Access, type NewMessage, type Visibility } from '@acocrew/shared';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { canSee, loadItems, threadCols, type Db, type StoredThread } from './db.ts';
import { listPlaces } from './git.ts';
import { channels, threads } from './schema.ts';

// What the tools need from the server, which checks them the way it checks what a person sends.
export type ThreadOps = {
  db: Db;
  // Starts a thread, or says why not. `pick` is where, as the start screen says it.
  start(
    channelId: string,
    message: NewMessage,
    pick: { from?: string; path?: string },
    starter: { userId: string; visibility: Visibility; shared: string[] },
  ): Promise<StoredThread | { error: string }>;
  // Hands a message to a thread. Gives back why not, or nothing when it went.
  send(threadId: string, message: NewMessage, userId: string): Promise<string | undefined>;
};

const ids = (list: { id: string }[]) => list.map((option) => option.id) as [string, ...string[]];
const answer = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const refuse = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
// What Claude is told about a thread.
const shown = (thread: StoredThread) => ({
  id: thread.id,
  title: thread.title,
  status: thread.status,
  path: thread.path,
  branch: thread.branch,
  updatedAt: new Date(thread.updatedAt).toISOString(),
});

const INSTRUCTIONS = `These tools work on acocrew, the team chat app this conversation runs in. An acocrew thread
(also called a session) is its own Claude conversation in a repository, that people can watch and reply to.
- start_thread starts one. Use it when the user asks for a new acocrew thread or session, or wants work split
  into threads they can follow. By default it gets a new worktree from the newest main branch. When the user
  wants it in this worktree (this folder, here), pass worktree: "this".
- list_threads, read_thread and send_message check on threads and reply in them.
People read your replies in acocrew. To show them an image (png, jpg, gif, webp, svg), an HTML page or an
Excalidraw drawing (.excalidraw), save it inside the folder you work in and put \`![title](path)\` in your reply.
An HTML page must be one self-contained file.`;

export function threadTools(threadId: string, { db, start, send }: ThreadOps) {
  const row = (id: string) => db.select(threadCols).from(threads).where(eq(threads.id, id)).get();
  // The calling thread as it is right now: who sees it can change while Claude runs.
  const caller = () => row(threadId)!;
  // What a tool gives back shows in the calling thread. So the tools only reach a thread that everyone who sees the
  // calling thread also sees: from a public thread that is public threads, from a private one what its owner and
  // the people it is shared with all see.
  const reachable = (target: StoredThread) => {
    const { visibility, createdBy, shared } = caller();
    const viewers = [createdBy ?? '', ...shared];
    return visibility === 'public' ? target.visibility === 'public' : viewers.every((id) => canSee(target, id));
  };
  const find = (id: string) => {
    const thread = row(id);
    return thread && reachable(thread) ? thread : undefined;
  };
  const notFound = refuse('Thread not found.');

  return createSdkMcpServer({
    name: 'acocrew',
    instructions: INSTRUCTIONS,
    alwaysLoad: true,
    tools: [
      tool(
        'start_thread',
        'Start a new acocrew thread in this repository, with `text` as its first message. Gives back the thread.',
        {
          text: z.string().trim().min(1).describe('The first message, as the user would write it.'),
          worktree: z
            .enum(['new', 'this'])
            .default('new')
            .describe('"new": a fresh worktree on its own branch. "this": the folder this thread works in.'),
          from: z
            .string()
            .optional()
            .describe('Branch a new worktree starts from. Default: the remote main branch. Not used with "this".'),
          model: z.string().default('claude-opus-5-5'),
          effort: z.enum(ids(EFFORTS)).default('medium'),
          context: z.enum(ids(CONTEXTS)).default('1m'),
          fast: z.boolean().default(false),
          access: z
            .enum(ids(ACCESS))
            .optional()
            .describe('"full": acts without asking. "ask": asks first. Default: the same as this thread.'),
        },
        async ({ text, worktree, from, access, ...settings }) => {
          const thread = caller();
          const repo = db.select().from(channels).where(eq(channels.id, thread.channelId)).get()!.path;
          // The start screen offers the remote's main branch first (see listPlaces). Starting from it fetches it.
          const pick =
            worktree === 'this'
              ? { path: thread.path ?? repo }
              : { from: from ?? (await listPlaces(repo)).branches[0]?.name };
          // A thread on Ask first starts threads on Ask first, unless Claude asks for more where the person sees it.
          const message: NewMessage = {
            text,
            images: [],
            files: [],
            ...settings,
            access: (access as Access) ?? thread.access,
          };
          // Seen by the same people as this thread, never fewer or more: it reaches what they all see (see
          // `reachable`), and who sees a thread is for its owner to decide.
          const { createdBy, visibility, shared } = thread;
          const starter = { userId: createdBy ?? '', visibility, shared };
          const made = await start(thread.channelId, message, pick, starter);
          return 'error' in made ? refuse(made.error) : answer(shown(made));
        },
      ),
      tool('list_threads', 'List the acocrew threads in this repository, newest first.', {}, async () => {
        const list = db
          .select(threadCols)
          .from(threads)
          .where(eq(threads.channelId, caller().channelId))
          .orderBy(desc(threads.updatedAt))
          .all()
          .filter(reachable);
        return answer(list.map((one) => ({ ...shown(one), ...(one.id === threadId && { this: true }) })));
      }),
      tool(
        'read_thread',
        'Read an acocrew thread: how it is doing and its last messages.',
        { id: z.string(), last: z.number().int().positive().default(20).describe('How many messages, from the end.') },
        async ({ id, last }) => {
          const found = find(id);
          if (!found) return notFound;
          const messages = loadItems(db, found.id).flatMap((item) =>
            item.kind === 'message' ? [{ by: item.by, text: item.text }] : [],
          );
          return answer({ ...shown(found), messages: messages.slice(-last) });
        },
      ),
      tool(
        'send_message',
        'Write in an acocrew thread. Claude there gets it as a message from the user, with its current settings.',
        { id: z.string(), text: z.string().trim().min(1) },
        async ({ id, text }) => {
          const found = find(id);
          if (!found) return notFound;
          const { model, effort, context, fast, access } = found;
          const message = { text, images: [], files: [], model, effort, context, fast, access };
          const why = await send(found.id, message, caller().createdBy ?? '');
          return why ? refuse(why) : answer({ ok: true });
        },
      ),
    ],
  });
}
