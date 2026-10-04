import {
  LOGOUT_PATH,
  ME_PATH,
  USERS_PATH,
  WS_PATH,
  type Answer,
  type Channel,
  type ClientEvent,
  type FolderList,
  type Item,
  type Me,
  type NewMessage,
  type NewThread,
  type NewUser,
  type Person,
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
  // Everyone who has or had an account.
  people: Person[];
  // The thread on screen. `items` is null until the server has sent what is in it.
  openId: string | null;
  items: Item[] | null;
};

type Action = ServerEvent | { type: 'open'; threadId: string } | { type: 'offline' };

export const START: State = {
  ready: false,
  online: false,
  channels: [],
  threads: [],
  people: [],
  openId: null,
  items: null,
};

const upsert = <T extends { id: string }>(list: T[], next: T) =>
  list.some((x) => x.id === next.id) ? list.map((x) => (x.id === next.id ? next : x)) : [...list, next];

export function reduce(state: State, action: Action): State {
  // Thread content only matters for the thread on screen.
  if ('threadId' in action && action.type !== 'open' && action.threadId !== state.openId) return state;
  switch (action.type) {
    case 'hello': {
      const { channels, threads, people } = action;
      return { ...state, ready: true, online: true, channels, threads, people };
    }
    case 'offline':
      return { ...state, online: false };
    case 'channel':
      return { ...state, channels: upsert(state.channels, action.channel) };
    case 'order': {
      // A channel the list does not name stays at the end.
      const at = (channel: Channel) => action.ids.indexOf(channel.id) + 1 || action.ids.length + 1;
      return { ...state, channels: state.channels.toSorted((a, b) => at(a) - at(b)) };
    }
    case 'person':
      return { ...state, people: upsert(state.people, action.person) };
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

const JSON_BODY = { 'content-type': 'application/json' };

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const post = { method: 'POST', body: JSON.stringify(body), headers: JSON_BODY };
  const res = await fetch(path, body ? post : undefined);
  const data = await res.json();
  // The login has run out, or was ended from somewhere else. The app is told, and shows the login screen.
  if (res.status === 401) window.dispatchEvent(new Event(LOGGED_OUT));
  // The login library words its refusals as `message`, our own routes as `error`.
  if (!res.ok) throw new Error(data.error ?? data.message);
  return data;
}

// What the window is told when the server says nobody is logged in.
export const LOGGED_OUT = 'acocrew:logged-out';

// Who is logged in on this browser. null: nobody. undefined: the server did not say (it cannot be reached).
export async function whoAmI(): Promise<Me | null | undefined> {
  const res = await fetch(ME_PATH).catch(() => null);
  if (res?.ok) return res.json();
  return res?.status === 401 ? null : undefined;
}

export const changePassword = (currentPassword: string, newPassword: string) =>
  request(`${ME_PATH}/password`, { currentPassword, newPassword });

// Everything the screens know comes down the WebSocket. Changes go up as plain requests.
// `login` is who is logged in. `recheck` asks the server again whether they still are.
export function useAppState(login: Me, recheck: () => Promise<unknown>) {
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
        // The server also hangs up on someone it logged out (a deleted account, a password reset).
        void recheck();
        retry = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [recheck]);

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

  // Shows the new order right away. If the server turns it down, the old order comes back.
  const orderChannels = (ids: string[]) => {
    const before = state.channels.map((channel) => channel.id);
    dispatch({ type: 'order', ids });
    request('/api/channels/order', { ids }).catch(() => dispatch({ type: 'order', ids: before }));
  };

  const createThread = async (body: NewThread) => {
    const thread = await request<Thread>('/api/threads', body);
    dispatch({ type: 'thread', thread });
    return thread;
  };

  const sendMessage = (threadId: string, body: NewMessage) => request(`/api/threads/${threadId}/messages`, body);
  const answer = (threadId: string, body: Answer) => request(`/api/threads/${threadId}/answers`, body);
  const stopThread = (threadId: string) => request(`/api/threads/${threadId}/stop`, {});

  const rename = (name: string) => request(ME_PATH, { name });
  const logOut = () => request(LOGOUT_PATH, {}).then(recheck);
  // What an admin does to accounts. The list itself updates when the server tells everyone.
  const addUser = (body: NewUser) => request<Person>(USERS_PATH, body);
  const resetPassword = (id: string, password: string) => request(`${USERS_PATH}/${id}/password`, { password });
  const setAdmin = (id: string, admin: boolean) => request(`${USERS_PATH}/${id}/admin`, { admin });
  const deleteUser = (id: string) => request(`${USERS_PATH}/${id}/delete`, {});

  return {
    ...state,
    // The person logged in, as everyone sees them right now (the name or admin rights may have changed).
    me: state.people.find((person) => person.id === login.id) ?? login,
    rename,
    logOut,
    addUser,
    resetPassword,
    setAdmin,
    deleteUser,
    navOpen,
    setNavOpen,
    openThread,
    listFolders,
    addChannel,
    orderChannels,
    createThread,
    sendMessage,
    answer,
    stopThread,
  };
}

export type App = ReturnType<typeof useAppState>;
export const Ctx = createContext<App>(null!);
export const useApp = () => useContext(Ctx);
