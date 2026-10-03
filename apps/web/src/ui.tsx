// Building blocks for the Inbox screens.
import { ACCESS, EFFORTS, MODELS, type Access, type Channel, type NewMessage, type Status } from '@acocrew/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FolderGit2,
  Menu,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
} from 'lucide-react';
import { useApp } from './store';

export function Avatar({ agent }: { agent: boolean }) {
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
  waiting: { label: 'Waiting', text: 'text-sky-500 bg-sky-500/10', dot: 'bg-sky-500' },
  needs: { label: 'Needs you', text: 'text-rose-500 bg-rose-500/10', dot: 'bg-rose-500' },
  done: { label: 'Done', text: 'text-emerald-500 bg-emerald-500/10', dot: 'bg-emerald-500' },
};
export const STATUS_ORDER: Status[] = ['needs', 'working', 'waiting', 'done'];
export const statusLabel = (s: Status) => STATUS[s].label;

export function StatusDot({ status }: { status: Status }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${STATUS[status].dot}`} />;
}

export function StatusBadge({ status }: { status: Status }) {
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
  // On phones there is no room for every label, so some pickers show only their icon there.
  iconOnPhone?: boolean;
};

function Picker({ icon, value, options, onChange, menuClass = 'left-0', iconOnPhone }: PickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {icon}
        <span className={iconOnPhone ? 'hidden sm:inline' : 'max-w-24 truncate sm:max-w-none'}>
          {options.find((o) => o.id === value)?.name}
        </span>
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

// What the user picked for the next message: which model, how hard it thinks, and whether it asks first.
export type Settings = Pick<NewMessage, 'model' | 'effort' | 'access'>;

type ComposerProps = {
  placeholder: string;
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onSend: (text: string) => Promise<unknown>;
  // Send works with an empty box too (a picked answer to a question needs no typing).
  canSendEmpty?: boolean;
  // Given while Claude is doing something that can be stopped.
  onStop?: () => void;
  autoFocus?: boolean;
};

export function Composer({
  placeholder,
  settings,
  onSettings,
  onSend,
  canSendEmpty,
  onStop,
  autoFocus,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const clean = text.trim();
  const ready = Boolean(clean || canSendEmpty) && !sending;
  // The text stays in the box until the server has taken it, so a failed send loses nothing.
  const submit = async () => {
    if (!ready) return;
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
          value={settings.model}
          options={MODELS}
          onChange={(model) => onSettings({ ...settings, model })}
        />
        {/* nudged left on phones so the menus stay on screen */}
        <Picker
          icon={<Brain size={14} />}
          value={settings.effort}
          options={EFFORTS}
          onChange={(effort) => onSettings({ ...settings, effort })}
          menuClass="-left-20 sm:left-0"
          iconOnPhone
        />
        <Picker
          icon={<ShieldCheck size={14} />}
          value={settings.access}
          options={ACCESS}
          onChange={(access) => onSettings({ ...settings, access: access as Access })}
          menuClass="-left-32 sm:left-0"
          iconOnPhone
        />
        <div className="flex-1" />
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop Claude"
            className="mr-1 grid size-8 place-items-center rounded-full bg-rose-500/10 text-rose-500 hover:bg-rose-500/20"
          >
            <Square size={13} fill="currentColor" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!ready}
          aria-label="Send"
          className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
        >
          <ArrowUp size={16} />
        </button>
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
  const [settings, setSettings] = useState<Settings>({ model: MODELS[0].id, effort: 'high', access: 'full' });
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
        settings={settings}
        onSettings={setSettings}
        onSend={async (text) => {
          const thread = await createThread({ channelId, text, ...settings });
          void navigate({ to: '/c/$channelId/t/$threadId', params: { channelId, threadId: thread.id }, replace: true });
        }}
      />
    </div>
  );
}
