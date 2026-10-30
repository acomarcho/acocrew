// The open thread: everything said and done in it, and the box to reply.
import {
  contextWindow,
  tokens,
  type Answer,
  type Channel,
  type Item,
  type Person,
  type Thread,
  type Todo,
} from '@acocrew/shared';
import { code } from '@streamdown/code';
import { Link } from '@tanstack/react-router';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Clock,
  Copy,
  Hand,
  Info,
  LoaderCircle,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { defaultRehypePlugins, Streamdown, type StreamdownProps } from 'streamdown';
import { byDay, ChatBox, ChatWords, dayLabel, dayOf, follows, timeline, type Entry, type Show } from './chat';
import { ApprovalPanel, isAsking, QuestionPanel, useQuestions } from './pending';
import { useCommands } from './commands';
import { draftOf, editDraft, useDraft } from './drafts';
import { answer, closeThread, markChatSeen, markSeen, openThread, sendMessage, stopThread, useApp } from './store';
import { ShareButton } from './sharing';
import { imageUrl } from './images';
import { pluginsFor, ShownFile, shownPrefix } from './shown';
import {
  Avatar,
  Composer,
  Elapsed,
  FileChip,
  Picture,
  PinButton,
  ThreadMenu,
  Segments,
  StatusBadge,
  UnreadBadge,
  type Settings,
} from './ui';

type Tool = Extract<Item, { kind: 'tool' }>;

// Both are made once, so a bubble that did not change is not drawn again while another one streams.
const plugins = { code };
// Claude reads files we do not control, and those could trick it into writing an image link that leaks data
// the moment the browser loads it. So images from other sites are not loaded, only files from the thread's folder
// (see shown.tsx). Everything else is the default.
type RehypePlugins = NonNullable<StreamdownProps['rehypePlugins']>;
const [harden, hardenOptions] = defaultRehypePlugins.harden as [RehypePlugins[number], object];
const rehypePlugins = Object.values({
  ...defaultRehypePlugins,
  harden: [harden, { ...hardenOptions, defaultOrigin: location.origin, allowedImagePrefixes: [shownPrefix()] }],
}) as RehypePlugins;
const components = { img: ShownFile };

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Whether a person wrote this row (or nothing came before). What Claude does next starts under its own name.
const byUser = (entry?: Entry) => !entry || entry.kind === 'chat' || (entry.kind === 'message' && entry.by === 'user');

// Gives a card the steps a subagent took under it.
const ThreadCtx = createContext<(id: string) => Item[]>(null!);

// One row of the chat. `lead` rows show who is talking; the rows under them belong to the same speaker.
// The speaker is Claude (`agent`), or the person whose user id is `by`. `note` is a few words after the time.
type Speaker = { agent?: boolean; by?: string; note?: string };
function Row({ agent, by, note, lead, at, children }: Speaker & { lead: boolean; at?: number; children: ReactNode }) {
  const people = useApp((state) => state.people);
  const person: Person | undefined = people.find((known) => known.id === by);
  // Rows off screen are not laid out or painted (content-visibility), so a long thread stays quick while
  // Claude writes. Each keeps the height it last had, so the scroll bar does not jump.
  return (
    <div
      className={`flex gap-3 px-4 [contain-intrinsic-size:auto_120px] [content-visibility:auto] ${lead ? 'pt-2 pb-1' : 'py-1'}`}
    >
      {lead ? <Avatar agent={agent} person={person} /> : <div className="w-9 shrink-0" />}
      <div className="min-w-0 flex-1">
        {lead && (
          <div className="mb-1 flex items-baseline gap-2">
            <span className="font-semibold">{agent ? 'Claude' : (person?.name ?? 'Someone')}</span>
            {agent && <span className="rounded bg-primary/15 px-1.5 text-[11px] font-medium text-primary">Agent</span>}
            {at && <span className="text-xs text-muted-foreground">{clock(at)}</span>}
            {note && <span className="truncate text-[11px] text-sky-700">{note}</span>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// A message, with a button under it to copy its text that shows while the mouse is over it. `at` puts the time
// next to that button, where it can be seen without a mouse (on a phone that row is otherwise empty).
function Copyable({ text, at, children }: { text: string; at?: number; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const reset = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(reset);
  }, [copied]);
  const label = copied ? 'Copied' : 'Copy message';
  return (
    <div className="group">
      {children}
      {/* Sits in its own row under the text, so it never covers it. The row is always there, so nothing jumps on hover. */}
      {text && (
        <div className="mt-0.5 flex items-center gap-2.5 text-muted-foreground">
          {at && <span className="text-xs">{clock(at)}</span>}
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
            className="-ml-1.5 rounded-md p-1.5 opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
            aria-label={label}
            title={label}
          >
            {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
          </button>
        </div>
      )}
    </div>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <pre className="max-h-72 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-xs break-words whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

// One thing Claude did. Click it to see what went in, what came out, and (for a subagent) every step it took.
function ToolCard({ tool }: { tool: Tool }) {
  const under = useContext(ThreadCtx);
  const asking = tool.ask === 'pending' && !tool.done;
  const [open, setOpen] = useState(false);
  const steps = under(tool.id);
  const stepTools = steps.filter((step) => step.kind === 'tool');
  const lastStep = stepTools.at(-1);
  return (
    <div className="rounded-md border border-border bg-muted text-xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {asking && <Hand size={13} className="shrink-0 text-rose-500" />}
        {!asking && !tool.done && <LoaderCircle size={13} className="shrink-0 animate-spin text-muted-foreground" />}
        {tool.done && !tool.failed && <Check size={13} className="shrink-0 text-emerald-500" />}
        {tool.failed && <X size={13} className="shrink-0 text-rose-500" />}
        <span className="shrink-0 font-medium">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{tool.detail}</span>
        {stepTools.length > 0 && (
          <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">
            {!tool.done && lastStep && `${lastStep.name} ${lastStep.detail.split('/').at(-1)} · `}
            {stepTools.length} {stepTools.length === 1 ? 'step' : 'steps'}
          </span>
        )}
        {tool.ask === 'declined' && <span className="shrink-0 text-rose-500">Declined</span>}
        {!tool.ask && (tool.endAt || !tool.done) && (
          <Elapsed from={tool.at} to={tool.endAt} className="text-muted-foreground" />
        )}
        <ChevronRight
          size={13}
          className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-border p-2.5">
          <Block label="What went in" text={tool.input} />
          {steps.length > 0 && (
            <div className="rounded-md border border-border bg-background py-1">
              {steps.map((step) => (
                <ItemView key={step.id} item={step} lead={false} nested />
              ))}
            </div>
          )}
          <Block label="What came out" text={tool.output} />
        </div>
      )}
    </div>
  );
}

// Everything Claude does in a row (tools, answers, errors) sits under one "Claude" heading.
// `nested` rows are a subagent's steps inside its card, which has no room for avatars.
function ItemView({ item, lead, nested }: { item: Item; lead: boolean; nested?: boolean }) {
  const threadId = useApp((state) => state.openId)!;
  if (item.kind === 'todos') return null;
  if (item.kind === 'message' && item.by === 'user') {
    return (
      <Row by={item.userId} lead at={item.at}>
        <Copyable text={item.text}>
          {/* A set height, so the chat does not jump when an image finishes loading. */}
          {item.images?.map((id) => (
            <span key={id} className="mr-2 mb-1 inline-block">
              <Picture src={imageUrl(id)} className="h-40 bg-card object-contain" />
            </span>
          ))}
          {item.files?.map((id) => (
            <span key={id} className="mr-2 mb-1 inline-block">
              <FileChip id={id} />
            </span>
          ))}
          <p className="break-words whitespace-pre-wrap">{item.text}</p>
        </Copyable>
      </Row>
    );
  }
  const body = (
    <>
      {item.kind === 'tool' && <ToolCard tool={item} />}
      {item.kind === 'error' && (
        <Copyable text={item.text}>
          <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-sm whitespace-pre-wrap text-rose-500">
            {item.text}
          </p>
        </Copyable>
      )}
      {item.kind === 'notice' && (
        <Copyable text={item.text}>
          <p className="flex items-center gap-1.5">
            <Info size={15} className="shrink-0 text-muted-foreground" />
            {item.text}
          </p>
        </Copyable>
      )}
      {item.kind === 'message' && (
        <Copyable text={item.text} at={item.at}>
          <Streamdown
            className="space-y-2 break-words"
            plugins={plugins}
            rehypePlugins={pluginsFor(threadId, rehypePlugins)}
            components={components}
          >
            {item.text}
          </Streamdown>
        </Copyable>
      )}
    </>
  );
  if (nested) return <div className="px-2.5 py-1">{body}</div>;
  return (
    <Row agent lead={lead} at={item.at}>
      {body}
    </Row>
  );
}

// Something a person wrote to the other people in the thread. It is tinted, so it cannot be taken for a
// message to Claude.
function ChatRow({ chat, fresh }: { chat: Extract<Entry, { kind: 'chat' }>; fresh: boolean }) {
  return (
    <>
      {fresh && (
        <div className="flex items-center gap-2 px-4 pt-2 text-[11px] font-semibold text-primary uppercase">
          <span className="h-px flex-1 bg-primary/40" />
          New
          <span className="h-px flex-1 bg-primary/40" />
        </div>
      )}
      <div className="my-1 border-l-2 border-sky-400 bg-sky-500/[0.07]">
        <Row by={chat.userId} lead at={chat.at} note="People only">
          <p className="break-words whitespace-pre-wrap">
            <ChatWords chat={chat} />
          </p>
        </Row>
      </div>
    </>
  );
}

// One day of the chat, under a line that says which day it is. The day's pill stays at the top while its
// rows scroll by, and the next day's section pushes it away, since a sticky thing never leaves its section.
function DaySection({ at, children }: { at: number; children: ReactNode }) {
  return (
    <section className="relative before:absolute before:inset-x-4 before:top-3.5 before:border-t before:border-border">
      <div className="pointer-events-none sticky top-0 z-10 flex h-7 items-center justify-center">
        <span className="rounded-full border border-border bg-background px-3 py-0.5 text-xs font-medium shadow-sm">
          {dayLabel(at)}
        </span>
      </div>
      {children}
    </section>
  );
}

function Working({ lead, since }: { lead: boolean; since: number | null }) {
  return (
    <Row agent lead={lead}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Working {since && <Elapsed from={since} label="for" />}</span>
        <span className="flex gap-1">
          {[0, 150, 300].map((d) => (
            <span
              key={d}
              className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
              style={{ animationDelay: `${d}ms` }}
            />
          ))}
        </span>
      </div>
    </Row>
  );
}

// How full Claude's context window is after its latest call, as a bar and as "182K / 1M".
function ContextBar({ thread }: { thread: Thread }) {
  const models = useApp((state) => state.models);
  const used = thread.contextUsed;
  if (used === null) return null;
  const max = contextWindow(thread, models);
  return (
    <Row agent lead={false}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums" title="Context window used">
        <div
          role="progressbar"
          aria-label="Context window used"
          aria-valuenow={used}
          aria-valuemax={max}
          className="h-1 w-24 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary" style={{ width: `${(used / max) * 100}%` }} />
        </div>
        {tokens(used)} / {tokens(max)}
      </div>
    </Row>
  );
}

// Claude's own to-do list, shown until everything on it is done.
function Todos({ todos }: { todos: Todo[] }) {
  const left = todos.filter((todo) => todo.status !== 'completed');
  if (left.length === 0) return null;
  return (
    <div className="mb-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        Claude's to-do list · {todos.length - left.length} of {todos.length} done
      </div>
      {todos.map((todo) => (
        <div key={todo.id} className="flex items-center gap-2 py-0.5">
          {todo.status === 'completed' && <CircleCheck size={14} className="shrink-0 text-emerald-500" />}
          {todo.status === 'in_progress' && <CircleDot size={14} className="shrink-0 text-amber-500" />}
          {todo.status === 'pending' && <Circle size={14} className="shrink-0 text-muted-foreground" />}
          <span className={todo.status === 'completed' ? 'text-muted-foreground line-through' : ''}>
            {todo.subject}
          </span>
        </div>
      ))}
    </div>
  );
}

// How many rows a thread shows at first, and how many more each time the reader scrolls near the top. A long
// thread has thousands, and drawing them all made every update slow.
const PAGE = 100;

// The rows of the timeline that show: those from `from` (a time) on. Gives back where they start in `rows`.
const shownFrom = (rows: Entry[], from: number) => {
  const start = rows.findIndex((row) => row.at >= from);
  return start < 0 ? rows.length : start;
};

// The thread's rows, from the last PAGE on. Near the top, PAGE earlier ones are added, and the view is kept
// where it was. Made once the thread's content is in, so it starts at its last PAGE rows.
function Rows({
  rows,
  scroller,
  stick,
}: {
  rows: Entry[];
  scroller: RefObject<HTMLDivElement | null>;
  stick: RefObject<boolean>;
}) {
  const chatNew = useApp((state) => state.chatNew);
  // A time, not a count, so new rows at the bottom do not push rows out at the top.
  const [from, setFrom] = useState(() => rows.at(-PAGE)?.at ?? 0);
  // While the reader is at the bottom, it is the last PAGE rows again whenever rows come or go (new ones
  // streaming in, a switch of what shows), so the thread does not grow back to thousands of rows.
  const [count, setCount] = useState(rows.length);
  const last = rows.at(-PAGE)?.at ?? 0;
  if (rows.length !== count) {
    setCount(rows.length);
    if (stick.current && last > from) setFrom(last);
  }
  const start = shownFrom(rows, from);
  const top = useRef<HTMLDivElement>(null);
  // The scroller and how far its view was from the bottom before earlier rows came in, to put it back there.
  const kept = useRef<{ el: HTMLDivElement; gap: number } | null>(null);
  const earlier = useEffectEvent((el: HTMLDivElement) => {
    kept.current = { el, gap: el.scrollHeight - el.scrollTop };
    setFrom(rows[Math.max(0, start - PAGE)].at);
  });
  useEffect(() => {
    const el = scroller.current;
    if (!top.current || !el) return;
    // Watched again after each load, so a short page keeps loading until it fills the screen.
    const watch = new IntersectionObserver(([seen]) => seen.isIntersecting && earlier(el), {
      root: el,
      rootMargin: '800px 0px 0px 0px',
    });
    watch.observe(top.current);
    return () => watch.disconnect();
  }, [start, scroller]);
  useLayoutEffect(() => {
    if (!kept.current) return;
    const { el, gap } = kept.current;
    el.scrollTop = el.scrollHeight - gap;
    kept.current = null;
  }, [from]);
  return (
    <>
      {start > 0 && <div ref={top} className="h-px" />}
      {byDay(rows.slice(start)).map((day) => (
        // Keyed by the day, so switching what shows does not redraw a day (and close its open cards).
        <DaySection key={dayOf(day[0].at)} at={day[0].at}>
          {day.map((row, i) =>
            row.kind === 'chat' ? (
              <ChatRow key={`chat-${row.id}`} chat={row} fresh={row.id === chatNew} />
            ) : (
              <ItemView key={row.id} item={row} lead={byUser(day[i - 1])} />
            ),
          )}
        </DaySection>
      ))}
    </>
  );
}

// The box to write to Claude. It is its own component, so typing redraws only the box and not the thread.
function Reply({
  thread,
  questions,
  active,
  onSend,
}: {
  thread: Thread;
  questions: ReturnType<typeof useQuestions>;
  active: boolean;
  onSend: () => void;
}) {
  const commands = useCommands(`thread=${thread.id}`);
  // What this person typed and has not sent yet. Of the settings it holds only what they changed. The rest
  // follows the thread, so a teammate's change shows up here and is not undone by the next reply.
  const draft = useDraft(thread.id);
  const { model, effort, context, fast, access } = thread;
  const settings: Settings = { model, effort, context, fast, access, ...draft.settings };
  return (
    <Composer
      placeholder={
        questions ? 'Type your own answer, or leave this blank to use the selected option' : 'Reply in thread'
      }
      value={draft}
      onChange={(change) => editDraft(thread.id, change(draftOf(thread.id)))}
      settings={settings}
      onSettings={(next) => {
        const changed = Object.entries(next).filter(([key, value]) => thread[key as keyof Settings] !== value);
        editDraft(thread.id, { settings: Object.fromEntries(changed) });
      }}
      commands={commands}
      canSendEmpty={questions?.canSend}
      textOnly={Boolean(questions)}
      onSend={async (message) => {
        onSend();
        // While Claude has a question open, the message box answers it.
        if (questions) return questions.send(message.text);
        await sendMessage(thread.id, { ...message, ...settings });
        editDraft(thread.id, { settings: {} });
      }}
      onStop={active ? () => void stopThread(thread.id).catch(() => {}) : undefined}
    />
  );
}

// Whether the person can see this browser tab right now.
const watchTab = (changed: () => void) => {
  document.addEventListener('visibilitychange', changed);
  return () => document.removeEventListener('visibilitychange', changed);
};
const tabVisible = () => !document.hidden;

// The full chat for one thread.
export function ThreadView({ thread, channel }: { thread: Thread; channel: Channel }) {
  const items = useApp((state) => state.items);
  const chats = useApp((state) => state.chats);
  const unread = useApp((state) => state.unread[thread.id]);
  const seenAt = useApp((state) => state.seen[thread.id] ?? 0);
  // Which part of the thread shows, and who the message box writes to.
  const [show, setShow] = useState<Show>('all');
  const [to, setTo] = useState<'claude' | 'people'>('claude');
  // Follow new content only while the reader is at the bottom, so reading further up is not interrupted (see
  // `follows`). `lastTop` also records where our own jumps land, so a jump's scroll event (which can arrive
  // after the reader already turned the wheel up) does not count as the reader moving down.
  const stick = useRef(true);
  const lastTop = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const all = items ?? [];
  // What a subagent did is shown inside its card, not in the main flow.
  const top = all.filter((item) => !item.parent);
  const rows = timeline(top, chats, show);
  const todos = all.find((item) => item.kind === 'todos');
  // The first thing Claude is waiting on the user for, wherever it is (a subagent's step counts too).
  const asking = all.find(isAsking);
  const reply = (body: Omit<Answer, 'toolId'>) => answer(thread.id, { toolId: asking!.id, ...body });
  const questions = useQuestions(asking, reply);
  const active =
    thread.status === 'working' || thread.status === 'waiting' || all.some((i) => i.kind === 'tool' && !i.done);

  useEffect(() => {
    openThread(thread.id);
    return closeThread;
  }, [thread.id]);

  // Whatever happens in the thread while the person has it in front of them is seen. Said before the screen
  // is drawn, so the thread never shows as new in the list while it is being looked at.
  const visible = useSyncExternalStore(watchTab, tabVisible);
  const unseen = thread.updatedAt > seenAt;
  useLayoutEffect(() => {
    if (visible && unseen) markSeen(thread);
  }, [visible, unseen, thread]);

  // The same goes for the chat, while it is not filtered away: it is read up to its last message. Not before
  // the store holds this thread's chat (right after a switch it still has the last thread's).
  const lastChat = chats.at(-1)?.id ?? 0;
  const unseenChat = useApp((state) => state.openId === thread.id && lastChat > state.chatSeen) && show !== 'claude';
  useEffect(() => {
    if (visible && unseenChat) markChatSeen(thread.id, lastChat);
  }, [visible, unseenChat, thread.id, lastChat]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, [items, chats, show, thread.status]);

  return (
    <ThreadCtx.Provider value={(id) => all.filter((item) => item.parent === id)}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Link
            to="/c/$channelId"
            params={{ channelId: channel.id }}
            className="-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted md:hidden"
            aria-label="Back"
          >
            <ChevronLeft size={20} />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{thread.title}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{thread.path ?? channel.path}</div>
          </div>
          <ShareButton thread={thread} />
          <PinButton thread={thread} />
          <ThreadMenu thread={thread} />
          <StatusBadge status={thread.status} />
        </header>
        <div className="border-b border-border px-3 py-1.5">
          <Segments
            value={show}
            onChange={setShow}
            options={[
              { id: 'all', name: 'Everything' },
              { id: 'claude', name: 'Claude' },
              // The chat is not read while it is filtered away, so what is new in it is counted here.
              { id: 'people', name: 'People', after: <UnreadBadge unread={unread} /> },
            ]}
          />
        </div>
        <div
          ref={scroller}
          // A wheel says "up" before the page moves, so a new chunk arriving mid-scroll cannot cancel it.
          onWheel={(e) => {
            if (e.deltaY < 0 && e.currentTarget.scrollTop > 0) stick.current = false;
          }}
          onScroll={(e) => {
            const el = e.currentTarget;
            const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            stick.current = follows(stick.current, el.scrollTop, lastTop.current, fromBottom);
            lastTop.current = el.scrollTop;
          }}
          className="min-h-0 flex-1 overflow-y-auto py-3"
        >
          {items && <Rows rows={rows} scroller={scroller} stick={stick} />}
          {thread.status === 'working' && show !== 'people' && (
            <Working lead={byUser(rows.at(-1))} since={thread.since} />
          )}
          {/* The bar is about Claude, so it goes away with the rest of Claude's side. */}
          {show !== 'people' && <ContextBar thread={thread} />}
        </div>
        <div className="p-3 pt-0">
          {todos?.kind === 'todos' && <Todos todos={todos.todos} />}
          {thread.tasks.length > 0 && (
            <p className="mb-2 flex items-start gap-1.5 px-1 text-xs text-muted-foreground">
              <Clock size={13} className="mt-0.5 shrink-0" />
              <span>
                {thread.status === 'waiting' ? 'Claude is waiting on background work' : 'Running in the background'}:{' '}
                {thread.tasks.join('; ')}
              </span>
            </p>
          )}
          {questions && <QuestionPanel flow={questions} />}
          {asking && !questions && <ApprovalPanel key={asking.id} tool={asking} reply={reply} />}
          <div className="mb-2">
            <Segments
              value={to}
              onChange={setTo}
              options={[
                { id: 'claude', name: 'To Claude', after: <Sparkles size={12} /> },
                { id: 'people', name: 'To people', after: <Users size={12} /> },
              ]}
            />
          </div>
          {to === 'people' && <ChatBox thread={thread} />}
          {to === 'claude' && (
            <Reply thread={thread} questions={questions} active={active} onSend={() => (stick.current = true)} />
          )}
        </div>
      </div>
    </ThreadCtx.Provider>
  );
}
