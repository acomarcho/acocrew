import { beforeEach, expect, test, vi } from 'vite-plus/test';

// A stand-in for what the browser keeps for this site. It outlives a "reload" (loading the code again).
const kept = vi.hoisted(() => {
  const kept = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  };
  vi.stubGlobal('window', { localStorage });
  return kept;
});

// The page as it is after a reload: the code runs from the top, with whatever the browser kept.
const load = async () => {
  vi.resetModules();
  return import('./drafts');
};

beforeEach(() => kept.clear());

test('what was typed is still there after looking elsewhere and after a reload, per thread', async () => {
  let page = await load();
  page.editDraft('thread-a', { text: 'half a reply' });
  page.editDraft('thread-b', { text: 'another one', settings: { effort: 'high' } });
  page.editDraft('thread-a', { images: ['cat.png'] });
  expect(page.draftOf('thread-a')).toEqual({ text: 'half a reply', images: ['cat.png'], settings: {} });

  page = await load();
  expect(page.draftOf('thread-a')).toEqual({ text: 'half a reply', images: ['cat.png'], settings: {} });
  expect(page.draftOf('thread-b')).toEqual({ text: 'another one', images: [], settings: { effort: 'high' } });
  // A thread nothing was typed in has an empty box.
  expect(page.draftOf('thread-c')).toEqual({ text: '', images: [], settings: {} });
});

test('a draft counts while it has words or images, and only those are saved', async () => {
  let page = await load();
  page.editDraft('only-settings', { settings: { model: 'other' } });
  page.editDraft('only-spaces', { text: '  \n ' });
  page.editDraft('words', { text: 'hi' });
  page.editDraft('picture', { images: ['cat.png'] });
  const counts = (id: string) => page.hasContent(page.draftOf(id));
  expect(['only-settings', 'only-spaces', 'words', 'picture', 'never'].map(counts)).toEqual([
    false,
    false,
    true,
    true,
    false,
  ]);
  // What was picked is there for as long as the page is open.
  expect(page.draftOf('only-settings').settings).toEqual({ model: 'other' });

  page = await load();
  expect(Object.keys(page.useDrafts.getState().drafts)).toEqual(['words', 'picture']);
});

test('a repository can have several threads not sent yet, the newest first, until each is sent or thrown away', async () => {
  const page = await load();
  page.editDraft('first', { channelId: 'shop', text: 'fix the cart' });
  page.editDraft('second', { channelId: 'shop', text: 'new colors', visibility: 'public', place: 'existing' });
  page.editDraft('elsewhere', { channelId: 'blog', text: 'write a post' });
  page.editDraft('picking', { channelId: 'shop', visibility: 'public' });
  page.editDraft('a-thread', { text: 'a reply is not a new thread' });
  const inShop = () => page.draftsIn(page.useDrafts.getState().drafts, 'shop').map(([id]) => id);
  expect(inShop()).toEqual(['second', 'first']);

  // Sending empties the box, which is what the message box does once the server took the message.
  page.editDraft('first', { text: '', images: [] });
  expect(inShop()).toEqual(['second']);
  page.dropDraft('second');
  expect(inShop()).toEqual([]);
  expect(page.draftOf('second')).toEqual({ text: '', images: [], settings: {} });
  expect(page.hasContent(page.draftOf('elsewhere'))).toBe(true);
});

test('drafts belong to whoever logged in last on this browser', async () => {
  let page = await load();
  page.keepDraftsOf('marcho');
  page.editDraft('t', { text: 'private words' });

  // The same person again (a reload, or a login that ran out): still there.
  page = await load();
  page.keepDraftsOf('marcho');
  expect(page.draftOf('t').text).toBe('private words');

  // Someone else on the same browser does not get to read them, also not after a reload.
  page.keepDraftsOf('jordan');
  expect(page.draftOf('t').text).toBe('');
  page = await load();
  expect(page.draftOf('t').text).toBe('');
});

test('what another tab saved is taken over, so this tab does not undo it with its next save', async () => {
  const tab = await load();
  tab.editDraft('here', { text: 'typed in this tab' });
  tab.editDraft('sent there', { text: 'the other tab sends this one' });
  tab.editDraft('picking', { visibility: 'public' });
  const { name } = tab.useDrafts.persist.getOptions();
  const saved = JSON.parse(kept.get(name!)!);
  saved.state.drafts.there = { text: 'typed in the other tab', images: [], settings: {} };
  delete saved.state.drafts['sent there'];
  kept.set(name!, JSON.stringify(saved));
  // The browser tells a tab when another one saved. The app answers by reading again.
  await tab.useDrafts.persist.rehydrate();

  tab.editDraft('here', { text: 'typed some more' });
  const after = JSON.parse(kept.get(name!)!).state.drafts;
  expect(Object.keys(after)).toEqual(['here', 'there']);
  expect(tab.hasContent(tab.draftOf('sent there'))).toBe(false);
  // What was only picked in this tab is in no save, and is still picked.
  expect(tab.draftOf('picking').visibility).toBe('public');
});
