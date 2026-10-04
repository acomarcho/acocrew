// What someone typed and has not sent yet. It is kept outside the screens and saved in this browser, so it is
// still there after they look at something else, or reload the page.
import type { Visibility } from '@acocrew/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Settings } from './ui';

export type Draft = {
  text: string;
  images: string[];
  // Only what the person picked. The rest follows the thread, or what a new thread starts with.
  settings: Partial<Settings>;
  // The rest is only there for a thread not started yet: its repository, and what was picked for where it
  // works and who sees it.
  channelId?: string;
  place?: string;
  from?: string;
  path?: string;
  visibility?: Visibility;
};

const EMPTY: Draft = { text: '', images: [], settings: {} };

// A draft counts while it has words or images. What was picked does not make one on its own.
export const hasContent = (draft: Draft) => Boolean(draft.text.trim() || draft.images.length);

const withContent = (drafts: Record<string, Draft>) => Object.entries(drafts).filter(([, draft]) => hasContent(draft));

type Drafts = { owner: string; drafts: Record<string, Draft> };

// A reply is kept under the id of its thread, and a thread not started yet under an id of its own.
// `owner` is whose drafts these are. Only drafts that count are saved.
export const useDrafts = create<Drafts>()(
  persist<Drafts>(() => ({ owner: '', drafts: {} }), {
    name: 'acocrew:drafts',
    partialize: ({ owner, drafts }) => ({ owner, drafts: Object.fromEntries(withContent(drafts)) }),
    // What is saved is read when the page loads, and again when another tab saved. It wins for every draft
    // that counts (one sent in the other tab is gone here too). What was only picked here is in no save,
    // and stays.
    merge: (saved, current) => {
      const picked = Object.entries(current.drafts).filter(([, draft]) => !hasContent(draft));
      // Nothing is saved the first time the app is opened in a browser.
      const kept = { ...current, ...(saved as Drafts | undefined) };
      return { ...kept, drafts: { ...Object.fromEntries(picked), ...kept.drafts } };
    },
  }),
);

// Drafts belong to whoever logged in last on this browser. Someone else does not get to read them.
export const keepDraftsOf = (owner: string) => {
  if (useDrafts.getState().owner !== owner) useDrafts.setState({ owner, drafts: {} });
};

export const draftOf = (id: string) => useDrafts.getState().drafts[id] ?? EMPTY;
export const useDraft = (id: string) => useDrafts((state) => state.drafts[id]) ?? EMPTY;

export const editDraft = (id: string, patch: Partial<Draft>) =>
  useDrafts.setState(({ drafts }) => ({ drafts: { ...drafts, [id]: { ...EMPTY, ...drafts[id], ...patch } } }));

export const dropDraft = (id: string) =>
  useDrafts.setState(({ drafts }) => ({
    drafts: Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== id)),
  }));

// The threads someone began in a repository and has not sent yet, the newest first.
export const draftsIn = (drafts: Record<string, Draft>, channelId: string) =>
  withContent(drafts)
    .filter(([, draft]) => draft.channelId === channelId)
    .reverse();
