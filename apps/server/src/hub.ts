import type { ServerEvent } from '@acocrew/shared';

type Socket = { send(data: string): void; close(): void };

// Keeps track of connected browsers: who is logged in on each one, and which thread it has open.
export function createHub() {
  const sockets = new Map<Socket, { userId: string; threadId: string | null }>();
  const send = (socket: Socket, event: ServerEvent) => socket.send(JSON.stringify(event));
  return {
    send,
    add: (socket: Socket, userId: string) => sockets.set(socket, { userId, threadId: null }),
    remove: (socket: Socket) => sockets.delete(socket),
    open(socket: Socket, threadId: string) {
      const tab = sockets.get(socket);
      if (tab) tab.threadId = threadId;
    },
    // Cuts off every browser this person is connected from, after they were logged out by someone else.
    kick(userId: string) {
      for (const [socket, tab] of sockets) if (tab.userId === userId) socket.close();
    },
    toAll(event: ServerEvent) {
      for (const socket of sockets.keys()) send(socket, event);
    },
    // Every browser this person is connected from.
    toUser(userId: string, event: ServerEvent) {
      for (const [socket, tab] of sockets) if (tab.userId === userId) send(socket, event);
    },
    toThread(threadId: string, event: ServerEvent) {
      for (const [socket, tab] of sockets) if (tab.threadId === threadId) send(socket, event);
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
