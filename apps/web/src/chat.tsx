// What people write to each other in a thread. Claude never gets any of it.
import { TAG, type Chat, type Item, type Person, type Thread } from '@acocrew/shared';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUp, AtSign } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SuggestMenu, useSuggestions } from './commands';
import { editDraft, useDraft } from './drafts';
import { sendChat, useApp, useMe } from './store';
import { Avatar, BOX, SEND_KEYS, sends } from './ui';

// One row of a thread's timeline: something Claude or a person did there, or a chat message.
export type Entry = Item | ({ kind: 'chat' } & Chat);
export type Show = 'all' | 'claude' | 'people';

// Everything in a thread in the order it happened: what was said to and done by Claude, with what people wrote
// to each other in between. `show` leaves one of the two out.
export function timeline(items: Item[], chats: Chat[], show: Show): Entry[] {
  const said = chats.map((chat) => ({ kind: 'chat' as const, ...chat }));
  return [...(show === 'people' ? [] : items), ...(show === 'claude' ? [] : said)].sort((a, b) => a.at - b.at);
}

// Who sees a thread: everyone when it is public, otherwise whoever started it and the people it is shared
// with. The same rule the server has. People whose account is gone are left out.
export const peopleOf = (thread: Thread, people: Person[]) =>
  people.filter(
    (one) =>
      !one.deleted && (thread.visibility === 'public' || thread.createdBy === one.id || thread.shared.includes(one.id)),
  );

// Who fits the `@name` that ends at the caret, and where its `@` is. Null when no `@name` is being typed or
// nobody fits. A display name or a username that starts with what was typed comes first.
export function suggestPeople(list: Person[], text: string, caret: number) {
  // An `@` only starts a name at the start of a word, so an email address suggests nobody.
  const typed = /(^|\s)@(\S*)$/.exec(text.slice(0, caret));
  if (!typed) return null;
  const word = typed[2].toLowerCase();
  const names = (one: Person) => [one.name.toLowerCase(), one.username ?? ''];
  const starts = (one: Person) => names(one).some((name) => name.startsWith(word));
  const items = list
    .filter((one) => names(one).some((name) => name.includes(word)))
    .sort((a, b) => Number(starts(b)) - Number(starts(a)));
  return items.length ? { start: typed.index + typed[1].length, items } : null;
}

// The words of a chat message, to go inside a line of text. A tag shows the person's name as it is now, and stands out more when it is you.
export function ChatWords({ chat }: { chat: Chat }) {
  const me = useMe();
  const people = useApp((state) => state.people);
  return chat.text.split(TAG).map((piece, i) => {
    // Only what the server took as a tag is one: the person saw the thread when this was written.
    const tagged = people.find(
      (one) => i % 2 && chat.tagged.includes(one.id) && `@${one.username}` === piece.toLowerCase(),
    );
    if (!tagged) return piece;
    const mine = tagged.id === me.id;
    return (
      <span
        key={i}
        className={`rounded px-1 font-medium ${mine ? 'bg-primary/20 text-primary' : 'bg-sky-500/15 text-sky-700'}`}
      >
        @{tagged.name}
      </span>
    );
  });
}

// The message box of the chat: words and tags only. What was typed is kept like a reply to Claude is.
export function ChatBox({ thread }: { thread: Thread }) {
  const me = useMe();
  const people = useApp((state) => state.people);
  const draftId = `chat:${thread.id}`;
  const { text } = useDraft(draftId);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const others = peopleOf(thread, people).filter((one) => one.id !== me.id);
  const list = useSuggestions(
    box,
    (caret) => suggestPeople(others, text, caret),
    (one: Person) => `@${one.username}`,
  );
  const clean = text.trim();
  // The text stays in the box until the server has taken it, so a failed send loses nothing.
  const submit = async () => {
    if (!clean || sending) return;
    setSending(true);
    setError('');
    try {
      await sendChat(thread.id, clean);
      editDraft(draftId, { text: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send.');
    }
    setSending(false);
  };
  return (
    <div className="relative rounded-xl border border-border bg-card shadow-sm focus-within:border-sky-500">
      <SuggestMenu label="People" list={list} name={(one) => one.id} heading={() => 'People who can see this thread'}>
        {(one) => (
          <span className="flex items-center gap-2.5 text-sm">
            <Avatar person={one} small />
            <span className="shrink-0 font-medium">{one.name}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">@{one.username}</span>
          </span>
        )}
      </SuggestMenu>
      <textarea
        ref={box}
        value={text}
        placeholder="Message the people in this thread"
        onChange={(e) => {
          editDraft(draftId, { text: e.target.value });
          list.edited();
        }}
        onSelect={list.moved}
        onBlur={list.close}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || list.key(e) || !sends(e)) return;
          e.preventDefault();
          void submit();
        }}
        className={BOX}
      />
      {error && <p className="px-3.5 pb-1 text-xs text-rose-500">{error}</p>}
      <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
        <button
          type="button"
          // Pressing here must not take the caret out of the box.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            // Typed for the person, at the caret, with a space before it when it would not start a word.
            const from = box.current!.selectionStart;
            box.current!.focus();
            box.current!.setRangeText(/(^|\s)$/.test(text.slice(0, from)) ? '@' : ' @', from, from, 'end');
            box.current!.dispatchEvent(new Event('input', { bubbles: true }));
          }}
          aria-label="Tag someone"
          title="Tag someone"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <AtSign size={15} />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          People only. Claude does not see this.
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!clean || sending}
          aria-label="Send to people"
          title={`Send to people (${SEND_KEYS})`}
          className="grid size-8 shrink-0 place-items-center rounded-full bg-sky-600 text-white disabled:opacity-40"
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}

// How long a pop-up stays when nobody touches it.
const TOAST_MS = 8000;

// Pops up when someone tags the person in a thread they are not looking at. A click opens that thread.
export function TagToast() {
  const tag = useApp((state) => state.tag);
  const people = useApp((state) => state.people);
  const thread = useApp((state) => state.threads.find((one) => one.id === tag?.threadId));
  const navigate = useNavigate();
  useEffect(() => {
    if (!tag) return;
    const gone = setTimeout(() => useApp.setState({ tag: null }), TOAST_MS);
    return () => clearTimeout(gone);
  }, [tag]);
  if (!tag || !thread) return null;
  const writer = people.find((one) => one.id === tag.chat.userId);
  return (
    <button
      type="button"
      onClick={() => {
        useApp.setState({ tag: null });
        void navigate({
          to: '/c/$channelId/t/$threadId',
          params: { channelId: thread.channelId, threadId: thread.id },
        });
      }}
      className="fixed top-16 left-1/2 z-50 flex w-80 max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-start gap-2.5 rounded-xl border border-border bg-card p-3 text-left shadow-xl md:right-3 md:left-auto md:translate-x-0"
    >
      <Avatar person={writer} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">
          <span className="font-semibold">{writer?.name ?? 'Someone'}</span> tagged you
        </span>
        <span className="block truncate text-xs text-muted-foreground">{thread.title}</span>
        <span className="mt-1 line-clamp-2 text-sm">
          <ChatWords chat={tag.chat} />
        </span>
      </span>
    </button>
  );
}
