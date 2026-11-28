import type { Answer, Item } from '@acocrew/shared';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { createCodexTurn, type CodexTurn } from './codex.ts';

type TurnParams = Parameters<CodexTurn>[0];
type Wire = {
  method?: string;
  params?: Record<string, unknown>;
  id?: string | number;
  result?: unknown;
  error?: unknown;
  pid?: number;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
};
const model = 'gpt-5.4';
const threadId = '019fed00-0000-7000-8000-000000000001';
const turnId = '019fed00-0000-7000-8000-000000000002';
const binary = fileURLToPath(new URL('./codex.fake.mjs', import.meta.url));
const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(scenario: string, settings?: Partial<Parameters<typeof createCodexTurn>[0]>) {
  const root = await mkdtemp(join(homedir(), '.acocrew-codex-test-'));
  folders.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'worktree');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  await writeFile(join(cwd, 'scenario'), scenario);
  const stop = new AbortController();
  const sessions: [string | null, string | undefined][] = [];
  const updates: { item: Item; save: boolean }[] = [];
  const run = createCodexTurn({ home, model, binary, ...settings });
  const call = (params?: Partial<TurnParams>) =>
    run({
      cwd,
      model,
      sessionId: null,
      text: 'hello',
      effort: 'high',
      access: 'ask',
      signal: stop.signal,
      onSession: (id, path) => {
        sessions.push([id, path]);
      },
      onItem: (item, save) => {
        updates.push({ item, save });
      },
      onApproval: async () => {
        throw new Error('Unexpected approval');
      },
      ...params,
    });
  const wire = async (): Promise<Wire[]> => {
    const data = await readFile(join(cwd, 'wire.jsonl'), 'utf8').catch(() => '');
    return data
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  return { call, wire, home, cwd, stop, sessions, updates };
}

const method = (wire: Wire[], name: string) => wire.find((line) => line.method === name);
const messages = (updates: Awaited<ReturnType<typeof fixture>>['updates']) =>
  updates.filter((event) => event.item.kind === 'message');
const expectExited = (wire: Wire[]) => {
  const pids = wire.flatMap((line) => (line.pid ? [line.pid] : []));
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow('ESRCH');
};

test('persists the native ID before input, isolates the child, and saves final text and tools once', async () => {
  const path = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).join(delimiter);
  vi.stubEnv('PATH', `.${delimiter}${delimiter}${path}${delimiter}bin`);
  vi.stubEnv('OPENAI_API_KEY', 'sentinel');
  vi.stubEnv('OPENAI_BASE_URL', 'https://example.invalid');
  vi.stubEnv('HTTPS_PROXY', 'https://example.invalid');
  vi.stubEnv('CODEX_HOME', '/not-the-dedicated-home');
  vi.stubEnv('ANTHROPIC_API_KEY', 'sentinel');
  vi.stubEnv('ACOCREW_SECRET_TEST', 'sentinel');
  const f = await fixture('normal');
  await expect(f.call()).resolves.toBe('completed');
  const wire = await f.wire();
  expect(f.sessions).toEqual([
    [threadId, join(f.home, `${threadId}.jsonl`)],
    [threadId, undefined],
  ]);
  expect(wire[0].env).toMatchObject({ CODEX_HOME: f.home, PATH: path });
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY', 'ACOCREW_SECRET_TEST']) {
    expect(wire[0].env).not.toHaveProperty(name);
  }
  expect(wire[0].argv).toEqual(
    expect.arrayContaining([
      'app-server',
      '--stdio',
      'model_provider="openai"',
      'openai_base_url=""',
      'chatgpt_base_url="https://chatgpt.com/backend-api/"',
      `projects={${JSON.stringify(f.cwd)}={trust_level="untrusted"}}`,
    ]),
  );
  expect(wire.flatMap((line) => (line.method ? [line.method] : []))).toEqual([
    'initialize',
    'initialized',
    'config/read',
    'account/read',
    'thread/start',
    'turn/start',
  ]);
  expect(method(wire, 'initialize')?.params).toMatchObject({ capabilities: { experimentalApi: true } });
  expect(method(wire, 'account/read')?.params).toEqual({ refreshToken: false });
  expect(method(wire, 'thread/start')?.params).toEqual({
    cwd: f.cwd,
    model,
    modelProvider: 'openai',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    ephemeral: false,
  });
  expect(method(wire, 'turn/start')?.params).toEqual({
    threadId,
    input: [{ type: 'text', text: 'hello', text_elements: [] }],
    effort: 'high',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  });
  const text = messages(f.updates);
  expect(text).toMatchObject([
    { save: false, item: { by: 'codex', text: 'Hi' } },
    { save: false, item: { by: 'codex', text: 'Hi there' } },
    { save: true, item: { by: 'codex', text: 'Hi there!' } },
  ]);
  expect(new Set(text.map(({ item }) => item.id)).size).toBe(1);
  expect(f.updates.filter(({ item }) => item.kind === 'tool')).toMatchObject([
    { save: false, item: { name: 'Command', done: false } },
    { save: false, item: { name: 'Command', output: 'hello\n', done: false } },
    { save: true, item: { name: 'Command', output: 'hello\n', done: true, failed: false } },
    { save: true, item: { name: 'File changes', done: true, failed: true } },
  ]);
  expectExited(wire);
});

test('drains the child output pipe after the terminal event without publishing late rows', async () => {
  const f = await fixture('late-output');
  await expect(f.call()).resolves.toBe('completed');
  const wire = await f.wire();
  expect(wire).toContainEqual({ flushed: true });
  expect(f.updates).toEqual([]);
  expectExited(wire);
});

test('resumes the same native thread using a fresh child and never reuses transcript row IDs', async () => {
  const f = await fixture('normal');
  await expect(f.call()).resolves.toBe('completed');
  const first = messages(f.updates).at(-1)?.item;
  await expect(f.call({ sessionId: threadId, access: 'full', effort: '', text: 'follow-up' })).resolves.toBe(
    'completed',
  );
  const wire = await f.wire();
  expect(wire.filter((line) => line.method === 'thread/start')).toHaveLength(1);
  expect(f.sessions).toEqual([
    [threadId, join(f.home, `${threadId}.jsonl`)],
    [threadId, undefined],
    [threadId, undefined],
  ]);
  expect(method(wire, 'thread/resume')?.params).toMatchObject({
    threadId,
    excludeTurns: true,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
  });
  expect(wire.filter((line) => line.method === 'turn/start')[1].params).toMatchObject({
    threadId,
    input: [{ text: 'follow-up' }],
    effort: null,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  });
  expect(messages(f.updates).at(-1)?.item.id).not.toEqual(first?.id);
  expect(new Set(wire.flatMap((line) => (line.pid ? [line.pid] : []))).size).toBe(2);
  expectExited(wire);
});

test.each([
  ['wrong-config', 'openai_base_url', false],
  ['mcp-config', 'mcp_servers', false],
  ['api-key', 'Sign in to ChatGPT', false],
  ['wrong-provider', 'native OpenAI model', false],
  ['wrong-sandbox', 'access settings', false],
  ['wrong-id', 'requested persistent, idle thread', true],
  ['resume-error', 'no rollout found', true],
] as const)('fails closed for %s without sending user input', async (scenario, error, resume) => {
  const f = await fixture(scenario);
  await expect(f.call({ sessionId: resume ? threadId : null })).rejects.toThrow(error);
  const wire = await f.wire();
  expect(method(wire, 'turn/start')).toBeUndefined();
  if (resume) expect(method(wire, 'thread/start')).toBeUndefined();
  expect(f.sessions).toEqual([]);
  expectExited(wire);
});

test('accepts only exact browser approvals and returns typed denials for unsupported requests', async () => {
  const f = await fixture('approvals');
  const prompts: Item[] = [];
  const decisions: Answer['decision'][] = ['approve', 'always', 'approve', 'approve', 'cancel'];
  const onApproval: TurnParams['onApproval'] = async (item) => {
    prompts.push(item);
    return { toolId: prompts.length === 3 ? 'wrong-item' : item.id, decision: decisions[prompts.length - 1] };
  };
  await expect(f.call({ onApproval })).resolves.toBe('interrupted');
  expect(prompts).toHaveLength(5);
  expect(new Set(prompts.map(({ id }) => id)).size).toBe(prompts.length);
  expect(prompts[0]).toMatchObject({ ask: 'pending', done: false, detail: expect.stringContaining(f.cwd) });
  expect(prompts[0].kind === 'tool' && JSON.parse(prompts[0].input ?? '{}')).toMatchObject({
    command: 'printf "hello\\n"',
    cwd: f.cwd,
  });
  expect(prompts[3].kind === 'tool' && JSON.parse(prompts[3].input ?? '[]')).toEqual([
    { path: `${f.cwd}/test.txt`, kind: { type: 'add' }, diff: 'hello\n' },
  ]);
  expect(f.updates.filter(({ item }) => item.kind === 'tool' && item.ask === 'pending')).toEqual([]);
  expect(f.updates.filter(({ item }) => item.kind === 'tool' && item.ask)).toMatchObject(
    ['approved', 'declined', 'declined', 'approved', 'declined'].map((ask, i) => ({
      save: true,
      item: { id: prompts[i].id, ask, done: true },
    })),
  );
  const wire = await f.wire();
  const replies = Object.fromEntries(
    wire.filter((line) => typeof line.id === 'string').map((line) => [line.id, line.result ?? line.error]),
  );
  expect(replies).toEqual({
    approve: { decision: 'accept' },
    always: { decision: 'decline' },
    'wrong-id': { decision: 'decline' },
    patch: { decision: 'accept' },
    'grant-root': { decision: 'decline' },
    'missing-patch': { decision: 'decline' },
    network: { decision: 'decline' },
    'network-amendment': { decision: 'decline' },
    'extra-permissions': { decision: 'decline' },
    stdin: { decision: 'decline' },
    'old-turn': { decision: 'decline' },
    'no-turn': { decision: 'decline' },
    permissions: { permissions: {}, scope: 'turn' },
    question: { answers: {} },
    elicitation: { action: 'decline' },
    dynamic: { success: false, contentItems: [] },
    legacy: { decision: { denied: { rejection: expect.any(String) } } },
    auth: { code: -32601, message: expect.any(String) },
    unknown: { code: -32601, message: expect.any(String) },
    cancel: { decision: 'cancel' },
  });
  expectExited(wire);
});

test('ignores an answer after Codex withdraws its approval request', async () => {
  const f = await fixture('late-approval');
  let answer: () => void = () => {
    throw new Error('Expected approval');
  };
  await expect(
    f.call({
      onApproval: (item) =>
        new Promise((resolve) => {
          answer = () => resolve({ toolId: item.id, decision: 'approve' });
        }),
    }),
  ).resolves.toBe('completed');
  answer();
  await Promise.resolve();
  expect(f.updates).toMatchObject([{ save: true, item: { ask: 'declined', done: true } }]);
  const wire = await f.wire();
  expect(wire.find((line) => line.id === 'late')).toBeUndefined();
  expectExited(wire);
});

test('stops before spawn, during initialize, and after saving the ID but before sending user input', async () => {
  const f = await fixture('boot-stop');
  f.stop.abort();
  await expect(f.call()).resolves.toBe('interrupted');
  expect(await f.wire()).toEqual([]);
  const boot = new AbortController();
  const running = f.call({ signal: boot.signal });
  await vi.waitFor(async () => expect(method(await f.wire(), 'initialize')).toBeDefined());
  boot.abort();
  await expect(running).resolves.toBe('interrupted');
  expectExited(await f.wire());
  const beforeInput = await fixture('normal');
  await expect(
    beforeInput.call({
      onSession: (id, path) => {
        beforeInput.sessions.push([id, path]);
        beforeInput.stop.abort();
      },
    }),
  ).resolves.toBe('interrupted');
  expect(beforeInput.sessions).toEqual([
    [threadId, join(beforeInput.home, `${threadId}.jsonl`)],
    [null, undefined],
  ]);
  expect(method(await beforeInput.wire(), 'turn/start')).toBeUndefined();
  expectExited(await beforeInput.wire());
});

test('a rejected first turn releases only an allocated ID with no history', async () => {
  const first = await fixture('reject-start');
  await expect(first.call()).rejects.toThrow('Turn rejected.');
  expect(first.sessions).toEqual([
    [threadId, join(first.home, `${threadId}.jsonl`)],
    [null, undefined],
  ]);
  const resumed = await fixture('reject-start');
  await expect(resumed.call({ sessionId: threadId })).rejects.toThrow('Turn rejected.');
  expect(resumed.sessions).toEqual([[threadId, undefined]]);
});

test.each([false, true])('recovers a provisional ID after a crash (history exists: %s)', async (written) => {
  const f = await fixture('normal');
  const pendingRollout = join(f.home, `${threadId}.jsonl`);
  if (written) await writeFile(pendingRollout, 'previous turn\n');
  await expect(f.call({ sessionId: threadId, pendingRollout, text: 'continue' })).resolves.toBe('completed');
  const wire = await f.wire();
  expect(method(wire, written ? 'thread/resume' : 'thread/start')).toBeDefined();
  expect(method(wire, written ? 'thread/start' : 'thread/resume')).toBeUndefined();
  expect(f.sessions[0]).toEqual(written ? [threadId, undefined] : [null, undefined]);
  expect(f.sessions.at(-1)).toEqual([threadId, undefined]);
});

test('interrupts after delayed turn ID and drops late output', async () => {
  const f = await fixture('early-stop');
  const running = f.call();
  await vi.waitFor(async () => expect(method(await f.wire(), 'turn/start')).toBeDefined());
  f.stop.abort();
  await expect(running).resolves.toBe('interrupted');
  const wire = await f.wire();
  expect(method(wire, 'turn/interrupt')?.params).toEqual({ threadId, turnId });
  expect(f.updates).toEqual([]);
  expectExited(wire);
});

test('cancels pending browser approval during Stop and never sends its late answer', async () => {
  const f = await fixture('stop-approval');
  let answer: (() => void) | undefined;
  const running = f.call({
    onApproval: (item) =>
      new Promise((resolve) => {
        answer = () => resolve({ toolId: item.id, decision: 'approve' });
      }),
  });
  await vi.waitFor(() => expect(answer).toBeDefined());
  f.stop.abort();
  answer?.();
  await expect(running).resolves.toBe('interrupted');
  const wire = await f.wire();
  expect(wire.filter((line) => line.id === 'late')).toEqual([{ id: 'late', result: { decision: 'cancel' } }]);
  expect(method(wire, 'turn/interrupt')?.params).toEqual({ threadId, turnId });
  expect(f.updates).toEqual([]);
  expectExited(wire);
});

test('kills an unresponsive child even if it never returns a turn ID or responds to SIGTERM', async () => {
  const f = await fixture('stubborn');
  const running = f.call();
  await vi.waitFor(async () => expect(method(await f.wire(), 'turn/start')).toBeDefined());
  f.stop.abort();
  await expect(running).resolves.toBe('interrupted');
  const wire = await f.wire();
  expect(method(wire, 'turn/interrupt')).toBeUndefined();
  expectExited(wire);
}, 4_000);

test.each([
  ['eof', 'closed its output'],
  ['bad-json', 'Could not process a Codex event'],
  ['failed', 'provider said no'],
])('fails and reaps the child after %s', async (scenario, error) => {
  const f = await fixture(scenario);
  await expect(f.call()).rejects.toThrow(error);
  expectExited(await f.wire());
});

test('rejects a missing dedicated home or CLI before a prompt can run', async () => {
  const missingHome = await fixture('normal', { home: join(homedir(), '.acocrew-codex-home-does-not-exist') });
  await expect(missingHome.call()).rejects.toThrow('existing home directory');
  const missingCli = await fixture('normal', { binary: '/no/such/codex-binary' });
  await expect(missingCli.call()).rejects.toThrow('Could not launch Codex');
  expect(await missingCli.wire()).toEqual([]);
});
