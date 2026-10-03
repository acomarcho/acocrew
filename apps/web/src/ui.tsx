// Building blocks for the Inbox screens.
import { EFFORTS, MODELS, type Channel, type Item, type Status, type Thread } from '@acocrew/shared';
import { code } from '@streamdown/code';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  FolderGit2,
  LoaderCircle,
  Menu,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import { defaultRehypePlugins, Streamdown, type StreamdownProps } from 'streamdown';
import { useApp } from './store';

function Avatar({ agent }: { agent: boolean }) {
  return (
    <div
      className={`grid size-9 shrink-0 place-items-center rounded-lg font-semibold text-white ${agent ? 'bg-[#d97757]' : 'bg-indigo-500'}`}
    >
      {agent ? <Sparkles size={18} /> : 'Y'}
    </div>
  );
}

const STATUS: Record<Status, { label: string; text: string; dot: string }> = {
  working: { label: 'Working', text: 'text-amber-500 bg-amber-500/10', dot: 'bg-amber-500 animate-pulse' },
  needs: { label: 'Needs you', text: 'text-rose-500 bg-rose-500/10', dot: 'bg-rose-500' },
  done: { label: 'Done', text: 'text-emerald-500 bg-emerald-500/10', dot: 'bg-emerald-500' },
};
export const STATUS_ORDER: Status[] = ['needs', 'working', 'done'];
export const statusLabel = (s: Status) => STATUS[s].label;

export function StatusDot({ status }: { status: Status }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${STATUS[status].dot}`} />;
}

function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[status].text}`}
    >
      <StatusDot status={status} />
      {STATUS[status].label}
    </span>
  );
}

export function NavButton() {
  const { setNavOpen } = useApp();
  return (
    <button
      onClick={() => setNavOpen(true)}
      className="-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted md:hidden"
      aria-label="Open menu"
    >
      <Menu size={20} />
    </button>
  );
}

// Sidebar that is always visible on desktop and slides in on phones.
export function Drawer({ children, className = '' }: { children: ReactNode; className?: string }) {
  const { navOpen, setNavOpen } = useApp();
  return (
    <>
      {navOpen && <div className="absolute inset-0 z-30 bg-black/50 md:hidden" onClick={() => setNavOpen(false)} />}
      <nav
        className={`absolute inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-transform md:static md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        } ${className}`}
      >
        {children}
      </nav>
    </>
  );
}

type Option = { id: string; name: string; hint: string };

type PickerProps = {
  icon: ReactNode;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  menuClass?: string;
};

function Picker({ icon, value, options, onChange, menuClass = 'left-0' }: PickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {icon}
        <span className="max-w-28 truncate sm:max-w-none">{options.find((o) => o.id === value)?.name}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={`absolute bottom-full z-50 mb-1 w-52 rounded-lg border border-border bg-card p-1 text-foreground shadow-xl ${menuClass}`}
          >
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span className="flex-1">
                  <span className="block">{o.name}</span>
                  <span className="block text-xs text-muted-foreground">{o.hint}</span>
                </span>
                {o.id === value && <Check size={14} className="text-primary" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type ComposerProps = {
  placeholder: string;
  model: string;
  effort: string;
  onModel: (v: string) => void;
  onEffort: (v: string) => void;
  onSend: (text: string) => Promise<unknown>;
  autoFocus?: boolean;
};

function Composer({ placeholder, model, effort, onModel, onEffort, onSend, autoFocus }: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const clean = text.trim();
  // The text stays in the box until the server has taken it, so a failed send loses nothing.
  const submit = async () => {
    if (!clean || sending) return;
    setSending(true);
    setError('');
    try {
      await onSend(clean);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send.');
    }
    setSending(false);
  };
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm focus-within:border-primary">
      <textarea
        rows={2}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault();
          void submit();
        }}
        className="block w-full resize-none bg-transparent px-3.5 pt-3 text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm"
      />
      {error && <p className="px-3.5 pb-1 text-xs text-rose-500">{error}</p>}
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        <Picker
          icon={<Sparkles size={14} className="text-primary" />}
          value={model}
          options={MODELS}
          onChange={onModel}
        />
        {/* nudged left on phones so the menu stays on screen */}
        <Picker
          icon={<Brain size={14} />}
          value={effort}
          options={EFFORTS}
          onChange={onEffort}
          menuClass="-left-20 sm:left-0"
        />
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!clean || sending}
          aria-label="Send"
          className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}

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

// Everything Claude does in a row (tools, answers, errors) sits under one "Claude" heading.
function ItemView({ item, lead }: { item: Item; lead: boolean }) {
  if (item.kind === 'message' && item.by === 'user') {
    return (
      <Row agent={false} lead at={item.at}>
        <p className="leading-relaxed break-words whitespace-pre-wrap">{item.text}</p>
      </Row>
    );
  }
  return (
    <Row agent lead={lead} at={item.at}>
      {item.kind === 'tool' && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs">
          {!item.done && <LoaderCircle size={13} className="shrink-0 animate-spin text-muted-foreground" />}
          {item.done && !item.failed && <Check size={13} className="shrink-0 text-emerald-500" />}
          {item.failed && <X size={13} className="shrink-0 text-rose-500" />}
          <span className="font-medium">{item.name}</span>
          <span className="truncate font-mono text-muted-foreground">{item.detail}</span>
        </div>
      )}
      {item.kind === 'error' && (
        <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-sm whitespace-pre-wrap text-rose-500">
          {item.text}
        </p>
      )}
      {item.kind === 'message' && (
        <Streamdown className="leading-relaxed break-words" plugins={plugins} rehypePlugins={rehypePlugins}>
          {item.text}
        </Streamdown>
      )}
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

// The full chat for one thread.
export function ThreadView({ thread, channel }: { thread: Thread; channel: Channel }) {
  const { items, openThread, sendMessage } = useApp();
  const [model, setModel] = useState(thread.model);
  const [effort, setEffort] = useState(thread.effort);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => openThread(thread.id), [openThread, thread.id]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, thread.status]);

  return (
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
          <div className="truncate font-mono text-xs text-muted-foreground">{channel.path}</div>
        </div>
        <StatusBadge status={thread.status} />
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto py-3">
        {items?.map((item, i) => (
          <ItemView key={item.id} item={item} lead={byUser(items[i - 1])} />
        ))}
        {thread.status === 'working' && <Working lead={byUser(items?.at(-1))} />}
      </div>
      <div className="p-3 pt-0">
        <Composer
          placeholder="Reply in thread"
          model={model}
          effort={effort}
          onModel={setModel}
          onEffort={setEffort}
          onSend={(text) => sendMessage(thread.id, { text, model, effort })}
        />
      </div>
    </div>
  );
}

export function NewThreadButton({ channelId }: { channelId: string }) {
  return (
    <Link
      to="/c/$channelId/new"
      params={{ channelId }}
      className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
    >
      <Plus size={16} />
      New Thread
    </Link>
  );
}

// The only way to post in a channel: start a thread.
export function NewThread({ channel }: { channel: Channel }) {
  const { createThread } = useApp();
  const navigate = useNavigate();
  const [model, setModel] = useState(MODELS[0].id);
  const [effort, setEffort] = useState('high');
  const channelId = channel.id;
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <FolderGit2 size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          New thread in <b className="text-foreground">#{channel.name}</b>. Claude works right in{' '}
          <span className="font-mono">{channel.path}</span>.
        </span>
        <Link
          to="/c/$channelId"
          params={{ channelId }}
          className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
        >
          Cancel
        </Link>
      </div>
      <Composer
        autoFocus
        placeholder="What should Claude work on?"
        model={model}
        effort={effort}
        onModel={setModel}
        onEffort={setEffort}
        onSend={async (text) => {
          const thread = await createThread({ channelId, text, model, effort });
          void navigate({ to: '/c/$channelId/t/$threadId', params: { channelId, threadId: thread.id }, replace: true });
        }}
      />
    </div>
  );
}
