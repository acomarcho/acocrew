// Suggestions shown while a word is being typed in a message box: what Claude can run after a `/`, and the
// people of a thread after an `@` (see chat.tsx). Both use the same list and the same keys.
import { COMMANDS_PATH, type Command } from '@acocrew/shared';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { request } from './store';

// `from` says where Claude would run: `thread=<id>`, or `channel=<id>` for a thread not started yet.
// Empty until the server answers. If it cannot, there are just no suggestions.
export function useCommands(from: string) {
  const [list, setList] = useState<Command[]>([]);
  useEffect(() => {
    let left = false;
    request<Command[]>(`${COMMANDS_PATH}?${from}`).then(
      (answer) => !left && setList(answer),
      () => {},
    );
    return () => void (left = true);
  }, [from]);
  return list;
}

// What to suggest for the `/name` that ends at the caret: where its slash is, and what fits, in the order
// shown. Null when no `/name` is being typed or nothing fits.
export function suggest(list: Command[], text: string, caret: number) {
  // A slash only starts a name at the start of a word, so a path or a link in the message suggests nothing.
  const typed = /(^|\s)\/(\S*)$/.exec(text.slice(0, caret));
  if (!typed) return null;
  const start = typed.index + typed[1].length;
  const word = typed[2].toLowerCase();
  // Claude runs a command only when the message starts with it. A skill it also picks up from later on.
  const first = !text.slice(0, start).trim();
  const starts = (command: Command) => command.name.toLowerCase().startsWith(word);
  // Later in a message a slash is often just part of the words (`open /docs`), so there only a name that
  // starts with what was typed fits. At the start of a message a name that contains it fits too.
  const fits = (command: Command) =>
    first ? command.name.toLowerCase().includes(word) : command.skill && starts(command);
  // Commands come before skills. Within each, names that start with what was typed come first.
  const rank = (command: Command) => (command.skill ? 2 : 0) + (starts(command) ? 0 : 1);
  const items = list.filter(fits).sort((a, b) => rank(a) - rank(b));
  return items.length ? { start, items } : null;
}

// What fits the word that ends at the caret, and where that word starts. Null when nothing is suggested.
type Found<T> = { start: number; items: T[] } | null;

// What a message box needs to suggest things for the word being typed in it. `find` says what fits when the
// caret is at a place in its text, and `write` is what picking one puts in the box. Typing never leaves the box: it hands its keys over
// with `key`, says when its text changed (`edited`) and when the caret moved or left (`moved`, `close`).
export function useSuggestions<T>(
  box: RefObject<HTMLTextAreaElement | null>,
  find: (caret: number) => Found<T>,
  write: (item: T) => string,
) {
  // Where the typing caret was after the last change to the text, which row is lit, and whether the list was
  // closed since that change.
  const [caret, setCaret] = useState(0);
  const [lit, setLit] = useState(0);
  const [closed, setClosed] = useState(false);
  const menu = closed ? null : find(caret);
  // Swaps the word the caret is in for the whole name, and leaves the caret after it.
  const pick = (item: T) => {
    const text = box.current!.value;
    box.current!.setRangeText(`${write(item)} `, menu!.start, caret + text.slice(caret).search(/\s|$/), 'end');
    // Told to the box the way typing is, so it is taken in like any other change.
    box.current!.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return {
    menu,
    lit,
    setLit,
    pick,
    edited() {
      setCaret(box.current!.selectionStart);
      setLit(0);
      setClosed(false);
    },
    moved: () => box.current!.selectionStart !== caret && setClosed(true),
    close: () => setClosed(true),
    // While the list is open, the keys that would move the caret or send the message work the list. Says
    // whether this key was one of them.
    key(e: KeyboardEvent) {
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      const picks = (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey;
      if (!menu || !(step || picks || e.key === 'Escape')) return false;
      e.preventDefault();
      if (step) setLit((lit + step + menu.items.length) % menu.items.length);
      else if (picks) pick(menu.items[lit]);
      else setClosed(true);
      return true;
    },
  };
}

type MenuProps<T> = {
  label: string;
  list: ReturnType<typeof useSuggestions<T>>;
  name: (item: T) => string;
  // The words over a group of rows. Shown where they differ from the row before.
  heading: (item: T) => string;
  children: (item: T) => ReactNode;
};

// Sits right above the message box. The keys are handled by the box itself, so typing never leaves it.
export function SuggestMenu<T>({ label, list: { menu, lit, setLit, pick }, name, heading, children }: MenuProps<T>) {
  const list = useRef<HTMLDivElement>(null);
  const items = menu?.items;
  useEffect(() => {
    list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  }, [lit, items]);
  if (!items) return null;
  return (
    <div
      ref={list}
      role="listbox"
      aria-label={label}
      // Pressing here must not take the caret out of the message box.
      onMouseDown={(e) => e.preventDefault()}
      className="absolute bottom-full left-0 z-50 mb-1.5 max-h-[min(19rem,45dvh)] w-full scroll-py-1 overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-1 text-foreground shadow-xl sm:w-[26rem]"
    >
      {items.map((item, index) => (
        <div key={name(item)}>
          {(index === 0 || heading(item) !== heading(items[index - 1])) && (
            <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">{heading(item)}</div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={index === lit}
            onMouseMove={() => setLit(index)}
            onClick={() => pick(item)}
            className="block w-full rounded-lg px-2.5 py-1.5 text-left aria-selected:bg-muted"
          >
            {children(item)}
          </button>
        </div>
      ))}
    </div>
  );
}

// The list of what Claude can run.
export function CommandMenu({ list }: { list: ReturnType<typeof useSuggestions<Command>> }) {
  return (
    <SuggestMenu
      label="Commands and skills"
      list={list}
      name={(command) => command.name}
      heading={(command) => (command.skill ? 'Skills' : 'Commands')}
    >
      {(command) => (
        <>
          <span className="flex items-baseline gap-2 text-sm">
            <span className="shrink-0 font-medium">/{command.name}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">{command.hint}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">{command.description}</span>
        </>
      )}
    </SuggestMenu>
  );
}
