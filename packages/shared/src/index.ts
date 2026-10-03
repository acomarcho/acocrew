// Types and constants used by both the web app and the server.

// working: Claude is in a turn. waiting: Claude is idle but background work it started is still running.
// needs: someone has to act (an approval, a question, or a failed turn). done: nothing going on.
export type Status = 'working' | 'waiting' | 'needs' | 'done';

// full: Claude acts without asking. ask: Claude asks before anything that is not just reading.
export type Access = 'full' | 'ask';

// A channel is one git repository on the server machine.
export type Channel = { id: string; name: string; path: string };

export type Thread = {
  id: string;
  channelId: string;
  title: string;
  model: string;
  effort: string;
  context: string;
  fast: boolean;
  access: Access;
  status: Status;
  // The worktree this thread works in. Null when it works right in the repository folder.
  path: string | null;
  updatedAt: number;
  // What Claude is waiting on in the background right now, in its own words. Not stored.
  tasks: string[];
};

// A multiple-choice question Claude asks the user.
export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

export type Todo = { id: string; subject: string; status: string };

// One thing shown in a thread. `at` is a timestamp in milliseconds.
// `parent` is set on things a subagent did: it is the id of the tool card that started that subagent.
// `images` on a message are ids of uploaded images, each one served at `IMAGES_PATH/<id>`.
export type Item = { id: string; at: number; parent?: string } & (
  | { kind: 'message'; by: 'user' | 'claude'; text: string; images?: string[] }
  | {
      kind: 'tool';
      name: string;
      detail: string;
      input: string;
      output: string;
      done: boolean;
      failed: boolean;
      endAt?: number;
      // Set when Claude had to ask before running this tool.
      ask?: 'pending' | 'approved' | 'declined';
      questions?: Question[];
    }
  | { kind: 'error'; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'todos'; todos: Todo[] }
);

// `bigContext`: the model can run with the 1M context window. `fast`: it has fast mode.
// A setting the picked model does not have is not offered, and is ignored when Claude starts.
export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', hint: 'Most capable', bigContext: true, fast: true },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', hint: 'Balanced', bigContext: true, fast: false },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', hint: 'Fastest', bigContext: false, fast: false },
];

export const EFFORTS = [
  { id: 'low', name: 'Low', hint: 'Quick answers' },
  { id: 'medium', name: 'Medium', hint: 'Everyday work' },
  { id: 'high', name: 'High', hint: 'Thinks harder' },
  { id: 'xhigh', name: 'Extra high', hint: 'Thinks a lot harder' },
  { id: 'max', name: 'Max', hint: 'Slowest, most careful' },
];

// How much of the conversation Claude can keep in view at once.
export const CONTEXTS = [
  { id: '200k', name: '200k', hint: 'Standard context window' },
  { id: '1m', name: '1M', hint: 'Keeps far more in view' },
];

export const ACCESS = [
  { id: 'full', name: 'Full access', hint: 'Claude acts without asking' },
  { id: 'ask', name: 'Ask first', hint: 'Asks before changing things' },
];

// What the server pushes over the WebSocket. `item` carries the whole item, so getting it twice is harmless.
export type ServerEvent =
  | { type: 'hello'; channels: Channel[]; threads: Thread[] }
  | { type: 'channel'; channel: Channel }
  | { type: 'thread'; thread: Thread }
  | { type: 'items'; threadId: string; items: Item[] }
  | { type: 'item'; threadId: string; item: Item }
  // Words to add to the end of a bubble that Claude is still writing.
  | { type: 'delta'; threadId: string; itemId: string; text: string };

// What the web app sends over the WebSocket: which thread it is looking at.
export type ClientEvent = { type: 'open'; threadId: string };

export type Folder = { name: string; path: string; isRepo: boolean };
export type FolderList = { path: string; parent: string | null; folders: Folder[] };

// The kinds of image a message can carry, and the file ending each one is stored under.
export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// `fast` turns on fast mode: quicker answers at a higher price.
// `images` are ids of images uploaded before. A message needs words, images or both.
export type NewMessage = {
  text: string;
  images: string[];
  model: string;
  effort: string;
  context: string;
  fast: boolean;
  access: Access;
};
// `worktree`: the thread gets its own working copy of the repository, on a new branch.
export type NewThread = NewMessage & { channelId: string; worktree: boolean };

// The user's reply to an approval prompt or a question.
// `always` is a yes that also stops Claude asking about this kind of action. `cancel` is a no that also ends
// Claude's turn. `answers` maps each question to what the user picked or typed.
export const DECISIONS = ['approve', 'always', 'decline', 'cancel'] as const;
export type Answer = { toolId: string; decision: (typeof DECISIONS)[number]; answers?: Record<string, string> };

export const SERVER_PORT = 5274;
export const HEALTH_PATH = '/api/health';
export const WS_PATH = '/ws';
export const IMAGES_PATH = '/api/images';
