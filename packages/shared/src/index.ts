// Types and constants used by both the web app and the server.

export type Status = 'working' | 'needs' | 'done';

// A channel is one git repository on the server machine.
export type Channel = { id: string; name: string; path: string };

export type Thread = {
  id: string;
  channelId: string;
  title: string;
  model: string;
  effort: string;
  status: Status;
  updatedAt: number;
};

// One thing shown in a thread. `at` is a timestamp in milliseconds.
export type Item =
  | { id: string; kind: 'message'; by: 'user' | 'claude'; text: string; at: number }
  | { id: string; kind: 'tool'; name: string; detail: string; done: boolean; failed: boolean; at: number }
  | { id: string; kind: 'error'; text: string; at: number };

export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', hint: 'Most capable' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', hint: 'Balanced' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', hint: 'Fastest' },
];

export const EFFORTS = [
  { id: 'low', name: 'Low', hint: 'Quick answers' },
  { id: 'medium', name: 'Medium', hint: 'Everyday work' },
  { id: 'high', name: 'High', hint: 'Thinks harder' },
  { id: 'max', name: 'Max', hint: 'Slowest, most careful' },
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

export type NewThread = { channelId: string; text: string; model: string; effort: string };
export type NewMessage = { text: string; model: string; effort: string };

export const SERVER_PORT = 5274;
export const HEALTH_PATH = '/api/health';
export const WS_PATH = '/ws';
