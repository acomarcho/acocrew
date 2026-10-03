import type { ServerEvent } from '@acocrew/shared';

type Socket = { send(data: string): void };

// Keeps track of connected browsers and which thread each one has open.
export function createHub() {
  const sockets = new Map<Socket, string | null>();
  const send = (socket: Socket, event: ServerEvent) => socket.send(JSON.stringify(event));
  return {
    send,
    add: (socket: Socket) => sockets.set(socket, null),
    remove: (socket: Socket) => sockets.delete(socket),
    open: (socket: Socket, threadId: string) => sockets.set(socket, threadId),
    toAll(event: ServerEvent) {
      for (const socket of sockets.keys()) send(socket, event);
    },
    toThread(threadId: string, event: ServerEvent) {
      for (const [socket, open] of sockets) if (open === threadId) send(socket, event);
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
