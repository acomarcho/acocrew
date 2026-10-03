// The open thread: everything said and done in it, and the box to reply.
import type { Answer, Channel, Item, Thread, Todo } from '@acocrew/shared';
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
  X,
} from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { defaultRehypePlugins, Streamdown, type StreamdownProps } from 'streamdown';
import { imageUrl } from './images';
import { ApprovalPanel, isAsking, QuestionPanel, useQuestions } from './pending';
import { useApp } from './store';
import { Avatar, Composer, StatusBadge, type Settings } from './ui';

type Tool = Extract<Item, { kind: 'tool' }>;

// Both are made once, so a bubble that did not change is not drawn again while another one streams.
const plugins = { code };
// Claude reads files we do not control, and those could trick it into writing an image link that leaks data
// the moment the browser loads it. So images from other sites are not loaded. Everything else is the default.
type RehypePlugins = NonNullable<StreamdownProps['rehypePlugins']>;
const [harden, hardenOptions] = defaultRehypePlugins.harden as [RehypePlugins[number], object];
const rehypePlugins = Object.values({
  ...defaultRehypePlugins,
  harden: [harden, { ...hardenOptions, allowedImagePrefixes: [] }],
}) as RehypePlugins;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const byUser = (item?: Item) => !item || (item.kind === 'message' && item.by === 'user');

// Gives a card the steps a subagent took under it.
const ThreadCtx = createContext<(id: string) => Item[]>(null!);

// One row of the chat. `lead` rows show who is talking; the rows under them belong to the same speaker.
function Row({ agent, lead, at, children }: { agent: boolean; lead: boolean; at?: number; children: ReactNode }) {
  return (
    <div className={`flex gap-3 px-4 ${lead ? 'pt-2 pb-1' : 'py-1'}`}>
      {lead ? <Avatar agent={agent} /> : <div className="w-9 shrink-0" />}
      <div className="min-w-0 flex-1">
        {lead && (
          <div className="mb-1 flex items-baseline gap-2">
            <span className="font-semibold">{agent ? 'Claude' : 'You'}</span>
            {agent && <span className="rounded bg-primary/15 px-1.5 text-[11px] font-medium text-primary">Agent</span>}
            {at && <span className="text-xs text-muted-foreground">{clock(at)}</span>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// A message, with a button to copy its text that shows while the mouse is over it.
function Copyable({ text, children }: { text: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const reset = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(reset);
  }, [copied]);
  const label = copied ? 'Copied' : 'Copy message';
  return (
    <div className="group relative">
      {children}
      {text && (
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
          className="invisible absolute -top-3 right-0 rounded-md border border-border bg-card p-1.5 text-muted-foreground shadow-sm group-hover:visible hover:text-foreground"
          aria-label={label}
          title={label}
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
        </button>
      )}
    </div>
  );
}

// How long something took, or has been taking. Short things show nothing.
function Elapsed({ from, to }: { from: number; to?: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (to) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [to]);
  const seconds = Math.floor(((to ?? now) - from) / 1000);
  if (seconds < (to ? 1 : 3)) return null;
  const text = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return <span className="shrink-0 text-muted-foreground tabular-nums">{text}</span>;
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
        {!tool.ask && (tool.endAt || !tool.done) && <Elapsed from={tool.at} to={tool.endAt} />}
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
  if (item.kind === 'todos') return null;
  if (item.kind === 'message' && item.by === 'user') {
    return (
      <Row agent={false} lead at={item.at}>
        <Copyable text={item.text}>
          {/* A set height, so the chat does not jump when an image finishes loading. Click to see it full size. */}
          {item.images?.map((id) => (
            <a key={id} href={imageUrl(id)} target="_blank" rel="noreferrer" className="mr-2 mb-1 inline-block">
              <img
                src={imageUrl(id)}
                alt="Attached image"
                className="h-40 rounded-md border border-border bg-card object-contain"
              />
            </a>
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
        <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-sm whitespace-pre-wrap text-rose-500">
          {item.text}
        </p>
      )}
      {item.kind === 'notice' && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info size={13} className="shrink-0" />
          {item.text}
        </p>
      )}
      {item.kind === 'message' && (
        <Copyable text={item.text}>
          <Streamdown className="space-y-2 break-words" plugins={plugins} rehypePlugins={rehypePlugins}>
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

function Working({ lead }: { lead: boolean }) {
  return (
    <Row agent lead={lead}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Working</span>
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

// The full chat for one thread.
export function ThreadView({ thread, channel }: { thread: Thread; channel: Channel }) {
  const { items, openThread, sendMessage, stopThread, answer } = useApp();
  // Only what this person changed and has not sent yet. The rest follows the thread, so a teammate's change
  // shows up here and is not undone by the next reply.
  const [picked, setPicked] = useState<Partial<Settings>>({});
  const { model, effort, context, fast, access } = thread;
  const settings: Settings = { model, effort, context, fast, access, ...picked };
  // Follow new content only while the reader is at the bottom, so reading further up is not interrupted.
  const stick = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const all = items ?? [];
  // What a subagent did is shown inside its card, not in the main flow.
  const top = all.filter((item) => !item.parent);
  const todos = all.find((item) => item.kind === 'todos');
  // The first thing Claude is waiting on the user for, wherever it is (a subagent's step counts too).
  const asking = all.find(isAsking);
  const reply = (body: Omit<Answer, 'toolId'>) => answer(thread.id, { toolId: asking!.id, ...body });
  const questions = useQuestions(asking, reply);
  const active =
    thread.status === 'working' || thread.status === 'waiting' || all.some((i) => i.kind === 'tool' && !i.done);

  useEffect(() => openThread(thread.id), [openThread, thread.id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, thread.status]);

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
          <StatusBadge status={thread.status} />
        </header>
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto py-3"
        >
          {top.map((item, i) => (
            <ItemView key={item.id} item={item} lead={byUser(top[i - 1])} />
          ))}
          {thread.status === 'working' && <Working lead={byUser(top.at(-1))} />}
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
          <Composer
            placeholder={
              questions ? 'Type your own answer, or leave this blank to use the selected option' : 'Reply in thread'
            }
            settings={settings}
            onSettings={(next) => {
              const changed = Object.entries(next).filter(([key, value]) => thread[key as keyof Settings] !== value);
              setPicked(Object.fromEntries(changed));
            }}
            canSendEmpty={questions?.canSend}
            textOnly={Boolean(questions)}
            onSend={async (text, images) => {
              stick.current = true;
              // While Claude has a question open, the message box answers it.
              if (questions) return questions.send(text);
              await sendMessage(thread.id, { text, images, ...settings });
              setPicked({});
            }}
            onStop={active ? () => void stopThread(thread.id).catch(() => {}) : undefined}
          />
        </div>
      </div>
    </ThreadCtx.Provider>
  );
}
