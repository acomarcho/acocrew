// What the machine's Claude Code and Codex would have cost at API prices. Both write a log of every session to
// the home folder, with the tokens each model call took. We add those up per day and model, and price them with
// LiteLLM's public price list (the one t3code and ccusage use). It is an estimate: a subscription is not billed
// per token, and the logs do not say which price tier served a call.
import type { UsageProvider, UsageStats, UsageTokens } from '@acocrew/shared';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
// The price list changes rarely, so it is fetched again at most once a day.
const PRICES_FOR = 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// One model call. `key` is set when the same call can show up more than once and only the first one counts.
// `hourWrite` is the part of `cacheWrite` kept for an hour, which costs more than the usual 5 minutes.
export type Call = {
  provider: UsageProvider;
  at: number;
  model: string;
  key: string | null;
  tokens: UsageTokens;
  hourWrite: number;
};

// Dollars per token, per kind of token.
type Rate = UsageTokens & { hourWrite: number };

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const time = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);
const parse = (line: string) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

// A Claude Code log has one line per piece of an answer (text, a tool call), and each repeats the usage of the
// whole answer. A resumed or forked session copies earlier lines into a new file too. So a call is counted once,
// by its message and request id.
export function claudeCall(line: string): Call | null {
  if (!line.includes('"usage"')) return null;
  const record = parse(line);
  const usage = record?.message?.usage;
  const at = time(record?.timestamp);
  if (record?.type !== 'assistant' || !usage || !record.message.model || Number.isNaN(at)) return null;
  const { id, model } = record.message;
  const key = id || record.requestId ? `${id ?? ''}:${record.requestId ?? ''}` : null;
  return {
    provider: 'claude',
    at,
    model,
    key,
    tokens: {
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      output: num(usage.output_tokens),
    },
    hourWrite: num(usage.cache_creation?.ephemeral_1h_input_tokens),
  };
}

// A Codex log says its model in `turn_context` lines and the tokens of each call in `token_count` lines, so it is
// read in order. Codex sometimes says the same `token_count` twice in a row, and only the first counts. A forked
// or subagent session starts with its parent's lines copied in, all stamped within a second of the start. Those
// were counted in the parent's file, so they are skipped.
export function codexReader() {
  let model = '';
  let last = '';
  let started = false;
  let copiedUntil = 0;
  return (line: string): Call | null => {
    if (!/"(token_count|turn_context|session_meta)"/.test(line)) return null;
    const record = parse(line);
    const payload = record?.payload;
    const at = time(record?.timestamp);
    if (!payload || Number.isNaN(at)) return null;
    if (record.type === 'session_meta') {
      // Only the first one is about this file. A fork repeats its parents' after it.
      const forked = payload.forked_from_id || payload.source?.subagent?.thread_spawn?.parent_thread_id;
      if (!started && forked) copiedUntil = at;
      started = true;
      return null;
    }
    if (record.type === 'turn_context') {
      model = payload.model || model;
      return null;
    }
    const usage = payload.type === 'token_count' && payload.info?.last_token_usage;
    if (!usage || !model) return null;
    const signature = JSON.stringify(usage);
    if (signature === last) return null;
    last = signature;
    // A copied line comes less than a second after the one before it. The first real call ends the copies.
    if (copiedUntil && at - copiedUntil < 1000) {
      copiedUntil = at;
      return null;
    }
    copiedUntil = 0;
    // Codex counts the cached part inside `input_tokens`.
    const cacheRead = num(usage.cached_input_tokens);
    const cacheWrite = num(usage.cache_write_input_tokens);
    return {
      provider: 'codex',
      at,
      model,
      key: null,
      tokens: {
        input: Math.max(0, num(usage.input_tokens) - cacheRead - cacheWrite),
        cacheRead,
        cacheWrite,
        output: num(usage.output_tokens),
      },
      hourWrite: 0,
    };
  };
}

// The price list, as dollars per token per model. Models are looked up without a `provider/` in front and in
// lower case. A model with no input or output price is left out rather than priced at part of its cost. Cache
// prices a model does not have are taken as its input price.
export function readPrices(list: Record<string, Record<string, unknown>>) {
  const prices = new Map<string, Rate>();
  for (const [name, entry] of Object.entries(list)) {
    const input = num(entry?.input_cost_per_token);
    const output = num(entry?.output_cost_per_token);
    if (!input || !output) continue;
    const cacheWrite = num(entry.cache_creation_input_token_cost) || input;
    prices.set(modelName(name), {
      input,
      output,
      cacheRead: num(entry.cache_read_input_token_cost) || input,
      cacheWrite,
      hourWrite: num(entry.cache_creation_input_token_cost_above_1hr) || cacheWrite,
    });
  }
  return prices;
}

const modelName = (model: string) => model.toLowerCase().split('/').pop()!;

const cost = (rate: Rate, { tokens, hourWrite }: Call) =>
  tokens.input * rate.input +
  tokens.cacheRead * rate.cacheRead +
  (tokens.cacheWrite - hourWrite) * rate.cacheWrite +
  hourWrite * rate.hourWrite +
  tokens.output * rate.output;

// A day on the server's clock, as 'YYYY-MM-DD'.
const dayOf = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// Adds up the calls since midnight `days - 1` days ago. Calls are taken in the order given, so the first of
// several with the same key is the one that counts.
export function summarize(calls: Call[], prices: Map<string, Rate>, days: number, now = Date.now()): UsageStats {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = new Date(midnight);
  since.setDate(since.getDate() - (days - 1));
  const daily = new Map<string, UsageStats['daily'][number]>();
  for (let i = 0; i < days; i++) {
    const day = dayOf(new Date(since).setDate(since.getDate() + i));
    daily.set(day, { day, claude: 0, codex: 0 });
  }
  const models = new Map<string, UsageStats['models'][number]>();
  const seen = new Set<string>();
  let total = 0;
  for (const call of calls) {
    if (call.at < since.getTime() || call.at > now) continue;
    if (call.key) {
      if (seen.has(call.key)) continue;
      seen.add(call.key);
    }
    const id = `${call.provider}/${call.model}`;
    const row = models.get(id) ?? {
      provider: call.provider,
      model: call.model,
      cost: null,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    };
    models.set(id, row);
    for (const kind of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) row.tokens[kind] += call.tokens[kind];
    const rate = prices.get(modelName(call.model));
    if (!rate) continue;
    const dollars = cost(rate, call);
    row.cost = (row.cost ?? 0) + dollars;
    daily.get(dayOf(call.at))![call.provider] += dollars;
    total += dollars;
  }
  return {
    days,
    total,
    daily: [...daily.values()],
    models: [...models.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
  };
}

// Reads the logs in `home` and prices them. A log file is read again only when it changed since the last time,
// so only the first look after the server starts reads everything (several GB on a busy machine: lines are
// read one at a time and only the ones with usage are parsed, so the server keeps answering meanwhile).
export function createUsage(home: string, pricesUrl = PRICES_URL) {
  const folders: [UsageProvider, string][] = [
    ['claude', join(home, '.claude', 'projects')],
    ['codex', join(home, '.codex', 'sessions')],
  ];
  const files = new Map<string, { size: number; mtime: number; calls: Call[] }>();
  let prices: { at: number; list: Promise<Map<string, Rate>> } | null = null;
  let running: Promise<UsageStats> | null = null;

  const loadPrices = () => {
    if (!prices || Date.now() - prices.at > PRICES_FOR) {
      const list = fetch(pricesUrl)
        .then((res) => {
          if (!res.ok) throw new Error(`The price list did not load (${res.status}).`);
          return res.json() as Promise<Record<string, Record<string, unknown>>>;
        })
        .then(readPrices);
      // A failed fetch is tried again next time.
      list.catch(() => (prices = null));
      prices = { at: Date.now(), list };
    }
    return prices.list;
  };

  const readFile = async (provider: UsageProvider, path: string) => {
    const read = provider === 'claude' ? claudeCall : codexReader();
    const calls: Call[] = [];
    // Repeats within a file are dropped right away, to keep half as much. Those across files are dropped later.
    const keys = new Set<string>();
    const lines = createInterface({ input: createReadStream(path, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
    for await (const line of lines) {
      const call = read(line);
      if (!call || (call.key && keys.has(call.key))) continue;
      if (call.key) keys.add(call.key);
      calls.push(call);
    }
    return calls;
  };

  // Every call in log files changed in the last `days` days. A file last changed before then has no later calls.
  const readCalls = async (days: number) => {
    const since = Date.now() - (days + 1) * DAY;
    const calls: Call[] = [];
    for (const [provider, folder] of folders) {
      const names = await readdir(folder, { recursive: true }).catch(() => [] as string[]);
      for (const name of names.filter((name) => name.endsWith('.jsonl')).sort()) {
        const path = join(folder, name);
        const { size, mtimeMs: mtime } = await stat(path);
        if (mtime < since) continue;
        let file = files.get(path);
        if (file?.size !== size || file.mtime !== mtime) {
          file = { size, mtime, calls: await readFile(provider, path) };
          files.set(path, file);
        }
        for (const call of file.calls) calls.push(call);
      }
    }
    return calls;
  };

  // The last 30 days. Several people asking at once share one read.
  const stats = () => {
    running ??= Promise.all([readCalls(30), loadPrices()])
      .then(([calls, list]) => summarize(calls, list, 30))
      .finally(() => (running = null));
    return running;
  };

  return { stats };
}
