import {
  WS_PATH,
  type Answer,
  type Channel,
  type ClientEvent,
  type FolderList,
  type Item,
  type NewMessage,
  type NewThread,
  type ServerEvent,
  type Thread,
} from '@acocrew/shared';
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';

type State = {
  // False until the server has sent the channels and threads.
  ready: boolean;
  online: boolean;
  channels: Channel[];
  threads: Thread[];
  // The thread on screen. `items` is null until the server has sent what is in it.
  openId: string | null;
  items: Item[] | null;
};

type Action = ServerEvent | { type: 'open'; threadId: string } | { type: 'offline' };

const START: State = { ready: false, online: false, channels: [], threads: [], openId: null, items: null };

const upsert = <T extends { id: string }>(list: T[], next: T) =>
  list.some((x) => x.id === next.id) ? list.map((x) => (x.id === next.id ? next : x)) : [...list, next];

function reduce(state: State, action: Action): State {
  // Thread content only matters for the thread on screen.
  if ('threadId' in action && action.type !== 'open' && action.threadId !== state.openId) return state;
  switch (action.type) {
    case 'hello':
      return { ...state, ready: true, online: true, channels: action.channels, threads: action.threads };
    case 'offline':
      return { ...state, online: false };
    case 'channel':
      return { ...state, channels: upsert(state.channels, action.channel) };
    case 'thread': {
      // The same row can arrive twice (as the answer to a request and over the socket). The newest wins.
      const known = state.threads.find((t) => t.id === action.thread.id);
      if (known && known.updatedAt > action.thread.updatedAt) return state;
      return { ...state, threads: upsert(state.threads, action.thread) };
    }
    case 'open':
      return { ...state, openId: action.threadId, items: null };
    case 'items':
      return { ...state, items: action.items };
    case 'item':
      return { ...state, items: upsert(state.items ?? [], action.item) };
    case 'delta':
      return {
        ...state,
        items: (state.items ?? []).map((item) =>
          item.id === action.itemId && item.kind === 'message' ? { ...item, text: item.text + action.text } : item,
        ),
      };
  }
}

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// Everything the screens know comes down the WebSocket. Changes go up as plain requests.
export function useAppState() {
  const [state, dispatch] = useReducer(reduce, START);
  const [navOpen, setNavOpen] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const openId = useRef<string | null>(null);

  const tell = (event: ClientEvent) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(event));
  };

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout>;
    let stopped = false;
    const connect = () => {
      const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + WS_PATH);
      socket.current = ws;
      // After a reconnect, ask again for the thread on screen so nothing is missed.
      ws.onopen = () => openId.current && tell({ type: 'open', threadId: openId.current });
      ws.onmessage = (message) => dispatch(JSON.parse(message.data));
      ws.onclose = () => {
        if (stopped) return;
        dispatch({ type: 'offline' });
        retry = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, []);

  const openThread = useCallback((threadId: string) => {
    openId.current = threadId;
    dispatch({ type: 'open', threadId });
    tell({ type: 'open', threadId });
  }, []);

  const listFolders = useCallback(
    (path?: string) => request<FolderList>(`/api/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    [],
  );

  const addChannel = async (path: string) => {
    const channel = await request<Channel>('/api/channels', { path });
    dispatch({ type: 'channel', channel });
    return channel;
  };

  const createThread = async (body: NewThread) => {
    const thread = await request<Thread>('/api/threads', body);
    dispatch({ type: 'thread', thread });
    return thread;
  };

  const sendMessage = (threadId: string, body: NewMessage) => request(`/api/threads/${threadId}/messages`, body);
  const answer = (threadId: string, body: Answer) => request(`/api/threads/${threadId}/answers`, body);
  const stopThread = (threadId: string) => request(`/api/threads/${threadId}/stop`, {});

  return {
    ...state,
    navOpen,
    setNavOpen,
    openThread,
    listFolders,
    addChannel,
    createThread,
    sendMessage,
    answer,
    stopThread,
  };
}

export type App = ReturnType<typeof useAppState>;
export const Ctx = createContext<App>(null!);
export const useApp = () => useContext(Ctx);
