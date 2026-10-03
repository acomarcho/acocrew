// Building blocks for the Inbox screens.
import { EFFORTS, MODELS, type Channel, type Item, type Status, type Thread } from '@acocrew/shared';
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
      className="-ml-1 rounded-md p-1.5 text-muted hover:bg-soft md:hidden"
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
        className={`absolute inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col bg-side text-side-fg transition-transform md:static md:translate-x-0 ${
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
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-soft hover:text-fg"
      >
        {icon}
        <span className="max-w-28 truncate sm:max-w-none">{options.find((o) => o.id === value)?.name}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={`absolute bottom-full z-50 mb-1 w-52 rounded-lg border border-line bg-surface p-1 text-fg shadow-xl ${menuClass}`}
          >
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-soft"
              >
                <span className="flex-1">
                  <span className="block">{o.name}</span>
                  <span className="block text-xs text-muted">{o.hint}</span>
                </span>
                {o.id === value && <Check size={14} className="text-accent" />}
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
    <div className="rounded-xl border border-line bg-surface shadow-sm focus-within:border-accent">
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
        className="block w-full resize-none bg-transparent px-3.5 pt-3 text-base text-fg outline-none placeholder:text-muted md:text-sm"
      />
      {error && <p className="px-3.5 pb-1 text-xs text-rose-500">{error}</p>}
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        <Picker
          icon={<Sparkles size={14} className="text-accent" />}
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
          className="grid size-8 place-items-center rounded-full bg-accent text-accent-fg disabled:opacity-40"
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function ItemView({ item }: { item: Item }) {
  if (item.kind === 'tool') {
    return (
      <div className="py-1 pr-4 pl-16">
        <div className="flex items-center gap-2 rounded-md border border-line bg-soft px-2.5 py-1.5 text-xs">
          {!item.done && <LoaderCircle size={13} className="shrink-0 animate-spin text-muted" />}
          {item.done && !item.failed && <Check size={13} className="shrink-0 text-emerald-500" />}
          {item.failed && <X size={13} className="shrink-0 text-rose-500" />}
          <span className="font-medium">{item.name}</span>
          <span className="truncate font-mono text-muted">{item.detail}</span>
        </div>
      </div>
    );
  }
  if (item.kind === 'error') {
    return (
      <div className="py-1 pr-4 pl-16">
        <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-sm whitespace-pre-wrap text-rose-500">
          {item.text}
        </p>
      </div>
    );
  }
  const agent = item.by === 'claude';
  return (
    <div className="flex gap-3 px-4 py-2">
      <Avatar agent={agent} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{agent ? 'Claude' : 'You'}</span>
          {agent && <span className="rounded bg-accent/15 px-1.5 text-[11px] font-medium text-accent">Agent</span>}
          <span className="text-xs text-muted">{clock(item.at)}</span>
        </div>
        <p className="mt-1 leading-relaxed break-words whitespace-pre-wrap">{item.text}</p>
      </div>
    </div>
  );
}

function Working() {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm text-muted">
      <Avatar agent />
      <span>Claude is working</span>
      <span className="flex gap-1">
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="size-1.5 animate-bounce rounded-full bg-muted"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </span>
    </div>
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
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Link
          to="/c/$channelId"
          params={{ channelId: channel.id }}
          className="-ml-1 rounded-md p-1.5 text-muted hover:bg-soft md:hidden"
          aria-label="Back"
        >
          <ChevronLeft size={20} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{thread.title}</div>
          <div className="truncate font-mono text-xs text-muted">{channel.path}</div>
        </div>
        <StatusBadge status={thread.status} />
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto py-3">
        {items?.map((item) => (
          <ItemView key={item.id} item={item} />
        ))}
        {thread.status === 'working' && <Working />}
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
      className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-accent-fg hover:opacity-90"
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
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted">
        <FolderGit2 size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          New thread in <b className="text-fg">#{channel.name}</b>. Claude works right in{' '}
          <span className="font-mono">{channel.path}</span>.
        </span>
        <Link to="/c/$channelId" params={{ channelId }} className="rounded px-1.5 py-0.5 hover:bg-soft hover:text-fg">
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
