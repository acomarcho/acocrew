// Types and constants that both the server and the web app import.

export type Status = 'working' | 'needs' | 'done';
export type Tool = { kind: 'run' | 'edit'; label: string; detail: string };
export type Msg = { id: string; by: string; at: string; text: string; tools?: Tool[] };

export type Thread = {
  id: string;
  channelId: string;
  title: string;
  branch: string; // each thread gets its own worktree on this branch
  status: Status;
  model: string;
  effort: string;
  msgs: Msg[];
};

// A channel is one git repository.
export type Channel = { id: string; name: string; repo: string };

export const SERVER_PORT = 5274;
export const HEALTH_PATH = '/api/health';
export const WS_PATH = '/ws';
