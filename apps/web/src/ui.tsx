// Building blocks for the Inbox screens.
import {
  ACCESS,
  CONTEXTS,
  EFFORTS,
  MODELS,
  VISIBILITY,
  type Access,
  type Channel,
  type Command,
  type NewMessage,
  type Person,
  type Places,
  type Status,
  type Thread,
  type Visibility,
} from '@acocrew/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Clock,
  FolderGit2,
  GitBranch,
  Globe,
  ImagePlus,
  Layers,
  LoaderCircle,
  Lock,
  LogOut,
  Menu,
  Pin,
  Plus,
  Search,
  Settings as Cog,
  ShieldCheck,
  Sparkles,
  Square,
  X,
  Zap,
} from 'lucide-react';
import { CommandMenu, suggest, useCommands } from './commands';
import { imageUrl, uploadImage } from './images';
import { needsYou, request, useApp } from './store';

// Each person keeps one of these colors everywhere, worked out from their id.
const COLORS = [
  'bg-indigo-500',
  'bg-sky-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-teal-500',
  'bg-fuchsia-500',
];
const colorOf = (id: string) => COLORS[[...id].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % COLORS.length];

// Claude's picture, or a person's: the first letter of their name on their color.
export function Avatar({ agent, person, small }: { agent?: boolean; person?: Person; small?: boolean }) {
  const color = agent ? 'bg-[#d97757]' : person ? colorOf(person.id) : 'bg-muted-foreground';
  return (
    <div
      title={agent ? 'Claude' : person?.name}
      className={`grid shrink-0 place-items-center font-semibold text-white uppercase ${color} ${
        small ? 'size-6 rounded-md text-xs' : 'size-9 rounded-lg'
      }`}
    >
      {agent ? <Sparkles size={18} /> : (person?.name[0] ?? '?')}
    </div>
  );
}

// How many faces a stack shows before the rest becomes a number.
const STACK = 4;

// The people who wrote in a thread, as overlapping pictures.
export function AvatarStack({ ids }: { ids: string[] }) {
  const { people } = useApp();
  const faces = ids.flatMap((id) => people.find((person) => person.id === id) ?? []);
  return (
    <span className="flex shrink-0 items-center -space-x-1.5">
      {faces.slice(0, STACK).map((person) => (
        <span key={person.id} className="rounded-lg ring-2 ring-background">
          <Avatar person={person} small />
        </span>
      ))}
      {faces.length > STACK && <span className="pl-3 text-xs text-muted-foreground">+{faces.length - STACK}</span>}
    </span>
  );
}

// Who is logged in, at the bottom of the sidebar. Opens a small menu with Settings and Log out.
export function UserMenu() {
  const { me, logOut, setNavOpen } = useApp();
  const [open, setOpen] = useState(false);
  const row = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted';
  return (
    <div className="relative mt-auto border-t border-white/10 p-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Your account"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent"
      >
        <Avatar person={me} small />
        <span className="min-w-0 flex-1 truncate font-medium">{me.name}</span>
        <ChevronDown size={14} className="shrink-0 rotate-180 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-2 bottom-full z-50 mb-1 rounded-lg border border-border bg-card p-1 text-foreground shadow-xl">
            <div className="truncate px-2 py-1 text-xs text-muted-foreground">@{me.username}</div>
            <Link to="/settings" onClick={() => setNavOpen(false)} className={row}>
              <Cog size={15} className="text-muted-foreground" />
              Settings
            </Link>
            <button type="button" onClick={() => void logOut()} className={row}>
              <LogOut size={15} className="text-muted-foreground" />
              Log out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const STATUS: Record<Status, { label: string; color: string; tint: string; dot: string }> = {
  working: { label: 'Working', color: 'text-amber-600', tint: 'bg-amber-500/10', dot: 'bg-amber-500 animate-pulse' },
  waiting: { label: 'Waiting', color: 'text-sky-600', tint: 'bg-sky-500/10', dot: 'bg-sky-500' },
  needs: { label: 'Needs an answer', color: 'text-rose-600', tint: 'bg-rose-500/10', dot: 'bg-rose-500' },
  failed: { label: 'Failed', color: 'text-rose-600', tint: 'bg-rose-500/10', dot: 'bg-rose-500' },
  done: { label: 'Done', color: 'text-emerald-600', tint: 'bg-emerald-500/10', dot: 'bg-emerald-500' },
};
export const statusLabel = (s: Status) => STATUS[s].label;
export const statusColor = (s: Status) => STATUS[s].color;

// How long something took, or has been taking. `label` is a word to go before it. Without one, short things
// show nothing.
type ElapsedProps = { from: number; to?: number; label?: string; className?: string };
export function Elapsed({ from, to, label = '', className = '' }: ElapsedProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (to) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [to]);
  // Never below zero, also when this device's clock is behind the server's.
  const seconds = Math.max(0, Math.floor(((to ?? now) - from) / 1000));
  if (!label && seconds < (to ? 1 : 3)) return null;
  const two = (n: number) => String(n % 60).padStart(2, '0');
  const minutes = Math.floor(seconds / 60);
  let text = `${seconds}s`;
  if (minutes >= 1) text = `${minutes}m ${two(seconds)}s`;
  if (minutes >= 60) text = `${Math.floor(minutes / 60)}h ${two(minutes)}m`;
  return (
    <span className={`shrink-0 tabular-nums ${className}`}>
      {label && `${label} `}
      {text}
    </span>
  );
}

export function StatusDot({ status }: { status: Status }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${STATUS[status].dot}`} />;
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[status].color} ${STATUS[status].tint}`}
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

// An attached image, shown small. A click opens it big over the page. Escape closes that (the browser does
// this for a dialog), and so does a click on the close button or anywhere beside the image.
export function Picture({ id, className }: { id: string; className: string }) {
  const popup = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" onClick={() => popup.current?.showModal()} aria-label="View image" className="block">
        <img src={imageUrl(id)} alt="" className={`cursor-zoom-in rounded-md border border-border ${className}`} />
      </button>
      {/* Covers the whole screen, so a click that misses the image lands on it. */}
      <dialog
        ref={popup}
        onClick={() => popup.current?.close()}
        className="size-full max-h-none max-w-none items-center justify-center bg-black/80 p-4 open:flex"
      >
        <img
          src={imageUrl(id)}
          alt="Attached image"
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full rounded-md object-contain"
        />
        <button
          type="button"
          aria-label="Close"
          className="absolute top-3 right-3 grid size-9 place-items-center rounded-full bg-black/60 text-white hover:bg-black"
        >
          <X size={18} />
        </button>
      </dialog>
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
  // The menu opens under the button. Without this it opens above, as in the message box.
  down?: boolean;
  // There is no room for every label, so some pickers show only their icon: on phones, or everywhere.
  labelClass?: string;
  // The label is short and has room, so it is not cut off on phones.
  fullLabel?: boolean;
  // For long lists: the menu gets a box to type in, which narrows the list. These words show in it while empty.
  search?: string;
};

const ICON_ON_PHONE = 'hidden sm:flex';

export function Picker({
  icon,
  value,
  options,
  onChange,
  menuClass = 'left-0',
  down,
  labelClass,
  fullLabel,
  search,
}: PickerProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const picked = options.find((o) => o.id === value)?.name;
  const words = typed.trim().toLowerCase();
  const shown = options.filter((o) => `${o.name} ${o.hint}`.toLowerCase().includes(words));
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setTyped('');
  };
  // A label that shows on phones and may be cut off is the one thing in a tight row that gives up width.
  const squeezes = !labelClass && !fullLabel;
  return (
    <div className={`relative ${squeezes ? 'min-w-0' : 'shrink-0'}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={picked}
        aria-label={picked}
        className="flex max-w-full items-center gap-1.5 rounded-md [&_svg]:shrink-0 px-2 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {icon}
        <span className={`min-w-0 items-center gap-1.5 ${labelClass ?? 'flex'}`}>
          <span className={fullLabel ? '' : 'max-w-20 truncate sm:max-w-none'}>{picked}</span>
          <ChevronDown size={14} />
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={`absolute z-50 rounded-lg border border-border bg-card p-1 text-foreground shadow-xl ${down ? 'top-full mt-1' : 'bottom-full mb-1'} ${search ? 'w-72' : 'w-52'} ${menuClass}`}
          >
            <div className="max-h-80 overflow-y-auto">
              {shown.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => pick(o.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{o.hint}</span>
                  </span>
                  {o.id === value && <Check size={14} className="shrink-0 text-primary" />}
                </button>
              ))}
              {shown.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">Nothing matches.</p>}
            </div>
            {/* Below the list, so it stays where it is while the list above it gets shorter. */}
            {search && (
              <label className="mt-1 flex items-center gap-2 border-t border-border px-2 pt-2 pb-1 text-muted-foreground">
                <Search size={14} className="shrink-0" />
                <input
                  autoFocus
                  value={typed}
                  placeholder={search}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && shown.length > 0 && pick(shown[0].id)}
                  className="w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm"
                />
              </label>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// A lock for what only some people see, a globe for what everyone does.
export function VisibilityIcon({ visibility, size = 14 }: { visibility: Visibility; size?: number }) {
  return visibility === 'private' ? <Lock size={size} /> : <Globe size={size} />;
}

// The small lock that a private thread or automation has in a list.
export function PrivateMark({ visibility }: { visibility: Visibility }) {
  if (visibility === 'public') return null;
  return (
    <span title="Private" className="shrink-0 text-muted-foreground">
      <Lock size={12} />
    </span>
  );
}

// Who sees a new thread or an automation. Shows only its icon on phones.
type VisibilityPickerProps = { value: Visibility; onChange: (visibility: Visibility) => void; down?: boolean };
export function VisibilityPicker({ value, onChange, down }: VisibilityPickerProps) {
  return (
    <Picker
      icon={<VisibilityIcon visibility={value} />}
      value={value}
      options={VISIBILITY}
      onChange={(visibility) => onChange(visibility as Visibility)}
      menuClass="-left-40 sm:left-0"
      labelClass={ICON_ON_PHONE}
      down={down}
    />
  );
}

// What the user picked for the next message: which model, how hard it thinks, how much it keeps in view,
// whether it runs in fast mode, and whether it asks first.
export type Settings = Omit<NewMessage, 'text' | 'images'>;

export const NEW_THREAD: Settings = {
  model: MODELS[0].id,
  effort: 'medium',
  context: '1m',
  fast: false,
  access: 'full',
};

const SPEEDS = [
  { id: 'off', name: 'Standard', hint: 'Normal speed and price' },
  { id: 'on', name: 'Fast', hint: 'Quicker answers, costs more' },
];

type ComposerProps = {
  placeholder: string;
  settings: Settings;
  onSettings: (settings: Settings) => void;
  onSend: (text: string, images: string[]) => Promise<unknown>;
  // What Claude can run, suggested while a `/name` is being typed.
  commands: Command[];
  // Send works with an empty box too (a picked answer to a question needs no typing).
  canSendEmpty?: boolean;
  // The box takes words only (an answer to Claude's question cannot carry images or run a command).
  textOnly?: boolean;
  // The box takes words and commands but no images.
  noImages?: boolean;
  // Given while Claude is doing something that can be stopped.
  onStop?: () => void;
  autoFocus?: boolean;
  // What the box holds to begin with, for changing something written before.
  initialText?: string;
  // The send button says this word instead of showing an arrow.
  sendLabel?: string;
};

export function Composer({
  placeholder,
  settings,
  onSettings,
  onSend,
  commands,
  canSendEmpty,
  textOnly,
  noImages = textOnly,
  onStop,
  autoFocus,
  initialText = '',
  sendLabel,
}: ComposerProps) {
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // Images are uploaded as soon as they are added. These are the ids the server gave back.
  // While the box takes words only, images added before are set aside until it takes them again.
  const [added, setImages] = useState<string[]>([]);
  const images = noImages ? [] : added;
  const [uploading, setUploading] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Where the typing caret was after the last change to the text, which row of the suggestions is lit, and
  // whether they were closed since that change (with Escape, by moving the caret or by leaving the box).
  const [caret, setCaret] = useState(0);
  const [lit, setLit] = useState(0);
  const [closed, setClosed] = useState(false);
  const menu = closed || textOnly ? null : suggest(commands, text, caret);
  const edited = () => {
    setText(box.current!.value);
    setCaret(box.current!.selectionStart);
    setLit(0);
    setClosed(false);
  };
  // Swaps the word the caret is in for the whole name, and leaves the caret after it.
  const pick = (command: Command) => {
    const end = caret + text.slice(caret).search(/\s|$/);
    box.current!.setRangeText(`/${command.name} `, menu!.start, end, 'end');
    // Told to the box the way typing is, so it is taken in like any other change.
    box.current!.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const clean = text.trim();
  const ready = Boolean(clean || images.length || canSendEmpty) && !sending && !uploading;
  // Pasting, dropping and the attach button all end up here. Whether this did anything with the files.
  const addImages = (files: Iterable<File>) => {
    const picked = noImages ? [] : [...files].filter((file) => file.type.startsWith('image/'));
    if (!picked.length) return false;
    setError('');
    setUploading((count) => count + 1);
    void Promise.allSettled(picked.map(uploadImage)).then((results) => {
      const ids = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      const failed = results.find((result) => result.status === 'rejected');
      setImages((list) => [...list, ...ids]);
      if (failed) setError(failed.reason.message);
      setUploading((count) => count - 1);
    });
    return true;
  };
  const model = MODELS.find((option) => option.id === settings.model);
  // The text stays in the box until the server has taken it, so a failed send loses nothing.
  const submit = async () => {
    if (!ready) return;
    setSending(true);
    setError('');
    try {
      await onSend(clean, images);
      setText('');
      setImages((list) => list.filter((id) => !images.includes(id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send.');
    }
    setSending(false);
  };
  return (
    <div
      className="relative rounded-xl border border-border bg-card shadow-sm focus-within:border-primary"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        // Always stopped, or the browser would leave the app to show the dropped file.
        e.preventDefault();
        addImages(e.dataTransfer.files);
      }}
    >
      {menu && <CommandMenu items={menu.items} active={lit} onActive={setLit} onPick={pick} />}
      {(images.length > 0 || uploading > 0) && (
        <div className="flex flex-wrap gap-2 px-3.5 pt-3">
          {images.map((id) => (
            <div key={id} className="relative">
              <Picture id={id} className="size-16 object-cover" />
              <button
                type="button"
                onClick={() => setImages(added.filter((other) => other !== id))}
                aria-label="Remove image"
                className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {uploading > 0 && (
            <div className="grid size-16 place-items-center rounded-md border border-border text-muted-foreground">
              <LoaderCircle size={16} className="animate-spin" />
            </div>
          )}
        </div>
      )}
      {/* Starts 2 lines tall and grows with the text up to 8 lines, then scrolls inside. The extra spacing(3) matches pt-3. */}
      <textarea
        ref={box}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        onChange={edited}
        onSelect={(e) => e.currentTarget.selectionStart !== caret && setClosed(true)}
        onBlur={() => setClosed(true)}
        onPaste={(e) => {
          // Spreadsheets and documents put a picture of the copied cells next to the formatted words. The
          // words win. A copied image file comes with its name as plain words only, and is still an image.
          if (e.clipboardData.getData('text/html') && e.clipboardData.getData('text/plain')) return;
          if (addImages(e.clipboardData.files)) e.preventDefault();
        }}
        onKeyDown={(e) => {
          // A key pressed while a word is being put together (Chinese, Japanese, Korean) belongs to that.
          if (e.nativeEvent.isComposing) return;
          // While suggestions are open, the keys that would move the caret or send the message work the list.
          const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
          const picks = (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey;
          if (menu && (step || picks || e.key === 'Escape')) {
            e.preventDefault();
            if (step) setLit((lit + step + menu.items.length) % menu.items.length);
            else if (picks) pick(menu.items[lit]);
            else setClosed(true);
            return;
          }
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault();
          void submit();
        }}
        className="block field-sizing-content max-h-[calc(8lh+--spacing(3))] min-h-[calc(2lh+--spacing(3))] w-full resize-none bg-transparent px-3.5 pt-3 text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm"
      />
      {error && <p className="px-3.5 pb-1 text-xs text-rose-500">{error}</p>}
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        {!noImages && (
          <>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addImages(e.target.files ?? []);
                // Cleared so that picking the same file again counts as a change.
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => picker.current?.click()}
              aria-label="Attach images"
              title="Attach images"
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ImagePlus size={15} />
            </button>
          </>
        )}
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
          labelClass={ICON_ON_PHONE}
        />
        {model?.bigContext && (
          <Picker
            icon={<Layers size={14} />}
            value={settings.context}
            options={CONTEXTS}
            onChange={(context) => onSettings({ ...settings, context })}
            menuClass="-left-28 sm:left-0"
            labelClass={ICON_ON_PHONE}
          />
        )}
        {model?.fast && (
          <Picker
            icon={<Zap size={14} className={settings.fast ? 'text-primary' : ''} />}
            value={settings.fast ? 'on' : 'off'}
            options={SPEEDS}
            onChange={(speed) => onSettings({ ...settings, fast: speed === 'on' })}
            menuClass="-left-36 sm:left-0"
            labelClass="hidden"
          />
        )}
        <Picker
          icon={<ShieldCheck size={14} />}
          value={settings.access}
          options={ACCESS}
          onChange={(access) => onSettings({ ...settings, access: access as Access })}
          menuClass="-left-40 sm:left-0"
          labelClass={ICON_ON_PHONE}
        />
        <div className="flex-1" />
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop Claude"
            className="mr-1 grid size-8 shrink-0 place-items-center rounded-full bg-rose-500/10 text-rose-500 hover:bg-rose-500/20"
          >
            <Square size={13} fill="currentColor" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!ready}
          aria-label={sendLabel ?? 'Send'}
          className={`shrink-0 rounded-full bg-primary text-primary-foreground disabled:opacity-40 ${sendLabel ? 'px-3.5 py-1.5 text-sm font-semibold' : 'grid size-8 place-items-center'}`}
        >
          {sendLabel ?? <ArrowUp size={16} />}
        </button>
      </div>
    </div>
  );
}

// `iconOnly` is for where room is tight: a small square with just the plus, as tall as the button with words.
export function NewThreadButton({ channelId, iconOnly }: { channelId: string; iconOnly?: boolean }) {
  // Without the words, hovering and screen readers still say what it does.
  const label = iconOnly ? 'New thread' : undefined;
  return (
    <Link
      to="/c/$channelId/new"
      params={{ channelId }}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:opacity-90 ${iconOnly ? 'size-9' : 'px-3.5 py-2'}`}
    >
      <Plus size={16} />
      {!iconOnly && 'New Thread'}
    </Link>
  );
}

// Where a new thread works.
const PLACES = [
  { id: 'new', name: 'New worktree', hint: 'A fresh copy, on a new branch' },
  { id: 'existing', name: 'Existing worktree', hint: 'Carry on where a thread left off' },
];

// What git has in a repository: the branches and worktrees a thread can start from. Empty until the server answers.
export function usePlaces(channelId: string) {
  const [places, setPlaces] = useState<Places>({ branches: [], worktrees: [] });
  useEffect(() => {
    request<Places>(`/api/channels/${channelId}/places`).then(setPlaces, () => {});
  }, [channelId]);
  return places;
}

// A branch as a row of a picker.
export const branchOption = ({ name, remote }: Places['branches'][number]) => ({
  id: name,
  name,
  hint: remote ? `On ${remote}. The newest commit is fetched first` : 'On this machine',
});

// The only way to post in a channel: start a thread. `title` goes where "Start a thread" would be.
export function NewThread({ channel, title }: { channel: Channel; title?: ReactNode }) {
  const { createThread, threads } = useApp();
  const navigate = useNavigate();
  const [settings, setSettings] = useState(NEW_THREAD);
  const [place, setPlace] = useState(PLACES[0].id);
  const [visibility, setVisibility] = useState<Visibility>('private');
  const channelId = channel.id;
  const commands = useCommands(`channel=${channelId}`);
  const places = usePlaces(channelId);
  const branches = places.branches.map(branchOption);
  // A worktree is easier to tell by what its last thread was about than by its branch. The worktrees used
  // last come first.
  const worktrees = places.worktrees
    .map(({ path, branch }) => {
      const last = threads
        .filter((thread) => thread.channelId === channelId && (thread.path ?? channel.path) === path)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const hint = path === channel.path ? 'The repository folder' : (last?.title ?? path);
      return { id: path, name: branch ?? path, hint, usedAt: last?.updatedAt ?? 0 };
    })
    .sort((a, b) => b.usedAt - a.usedAt);
  // Until something is picked, a new worktree starts from the first branch, and an existing one is the first.
  const [picked, setPicked] = useState<{ from?: string; path?: string }>({});
  const from = picked.from ?? branches[0]?.id;
  const path = picked.path ?? worktrees[0]?.id;
  const fresh = place === 'new';
  const list = fresh ? branches : worktrees;
  return (
    <div>
      {title ?? <h2 className="text-xl font-bold">Start a thread</h2>}
      {/* Pulled left so the first picker's words line up with the title above it. */}
      <div className="mt-1 mb-2 -ml-2 flex items-center">
        <Picker icon={<GitBranch size={14} />} value={place} options={PLACES} onChange={setPlace} fullLabel />
        {list.length > 0 && (
          <Picker
            key={place}
            icon={<span className="opacity-70">{fresh ? 'from' : 'on'}</span>}
            value={fresh ? from : path}
            options={list}
            onChange={(id) => setPicked(fresh ? { ...picked, from: id } : { ...picked, path: id })}
            search={fresh ? 'Search branches' : 'Search worktrees'}
            menuClass="-left-32 sm:left-0"
          />
        )}
        <VisibilityPicker value={visibility} onChange={setVisibility} />
      </div>
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <FolderGit2 size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          New thread in <b className="text-foreground">#{channel.name}</b>.
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
        commands={commands}
        onSend={async (text, images) => {
          const where = fresh ? { from } : { path };
          const thread = await createThread({ channelId, text, images, visibility, ...where, ...settings });
          void navigate({ to: '/c/$channelId/t/$threadId', params: { channelId, threadId: thread.id }, replace: true });
        }}
      />
    </div>
  );
}

// A moment as a short date and time.
export const when = (at: number) =>
  new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Pins the thread to the top of the list for everyone, or unpins it. Big enough for a finger.
export function PinButton({ thread, className = '' }: { thread: Thread; className?: string }) {
  const { pinThread } = useApp();
  const pinned = thread.pinnedAt !== null;
  const label = pinned ? 'Unpin' : 'Pin to the top of the list';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void pinThread(thread.id, !pinned).catch(() => {})}
      className={`grid size-9 shrink-0 place-items-center rounded-md hover:bg-muted ${
        pinned ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
      } ${className}`}
    >
      <Pin size={16} className={pinned ? 'fill-current' : ''} />
    </button>
  );
}

// One thread in the list. A thread that needs this person stands out. The others stay calm: one that Claude
// is busy in says for how long, and one with nothing new only keeps a hollow dot.
export function ThreadRow({ thread: t }: { thread: Thread }) {
  const { seen, me } = useApp();
  const flagged = needsYou(t, seen, me.id);
  const calm = !flagged && !t.since;
  const stopped = t.status === 'done' || t.status === 'failed';
  const pinned = t.pinnedAt !== null;
  return (
    <div className="relative">
      <Link
        to="/c/$channelId/t/$threadId"
        params={{ channelId: t.channelId, threadId: t.id }}
        className="block border-b border-border px-3.5 py-3 hover:bg-muted"
        activeProps={{ className: 'bg-muted' }}
        inactiveProps={{ className: flagged ? 'bg-primary/[0.07]' : '' }}
      >
        <span className={`flex items-center gap-2 ${pinned ? 'pr-8' : ''}`}>
          {calm ? (
            <span className="size-2 shrink-0 rounded-full border border-muted-foreground/50" />
          ) : (
            <StatusDot status={t.status} />
          )}
          <span className={`min-w-0 flex-1 truncate ${flagged ? 'font-semibold' : 'font-medium text-foreground/70'}`}>
            {t.title}
          </span>
          <PrivateMark visibility={t.visibility} />
          {t.automationId && (
            <span
              title="Started by an automation"
              className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              <Clock size={11} />
              Auto
            </span>
          )}
        </span>
        <span className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <AvatarStack ids={t.people} />
          {/* The branch the thread was last on. Nothing when it was on no branch. */}
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {t.branch && <GitBranch size={12} className="shrink-0" />}
            <span className="truncate font-mono">{t.branch}</span>
          </span>
          {/* What state it is in, in words, unless it just sits there finished. */}
          <span className={`shrink-0 ${calm ? '' : `font-medium ${statusColor(t.status)}`}`}>
            {t.since && <Elapsed from={t.since} label={statusLabel(t.status)} />}
            {t.status === 'needs' && (flagged ? 'Needs you' : statusLabel(t.status))}
            {stopped && (flagged || t.status === 'failed') && `${statusLabel(t.status)} · `}
            {stopped && when(t.updatedAt)}
          </span>
        </span>
      </Link>
      {/* A pinned thread can be unpinned right in the list. The button lies on the row: a link cannot hold one. */}
      {pinned && <PinButton thread={t} className="absolute top-1 right-1.5" />}
    </div>
  );
}

// A box on top of the page that has to be answered before anything else. It closes with its own buttons only.
export function Popup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={id}
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
    >
      <div className="w-full max-w-sm space-y-3 rounded-xl border border-border bg-card p-5 shadow-xl">
        <h3 id={id} className="font-semibold">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}
