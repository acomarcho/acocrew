import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import { claudeCall, codexReader, createUsage, readPrices, summarize } from './usage.ts';

// Prices in dollars per million tokens, as LiteLLM lists them (per token, sometimes with a provider in front).
const M = 1e-6;
const PRICES = {
  'anthropic/claude-opus-5-5': {
    input_cost_per_token: 4 * M,
    output_cost_per_token: 20 * M,
    cache_read_input_token_cost: 0.2 * M,
    cache_creation_input_token_cost: 5 * M,
    cache_creation_input_token_cost_above_1hr: 8 * M,
  },
  'gpt-6-sol': { input_cost_per_token: 2 * M, output_cost_per_token: 10 * M, cache_read_input_token_cost: 0.5 * M },
  // Half a price is no price.
  'half-priced': { input_cost_per_token: 1 * M },
  sample_spec: { note: 'LiteLLM puts an example entry first' },
};

const HOUR = 60 * 60 * 1000;
const iso = (at: number) => new Date(at).toISOString();

// A line of a Claude Code log, shaped like a real one (the answer's words left out).
const claude = (at: number, id: string, usage: object, model = 'claude-opus-5-5') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(at),
    requestId: `req_${id}`,
    sessionId: '5f1ecd82-beca-40b4-b1c1-1c4ac374d327',
    message: { model, id: `msg_${id}`, type: 'message', role: 'assistant', content: [], usage },
  });
const opusUsage = (written1h = 0) => ({
  input_tokens: 1_000_000,
  cache_creation_input_tokens: 2_000_000,
  cache_read_input_tokens: 10_000_000,
  output_tokens: 100_000,
  cache_creation: { ephemeral_1h_input_tokens: written1h, ephemeral_5m_input_tokens: 2_000_000 - written1h },
});
// 1M input at $4, 10M cache reads at $0.2, 100K output at $20: $8. Plus 2M cache writes at $5, or $8 for 1 hour.
const OPUS_5M = 8 + 10;
const OPUS_1H = 8 + 16;

// Lines of a Codex log.
const meta = (at: number, extra = {}) =>
  JSON.stringify({ timestamp: iso(at), type: 'session_meta', payload: { id: 's', source: 'exec', ...extra } });
const turn = (at: number, model: string) =>
  JSON.stringify({ timestamp: iso(at), type: 'turn_context', payload: { model } });
const tokens = (at: number, input: number, cached: number, output: number) =>
  JSON.stringify({
    timestamp: iso(at),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 0,
        },
      },
    },
  });

test('a Claude line is a call only when it is an answer with usage', () => {
  const at = Date.now();
  expect(claudeCall(claude(at, 'a', opusUsage(500)))).toEqual({
    provider: 'claude',
    at: new Date(iso(at)).getTime(),
    model: 'claude-opus-5-5',
    key: 'msg_a:req_a',
    tokens: { input: 1_000_000, cacheRead: 10_000_000, cacheWrite: 2_000_000, output: 100_000 },
    hourWrite: 500,
  });
  expect(claudeCall(JSON.stringify({ type: 'user', timestamp: iso(at), message: { usage: {} } }))).toBeNull();
  expect(claudeCall('{"usage": not json')).toBeNull();
  expect(claudeCall(JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { model: 'x' } }))).toBeNull();
});

test('a Codex log takes the model from the turn, skips repeats and copies of the parent it was forked from', () => {
  const start = Date.now() - HOUR;
  const read = codexReader();
  const lines = [
    // A fork: the parent's lines come copied in, all within a second of the start.
    meta(start, { forked_from_id: 'parent' }),
    meta(start + 10, { id: 'parent' }),
    turn(start + 20, 'gpt-6-sol'),
    tokens(start + 30, 900, 0, 9),
    tokens(start + 40, 800, 0, 8),
    // The fork's own first call, after a real turn.
    tokens(start + 6000, 1000, 600, 50),
    // Codex says the same count twice in a row sometimes.
    tokens(start + 6001, 1000, 600, 50),
    turn(start + 7000, 'gpt-6-luna'),
    tokens(start + 9000, 2000, 0, 50),
  ];
  const calls = lines.map(read).filter((call) => call !== null);
  expect(calls.map(({ model, tokens }) => [model, tokens])).toEqual([
    ['gpt-6-sol', { input: 400, cacheRead: 600, cacheWrite: 0, output: 50 }],
    ['gpt-6-luna', { input: 2000, cacheRead: 0, cacheWrite: 0, output: 50 }],
  ]);
});

test('a call is counted once, priced by its model, and in the day it was made', () => {
  const prices = readPrices(PRICES);
  expect([...prices.keys()].sort()).toEqual(['claude-opus-5-5', 'gpt-6-sol']);
  // 9 November 2026, in the afternoon on this machine's clock.
  const now = new Date('2026-11-09T15:00:00').getTime();
  const call = (at: number, id: string, written1h = 0, model?: string) =>
    claudeCall(claude(at, id, opusUsage(written1h), model))!;
  const stats = summarize(
    [
      call(now - HOUR, 'a', 2_000_000),
      // The same answer again, from another line or a resumed session's file.
      call(now - HOUR, 'a', 2_000_000),
      call(new Date('2026-11-01T09:00:00').getTime(), 'b'),
      // Before the 30 days: 11 October is the first day.
      call(new Date('2026-10-10T23:59:00').getTime(), 'c'),
      call(new Date('2026-10-11T00:01:00').getTime(), 'd'),
      call(now - HOUR, 'e', 0, '<synthetic>'),
    ],
    prices,
    30,
    now,
  );
  expect(stats.total).toBeCloseTo(OPUS_1H + 2 * OPUS_5M);
  expect(stats.daily).toHaveLength(30);
  expect(stats.daily[0]).toEqual({ day: '2026-10-11', claude: expect.closeTo(OPUS_5M), codex: 0 });
  expect(stats.daily.find((row) => row.day === '2026-11-01')!.claude).toBeCloseTo(OPUS_5M);
  expect(stats.daily.at(-1)).toEqual({ day: '2026-11-09', claude: expect.closeTo(OPUS_1H), codex: 0 });
  expect(stats.models.map(({ model, cost }) => [model, cost && Math.round(cost)])).toEqual([
    ['claude-opus-5-5', OPUS_1H + 2 * OPUS_5M],
    ['<synthetic>', null],
  ]);
});

let home: string;
let pricesUrl: string;
let priceServer: ReturnType<typeof createServer>;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'acocrew-usage-'));
  priceServer = createServer((req, res) => {
    if (req.url !== '/prices.json') res.statusCode = 404;
    res.end(JSON.stringify(PRICES));
  });
  await new Promise<void>((done) => priceServer.listen(0, '127.0.0.1', done));
  pricesUrl = `http://127.0.0.1:${(priceServer.address() as AddressInfo).port}/prices.json`;
});
afterAll(() => {
  priceServer.close();
  rmSync(home, { recursive: true });
});

const write = (path: string, lines: string[]) => {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), lines.join('\n') + '\n');
};

test('the logs of both programs are read from the home folder, and read again only when they change', async () => {
  const at = Date.now() - 1000;
  const project = '.claude/projects/-home-marcho-shop';
  write(`${project}/one.jsonl`, [claude(at, 'a', opusUsage()), claude(at, 'a', opusUsage())]);
  // A subagent's log sits in a folder of its session, and a resumed session repeats an answer of the first.
  write(`${project}/one/subagents/agent-1.jsonl`, [
    claude(at, 'b', opusUsage(2_000_000)),
    claude(at, 'a', opusUsage()),
  ]);
  write('.claude/projects/notes.txt', ['not a log']);
  write('.codex/sessions/2026/11/09/rollout.jsonl', [meta(at), turn(at, 'gpt-6-sol'), tokens(at, 1e6, 0, 1e5)]);

  const usage = createUsage(home, pricesUrl);
  const first = await usage.stats();
  // Codex: 1M input at $2 and 100K output at $10.
  expect(first.daily.at(-1)).toEqual({ day: expect.any(String), claude: expect.closeTo(OPUS_5M + OPUS_1H), codex: 3 });
  expect(first.total).toBeCloseTo(OPUS_5M + OPUS_1H + 3);
  expect(first.models.map(({ provider, model }) => `${provider} ${model}`)).toEqual([
    'claude claude-opus-5-5',
    'codex gpt-6-sol',
  ]);

  appendFileSync(join(home, `${project}/one.jsonl`), claude(at, 'c', opusUsage()) + '\n');
  expect((await usage.stats()).total).toBeCloseTo(2 * OPUS_5M + OPUS_1H + 3);
});

test('a machine with no logs has nothing to show, and a price list that does not load says so', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'acocrew-usage-empty-'));
  const stats = await createUsage(empty, pricesUrl).stats();
  expect(stats.total).toBe(0);
  expect(stats.models).toEqual([]);
  expect(stats.daily.every((row) => row.claude === 0 && row.codex === 0)).toBe(true);
  await expect(createUsage(empty, pricesUrl.replace('prices', 'gone')).stats()).rejects.toThrow(
    'The price list did not load (404).',
  );
  rmSync(empty, { recursive: true });
});
