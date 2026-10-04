import {
  AUTOMATIONS_PATH,
  LOGOUT_PATH,
  ME_PATH,
  USERS_PATH,
  WS_PATH,
  type Answer,
  type Automation,
  type Channel,
  type ClientEvent,
  type FolderList,
  type Item,
  type Me,
  type NewAutomation,
  type NewMessage,
  type NewThread,
  type NewUser,
  type Person,
  type Seen,
  type ServerEvent,
  type Temporary,
  type Thread,
  type Visibility,
} from '@acocrew/shared';
import { create } from 'zustand';

type State = {
  // False until the server has sent the channels and threads.
  ready: boolean;
  online: boolean;
  channels: Channel[];
  threads: Thread[];
  // The automations of every repository.
  automations: Automation[];
  // How many minutes the server's clock is ahead of UTC. Automations run on that clock.
  utcOffset: number;
  // Everyone who has or had an account.
  people: Person[];
  // What the person logged in has seen of each thread.
  seen: Seen;
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
  automations: [],
  utcOffset: 0,
  people: [],
  seen: {},
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
      const { channels, threads, people, seen, automations, utcOffset } = action;
      return { ...state, ready: true, online: true, channels, threads, people, seen, automations, utcOffset };
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
    case 'thread-gone':
      return { ...state, threads: state.threads.filter((thread) => thread.id !== action.id) };
    case 'seen':
      return { ...state, seen: { ...state.seen, ...action.seen } };
    case 'automation':
      return { ...state, automations: upsert(state.automations, action.automation) };
    case 'automation-gone': {
      // The threads it started stay, and no longer say that an automation started them.
      const loose = (thread: Thread) =>
        thread.automationId === action.id ? { ...thread, automationId: null } : thread;
      const automations = state.automations.filter((automation) => automation.id !== action.id);
      return { ...state, automations, threads: state.threads.map(loose) };
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

// Whether this person should look at the thread: Claude waits for an answer in it, or Claude stopped (it
// finished or it failed) and they have not seen how. Only threads they take part in count.
export function needsYou(thread: Thread, seen: Seen, me: string) {
  if (!thread.people.includes(me)) return false;
  if (thread.status === 'needs') return true;
  const stopped = thread.status === 'done' || thread.status === 'failed';
  return stopped && thread.updatedAt > (seen[thread.id] ?? 0);
}

// The pinned ones of these threads. The one pinned last comes first.
export const pinnedOf = (threads: Thread[]) =>
  threads.filter((thread) => thread.pinnedAt !== null).sort((a, b) => b.pinnedAt! - a.pinnedAt!);

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

// Everything the screens know is kept here. A screen reads only the parts it shows, so it is drawn again
// only when those change. `login` is who logged in, and is set before any screen is drawn.
export const useApp = create<State & { login: Me; navOpen: boolean }>(() => ({
  ...START,
  login: null!,
  navOpen: false,
}));

const dispatch = (action: Action) => useApp.setState((state) => reduce(state, action));

// The person logged in, as everyone sees them right now (the name or admin rights may have changed).
export const useMe = () =>
  useApp((state) => state.people.find((person) => person.id === state.login.id) ?? state.login);

export const setNavOpen = (navOpen: boolean) => useApp.setState({ navOpen });

let socket: WebSocket | null = null;

const tell = (event: ClientEvent) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
};

// Everything the screens know comes down the WebSocket. Changes go up as plain requests.
// `recheck` asks the server again whether the person is still logged in. Gives back what hangs up again,
// which also forgets everything, so the next person to log in starts with nothing.
export function connect(recheck: () => Promise<unknown>) {
  let retry: ReturnType<typeof setTimeout>;
  let stopped = false;
  const open = () => {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + WS_PATH);
    socket = ws;
    // After a reconnect, ask again for the thread on screen so nothing is missed.
    ws.onopen = () => {
      const { openId } = useApp.getState();
      if (openId) tell({ type: 'open', threadId: openId });
    };
    ws.onmessage = (message) => dispatch(JSON.parse(message.data));
    ws.onclose = () => {
      if (stopped) return;
      dispatch({ type: 'offline' });
      // The server also hangs up on someone it logged out (a deleted account, a password reset).
      void recheck();
      retry = setTimeout(open, 1000);
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
    useApp.setState({ ...START, navOpen: false });
  };
}

export const openThread = (threadId: string) => {
  dispatch({ type: 'open', threadId });
  tell({ type: 'open', threadId });
};

// The person has the thread in front of them. Shown right away, and kept by the server for their other
// devices. If the server did not get it, it says so on the next connect and the thread asks again.
export const markSeen = (thread: Thread) => {
  dispatch({ type: 'seen', seen: { [thread.id]: thread.updatedAt } });
  request(`/api/threads/${thread.id}/seen`, { at: thread.updatedAt }).catch(() => {});
};

export const listFolders = (path?: string) =>
  request<FolderList>(`/api/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`);

export const addChannel = async (path: string) => {
  const channel = await request<Channel>('/api/channels', { path });
  dispatch({ type: 'channel', channel });
  return channel;
};

// Shows the new order right away. If the server turns it down, the old order comes back.
export const orderChannels = (ids: string[]) => {
  const before = useApp.getState().channels.map((channel) => channel.id);
  dispatch({ type: 'order', ids });
  request('/api/channels/order', { ids }).catch(() => dispatch({ type: 'order', ids: before }));
};

export const createThread = async (body: NewThread) => {
  const thread = await request<Thread>('/api/threads', body);
  dispatch({ type: 'thread', thread });
  return thread;
};

// Makes an automation, or with an `id` changes that one (`on` says whether it stays switched on).
export const saveAutomation = async (body: NewAutomation & { on?: boolean }, id?: string) => {
  const automation = await request<Automation>(id ? `${AUTOMATIONS_PATH}/${id}` : AUTOMATIONS_PATH, body);
  dispatch({ type: 'automation', automation });
  return automation;
};
export const deleteAutomation = (id: string) => request(`${AUTOMATIONS_PATH}/${id}/delete`, {});
// Runs it right now, whatever its schedule says. Gives back the thread that started.
export const runAutomation = async (id: string) => {
  const thread = await request<Thread>(`${AUTOMATIONS_PATH}/${id}/run`, {});
  dispatch({ type: 'thread', thread });
  return thread;
};

export const sendMessage = (threadId: string, body: NewMessage) => request(`/api/threads/${threadId}/messages`, body);
export const answer = (threadId: string, body: Answer) => request(`/api/threads/${threadId}/answers`, body);
export const stopThread = (threadId: string) => request(`/api/threads/${threadId}/stop`, {});
// Pins the thread for everyone, or unpins it. The list changes when the server tells everyone.
export const pinThread = (threadId: string, pinned: boolean) => request(`/api/threads/${threadId}/pin`, { pinned });

// Who sees the thread: private or public, and one person it is shared with or no longer. Only whoever
// started it can. The thread changes when the server says so.
export const showThread = (threadId: string, visibility: Visibility) =>
  request(`/api/threads/${threadId}/visibility`, { visibility });
export const shareThread = (threadId: string, userId: string, shared: boolean) =>
  request(`/api/threads/${threadId}/shares`, { userId, shared });

export const rename = (name: string) => request(ME_PATH, { name });
// The app is told, and shows the login screen.
export const logOut = () => request(LOGOUT_PATH, {}).then(() => window.dispatchEvent(new Event(LOGGED_OUT)));
// What an admin does to accounts. The list itself updates when the server tells everyone.
// Both give back the temporary password the server made, which is the only time it can be seen.
export const addUser = (body: NewUser) => request<Person & Temporary>(USERS_PATH, body);
export const resetPassword = (id: string) => request<Temporary>(`${USERS_PATH}/${id}/password`, {});
export const setAdmin = (id: string, admin: boolean) => request(`${USERS_PATH}/${id}/admin`, { admin });
export const deleteUser = (id: string) => request(`${USERS_PATH}/${id}/delete`, {});
