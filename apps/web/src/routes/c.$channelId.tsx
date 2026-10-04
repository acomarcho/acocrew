// The Inbox screen: channels, then a thread list, then the open thread, like an email app.
import type { Channel } from '@acocrew/shared';
import { DragDropProvider, KeyboardSensor, PointerSensor } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import { createFileRoute, Link, Navigate, Outlet, useChildMatches } from '@tanstack/react-router';
import { Hash, ListFilter, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { draftsIn, useDrafts } from '../drafts';
import { needsYou, orderChannels, pinnedOf, setNavOpen, useApp, useMe } from '../store';
import { AutomationSection } from '../automations';
import {
  DraftRows,
  Drawer,
  NavButton,
  NewThreadButton,
  Picker,
  Section,
  statusLabel,
  ThreadRow,
  UserMenu,
} from '../ui';

export const Route = createFileRoute('/c/$channelId')({ component: Inbox });

// Space picks a repository up with the keyboard. Enter is left alone so that it still opens the repository.
const SENSORS = [
  PointerSensor,
  KeyboardSensor.configure({ keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ['Space'] } }),
];

// One repository in the sidebar. It can be dragged to another place in the list.
function Repo({ channel, index }: { channel: Channel; index: number }) {
  const threads = useApp((state) => state.threads);
  const seen = useApp((state) => state.seen);
  const me = useMe();
  const { ref, isDragging } = useSortable({ id: channel.id, index });
  const here = threads.filter((t) => t.channelId === channel.id);
  // The number is what waits for this person. Claude being busy only gets a small dot.
  const count = here.filter((t) => needsYou(t, seen, me.id)).length;
  const busy = here.filter((t) => t.since).length;
  return (
    <Link
      ref={ref}
      to="/c/$channelId"
      params={{ channelId: channel.id }}
      onClick={() => setNavOpen(false)}
      // Something that can be dragged is called a button unless it says what it is.
      role="link"
      // Without this an iPhone answers a long press with a preview of the link.
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 [-webkit-touch-callout:none] ${
        isDragging ? 'cursor-grabbing shadow-lg ring-1 ring-border' : ''
      }`}
      activeProps={{ className: 'bg-sidebar-primary text-sidebar-primary-foreground' }}
      inactiveProps={{ className: isDragging ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent' }}
    >
      <Hash size={15} className="opacity-60" />
      <span className="flex-1 truncate">{channel.name}</span>
      {busy > 0 && (
        <span
          title={`Claude is busy in ${busy} ${busy === 1 ? 'thread' : 'threads'}`}
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500"
        />
      )}
      {count > 0 && (
        <span
          title={`${count} ${count === 1 ? 'thread needs' : 'threads need'} you`}
          className="shrink-0 rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums"
        >
          {count}
        </span>
      )}
    </Link>
  );
}

// The two things the list can be narrowed by: whose threads, and in which state.
const WHOSE = [
  { id: 'all', name: 'All threads', hint: "Everyone's" },
  { id: 'mine', name: 'Yours', hint: 'You started it or wrote in it' },
];
// 'you' is only the threads that need this person, which covers the ones where Claude waits for an answer.
const STATES = [
  { id: 'all', name: 'Any state', hint: 'Nothing is left out' },
  { id: 'you', name: 'Needs you', hint: 'Your answer, or new to you' },
  { id: 'working', name: statusLabel('working'), hint: 'Claude is at it' },
  { id: 'waiting', name: statusLabel('waiting'), hint: 'Background work is running' },
  { id: 'failed', name: statusLabel('failed'), hint: 'Broke off with an error' },
  { id: 'done', name: statusLabel('done'), hint: 'Nothing going on' },
];

function Inbox() {
  const { channelId } = Route.useParams();
  const channels = useApp((state) => state.channels);
  const threads = useApp((state) => state.threads);
  const seen = useApp((state) => state.seen);
  const me = useMe();
  const [whose, setWhose] = useState('all');
  const [state, setState] = useState('all');
  // How many threads this person began here and has not sent yet.
  const drafts = useDrafts((state) => draftsIn(state.drafts, channelId).length);
  // On phones the list and the detail take turns. The detail shows when a thread or "new" is open.
  const detailOpen = useChildMatches({ select: (matches) => matches.some((m) => m.routeId !== '/c/$channelId/') });
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) return <Navigate to="/" replace />;
  const rows = threads
    .filter((t) => t.channelId === channel.id)
    .filter((t) => state === 'all' || (state === 'you' ? needsYou(t, seen, me.id) : t.status === state))
    .filter((t) => whose === 'all' || t.people.includes(me.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // Pinned threads get a part of their own, and are not repeated under the rest.
  const pinned = pinnedOf(rows);
  const rest = rows.filter((t) => t.pinnedAt === null);

  return (
    <div className="relative flex h-full overflow-hidden">
      <Drawer className="md:w-56 md:border-r md:border-border">
        <div className="px-4 py-3.5 text-lg font-bold">acocrew</div>
        <div className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-sidebar-muted">Repositories</div>
        <DragDropProvider
          sensors={SENSORS}
          onDragEnd={({ canceled, operation: { source } }) => {
            if (canceled || !isSortable(source) || source.index === source.initialIndex) return;
            const ids = channels.map((c) => c.id);
            ids.splice(source.index, 0, ...ids.splice(source.initialIndex, 1));
            orderChannels(ids);
          }}
        >
          {/* The space at the sides is kept off the rows, so that a row stays under the finger while dragged. */}
          <div className="px-2">
            {channels.map((c, index) => (
              <Repo key={c.id} channel={c} index={index} />
            ))}
          </div>
        </DragDropProvider>
        <Link
          to="/add"
          onClick={() => setNavOpen(false)}
          className="mx-2 mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sidebar-muted hover:bg-sidebar-accent"
        >
          <Plus size={15} />
          Add repository
        </Link>
        <UserMenu />
      </Drawer>

      <section
        className={`w-full min-w-0 flex-col border-border md:flex md:w-[360px] md:shrink-0 md:border-r ${detailOpen ? 'hidden' : 'flex'}`}
      >
        <header className="flex items-center gap-2 px-3 py-2.5">
          <NavButton />
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">#{channel.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{channel.path}</div>
          </div>
          <NewThreadButton channelId={channel.id} iconOnly />
        </header>
        {/* Two filters side by side: whose threads, then in which state. */}
        <div className="flex items-center gap-1 border-b border-border px-1.5 pb-1.5">
          <Picker icon={<Users size={14} />} value={whose} options={WHOSE} onChange={setWhose} down fullLabel />
          <span className="h-4 w-px shrink-0 bg-border" />
          <Picker icon={<ListFilter size={14} />} value={state} options={STATES} onChange={setState} down fullLabel />
        </div>
        {/* A list of its own per repository, so that what was folded or scrolled in one does not carry over. */}
        <div key={channel.id} className="min-h-0 flex-1 overflow-y-auto">
          <AutomationSection channelId={channel.id} />
          {/* Not there when everything begun was sent. */}
          {drafts > 0 && (
            <Section title="Drafts" count={drafts} short>
              <DraftRows channelId={channel.id} />
            </Section>
          )}
          {/* Not there when nothing is pinned. */}
          {pinned.length > 0 && (
            <Section title="Pinned" count={pinned.length} short>
              {pinned.map((t) => (
                <ThreadRow key={t.id} thread={t} />
              ))}
            </Section>
          )}
          <Section title="Threads" count={rest.length}>
            {rest.map((t) => (
              <ThreadRow key={t.id} thread={t} />
            ))}
            {rest.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">Nothing here.</p>}
          </Section>
        </div>
      </section>

      <section className={`min-w-0 flex-1 flex-col md:flex ${detailOpen ? 'flex' : 'hidden'}`}>
        <Outlet />
      </section>
    </div>
  );
}
