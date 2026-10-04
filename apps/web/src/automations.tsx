// Automations: a message that is sent in a fresh thread of a repository at set times.
import { MODELS, VISIBILITY, type Automation, type Channel, type Schedule, type Visibility } from '@acocrew/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronLeft, Clock, FolderGit2, GitBranch, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useCommands } from './commands';
import { deleteAutomation, runAutomation, saveAutomation, useApp, useMe } from './store';
import {
  branchOption,
  Composer,
  NEW_THREAD,
  Picker,
  Popup,
  PrivateMark,
  Section,
  ThreadRow,
  usePlaces,
  VisibilityPicker,
  when,
  type Settings,
} from './ui';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [0, 1, 2, 3, 4];
const same = (a: number[], b: number[]) => a.length === b.length && a.every((day) => b.includes(day));

// Days of the week in words: "Weekdays".
function daysOf(days: number[]) {
  if (same(days, EVERY_DAY)) return 'Every day';
  if (same(days, WEEKDAYS)) return 'Weekdays';
  if (same(days, [5, 6])) return 'Weekends';
  return days.map((day) => DAYS[day]).join(', ') || 'No day picked';
}

// A time of day in words: "9:00 AM". It is counted in minutes since midnight. Minutes before midnight or
// after the day is over give the time on the day before or after.
const clockOf = (minutes: number) =>
  new Date(2000, 0, 1, 0, minutes).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

// The name of a clock that is `utcOffset` minutes ahead of UTC: "UTC", "UTC+7", "UTC-3:30".
export function zoneName(utcOffset: number) {
  if (!utcOffset) return 'UTC';
  const hours = Math.floor(Math.abs(utcOffset) / 60);
  const minutes = Math.abs(utcOffset) % 60;
  return `UTC${utcOffset < 0 ? '-' : '+'}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

// A schedule in words, on the server's clock: "Weekdays at 9:00 AM UTC".
export const describe = ({ time, days }: Schedule, utcOffset: number) =>
  `${daysOf(days)} at ${clockOf(minutesOf(time))} ${zoneName(utcOffset)}`;

// What goes behind that for a reader whose own clock is another one: " (4:00 PM your time)". Past midnight
// the days move along with the time, and are said too: " (Tue at 3:00 AM your time)".
export function inYourTime({ time, days }: Schedule, utcOffset: number, own = -new Date().getTimezoneOffset()) {
  if (own === utcOffset) return '';
  const theirs = minutesOf(time) + own - utcOffset;
  const daysOn = Math.floor(theirs / (24 * 60));
  const moved = days.map((day) => (day + daysOn + 7) % 7).sort();
  return ` (${same(moved, days) ? '' : `${daysOf(moved)} at `}${clockOf(theirs)} your time)`;
}

// The name an automation goes by: the first line of what it sends.
const titleOf = (automation: Automation) => automation.text.split('\n')[0];

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Automation on"
      title={on ? 'On. Click to pause' : 'Paused. Click to turn on'}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-muted-foreground/40'}`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  );
}

// A time, and the days of the week it counts on.
function SchedulePicker({ time, days, onChange }: Schedule & { onChange: (next: Schedule) => void }) {
  const flip = (day: number) =>
    onChange({ time, days: days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort() });
  const preset = 'rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <label className="flex items-center gap-1.5 text-muted-foreground">
        <Clock size={14} />
        <input
          type="time"
          aria-label="Time"
          value={time}
          onChange={(e) => e.target.value && onChange({ time: e.target.value, days })}
          className="rounded-md border border-border bg-card px-2 py-1 text-base text-foreground md:text-sm"
        />
      </label>
      <div className="flex gap-1">
        {DAYS.map((name, day) => (
          <button
            key={name}
            type="button"
            aria-pressed={days.includes(day)}
            onClick={() => flip(day)}
            className={`h-7 w-10 rounded-full border text-xs font-medium ${
              days.includes(day)
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="flex gap-0.5">
        <button type="button" className={preset} onClick={() => onChange({ time, days: EVERY_DAY })}>
          Every day
        </button>
        <button type="button" className={preset} onClick={() => onChange({ time, days: WEEKDAYS })}>
          Weekdays
        </button>
      </div>
    </div>
  );
}

const KINDS = [
  { id: 'thread', name: 'Start a thread', hint: 'Runs once, right now' },
  { id: 'automation', name: 'Schedule an automation', hint: 'Sends this in a fresh thread, again and again' },
] as const;
export type Kind = (typeof KINDS)[number]['id'];

// The title of the start screen, which is also the dropdown that says what is being started.
export function KindTitle({ kind, onKind }: { kind: Kind; onKind: (kind: Kind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <h2 className="text-xl font-bold">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="-ml-1.5 flex items-center gap-1.5 rounded-md px-1.5 hover:bg-muted"
        >
          {KINDS.find((option) => option.id === kind)!.name}
          <ChevronDown size={18} className="text-muted-foreground" />
        </button>
      </h2>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute top-full left-0 z-50 mt-1 w-80 max-w-[85vw] rounded-lg border border-border bg-card p-1 shadow-xl"
          >
            {KINDS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onKind(option.id);
                  setOpen(false);
                }}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                {option.name}
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type EditorProps = {
  channel: Channel;
  // The automation being changed. Without one, a new automation is made.
  automation?: Automation;
  title: ReactNode;
  onDone: (saved: Automation) => void;
  onCancel: () => void;
};

// Making or changing an automation, in the same message box a thread is started with.
export function AutomationEditor({ channel, automation, title, onDone, onCancel }: EditorProps) {
  const me = useMe();
  const utcOffset = useApp((state) => state.utcOffset);
  const commands = useCommands(`channel=${channel.id}`);
  // Who sees it, and each thread it starts from now on. Only whoever made it can change that.
  const [visibility, setVisibility] = useState<Visibility>(automation?.visibility ?? 'private');
  const mine = !automation || automation.createdBy === me.id;
  const branches = usePlaces(channel.id).branches.map(branchOption);
  // Each piece of state holds only its own parts of the automation. What is saved is put together from them,
  // so a part that one of them should not have would overwrite another's.
  const { time, days, model, effort, context, fast, access } = automation ?? {
    ...NEW_THREAD,
    time: '09:00',
    days: WEEKDAYS,
  };
  const [schedule, setSchedule] = useState<Schedule>({ time, days });
  const [settings, setSettings] = useState<Settings>({ model, effort, context, fast, access });
  // Until one is picked, a new automation starts from the first branch.
  const [picked, setPicked] = useState(automation?.from);
  const from = picked ?? branches[0]?.id;
  return (
    <div>
      {title}
      <div className="mt-1 -ml-2 flex items-center text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5 px-2 py-1.5">
          <GitBranch size={14} />
          New worktree
        </span>
        {from && (
          <Picker
            icon={<span className="opacity-70">from</span>}
            value={from}
            options={branches}
            onChange={setPicked}
            search="Search branches"
            menuClass="-left-32 sm:left-0"
            down
          />
        )}
        {mine && <VisibilityPicker value={visibility} onChange={setVisibility} down />}
      </div>
      <div className="mt-1 mb-3">
        <SchedulePicker {...schedule} onChange={setSchedule} />
      </div>
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <FolderGit2 size={12} className="shrink-0" />
        <span className="min-w-0 flex-1">
          {describe(schedule, utcOffset)}
          {inYourTime(schedule, utcOffset)}, this is sent in a fresh thread in{' '}
          <b className="text-foreground">#{channel.name}</b>. A run is skipped if the server is off at that time.
        </span>
        <button type="button" onClick={onCancel} className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground">
          Cancel
        </button>
      </div>
      <Composer
        autoFocus
        noImages
        placeholder="What should Claude do each time?"
        initialText={automation?.text}
        sendLabel={automation ? 'Save' : 'Schedule'}
        settings={settings}
        onSettings={setSettings}
        commands={commands}
        onSend={async (text) => {
          if (!schedule.days.length) throw new Error('Pick at least one day.');
          if (!from) throw new Error('Pick a branch to start from.');
          const body = { channelId: channel.id, text, from, visibility, ...schedule, ...settings, on: automation?.on };
          onDone(await saveAutomation(body, automation?.id));
        }}
      />
    </div>
  );
}

// The automations of a repository, above its threads. They start folded away.
export function AutomationSection({ channelId }: { channelId: string }) {
  const automations = useApp((state) => state.automations);
  const utcOffset = useApp((state) => state.utcOffset);
  const mine = automations.filter((automation) => automation.channelId === channelId);
  return (
    <Section
      title="Automations"
      count={mine.length}
      startFolded
      short
      action={
        <Link
          to="/c/$channelId/new"
          params={{ channelId }}
          search={{ kind: 'automation' }}
          aria-label="New automation"
          title="New automation"
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus size={15} />
        </Link>
      }
    >
      {mine.map((automation) => (
        <Link
          key={automation.id}
          to="/c/$channelId/a/$automationId"
          params={{ channelId, automationId: automation.id }}
          className={`flex items-center gap-2 border-b border-border px-3.5 py-2 hover:bg-muted ${automation.on ? '' : 'opacity-60'}`}
          activeProps={{ className: 'bg-muted' }}
        >
          <Clock size={14} className={`shrink-0 ${automation.on ? 'text-primary' : 'text-muted-foreground'}`} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <span className="truncate">{titleOf(automation)}</span>
              <PrivateMark visibility={automation.visibility} />
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {describe(automation, utcOffset)}
              {!automation.on && ' · Paused'}
            </span>
          </span>
        </Link>
      ))}
    </Section>
  );
}

const ACTION =
  'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted';

// One automation: what it sends and when, what can be done with it, and the threads it started.
export function AutomationPage({ channel, automation }: { channel: Channel; automation: Automation }) {
  const threads = useApp((state) => state.threads);
  const utcOffset = useApp((state) => state.utcOffset);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const channelId = channel.id;
  // One thing at a time, so that a double click on "Run now" starts one thread. Whatever goes wrong is said
  // under the buttons.
  const [busy, setBusy] = useState(false);
  const act = (what: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    what()
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  if (editing) {
    return (
      <div className="flex h-full flex-col justify-end p-3 md:justify-center md:p-10">
        <div className="mx-auto w-full max-w-2xl">
          <AutomationEditor
            channel={channel}
            automation={automation}
            title={<h2 className="text-xl font-bold">Edit automation</h2>}
            onDone={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        </div>
      </div>
    );
  }
  const runs = threads
    .filter((thread) => thread.automationId === automation.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const model = MODELS.find((option) => option.id === automation.model)?.name;
  return (
    <div className="h-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center gap-2">
          <Link
            to="/c/$channelId"
            params={{ channelId }}
            className="-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted md:hidden"
            aria-label="Back"
          >
            <ChevronLeft size={20} />
          </Link>
          <Clock size={20} className="shrink-0 text-primary max-md:hidden" />
          <h2 className="min-w-0 flex-1 truncate text-xl font-bold">{titleOf(automation)}</h2>
          <span className="text-sm text-muted-foreground">{automation.on ? 'On' : 'Paused'}</span>
          <Toggle
            on={automation.on}
            onChange={() => act(() => saveAutomation({ ...automation, on: !automation.on }, automation.id))}
          />
        </div>
        <p className="mt-1 text-sm">
          <b className="font-medium">{describe(automation, utcOffset)}</b>
          <span className="text-muted-foreground">
            {inYourTime(automation, utcOffset)} · {automation.nextAt ? `Next run ${when(automation.nextAt)}` : 'Paused'}{' '}
            · {model} · from {automation.from} ·{' '}
            {VISIBILITY.find((option) => option.id === automation.visibility)!.name}
          </span>
        </p>
        <p className="mt-4 rounded-lg border border-border bg-card p-3 text-sm break-words whitespace-pre-wrap">
          {automation.text}
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" className={ACTION} onClick={() => setEditing(true)}>
            <Pencil size={14} /> Edit
          </button>
          <button
            type="button"
            className={`${ACTION} disabled:opacity-50`}
            disabled={busy}
            onClick={() =>
              act(async () => {
                const thread = await runAutomation(automation.id);
                await navigate({ to: '/c/$channelId/t/$threadId', params: { channelId, threadId: thread.id } });
              })
            }
          >
            <Play size={14} /> Run now
          </button>
          <div className="flex-1" />
          <button type="button" className={`${ACTION} text-rose-600`} onClick={() => setAsking(true)}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
        <h3 className="mt-7 mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Threads it started ({runs.length})
        </h3>
        <div className="overflow-hidden rounded-lg border border-border">
          {runs.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} />
          ))}
          {runs.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">It has not run yet.</p>}
        </div>
      </div>
      {asking && (
        <Popup title="Delete this automation?">
          <p className="text-sm text-muted-foreground">It will not run again. The threads it already started stay.</p>
          <div className="flex justify-end gap-2">
            <button type="button" autoFocus className={ACTION} onClick={() => setAsking(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90"
              onClick={() => {
                setAsking(false);
                // The page closes by itself once the server says the automation is gone.
                act(() => deleteAutomation(automation.id));
              }}
            >
              Delete
            </button>
          </div>
        </Popup>
      )}
    </div>
  );
}
