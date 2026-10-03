import { HEALTH_PATH, WS_PATH } from '@acocrew/shared';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

const app = new Hono();

app.get(HEALTH_PATH, (c) => c.json({ ok: true }));

// Accepts connections and does nothing yet. Thread events will be pushed through here.
app.get(
  WS_PATH,
  upgradeWebSocket(() => ({})),
);

// Listens on localhost only. Tailscale or a tunnel sits in front of it.
export function startServer(port: number) {
  const websocket = { server: new WebSocketServer({ noServer: true }) };
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1', websocket }, (info) =>
      resolve({ port: info.port, close: () => server.close() }),
    );
  });
}
