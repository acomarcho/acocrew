import { HEALTH_PATH, WS_PATH } from '@acocrew/shared';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import { WebSocket } from 'ws';
import { startServer } from './server.ts';

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer(0); // 0 = any free port
});
afterAll(() => server.close());

test('health check answers ok', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}${HEALTH_PATH}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('websocket endpoint accepts a connection', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  expect(socket.readyState).toBe(WebSocket.OPEN);
  socket.close();
});

test('unknown paths are 404', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
  expect(res.status).toBe(404);
});
