import type { Access, Answer, Item } from '@acocrew/shared';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { nextAt } from './translate.ts';

export type CodexConfig = { home: string; model: string; binary?: string };
export type CodexTurn = (params: {
  cwd: string;
  sessionId: string | null;
  pendingRollout?: string | null;
  text: string;
  model: string;
  effort: string;
  access: Access;
  signal: AbortSignal;
  onSession: (id: string | null, pendingRollout?: string) => void;
  onItem: (item: Item, save: boolean) => void;
  onApproval: (item: Item) => Promise<Answer | null>;
}) => Promise<'completed' | 'interrupted'>;

type Obj = Record<string, unknown>;
type RpcId = string | number;
type Tool = Extract<Item, { kind: 'tool' }>;
type Message = Extract<Item, { kind: 'message' }>;
export class CodexTeardownError extends Error {}

type Outcome = Awaited<ReturnType<CodexTurn>> | Error;
const obj = (value: unknown): Obj =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const rpcId = (value: unknown): value is RpcId => typeof value === 'string' || typeof value === 'number';
const err = (value: unknown) => (value instanceof Error ? value : new Error(String(value)));
const MAX_TOOL_TEXT = 20_000;
const BOOT_MS = 30_000;
const STOP_MS = 1_000;
const PROVIDER = 'openai';
const CHATGPT_BASE = 'https://chatgpt.com/backend-api/';

// Empty openai_base_url selects the built-in URL for the actual login mode. Pinning the public API URL instead
// would also send ChatGPT model requests there. Do not pass proxy settings, provider keys, or the server's secrets.
const NATIVE_SETTINGS = {
  model_provider: PROVIDER,
  openai_base_url: '',
  chatgpt_base_url: CHATGPT_BASE,
  'features.respect_system_proxy': false,
  forced_login_method: 'chatgpt',
  mcp_servers: {},
  web_search: 'disabled',
  'features.apps': false,
  'features.plugins': false,
  'features.hooks': false,
  'features.remote_plugin': false,
};
const ARGS = [
  'app-server',
  '--stdio',
  ...Object.entries(NATIVE_SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`]),
];

function nativeEnv(home: string): NodeJS.ProcessEnv {
  // Relative and empty PATH entries would resolve in the checkout, before the sandbox starts.
  const path = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).join(delimiter);
  if (!path) throw new Error('Codex needs a server PATH with at least one absolute directory.');
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home, PATH: path };
  for (const name of [
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TERM',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

async function dedicatedHome(path: string) {
  if (!isAbsolute(path)) throw new Error('Codex needs an absolute, dedicated home directory.');
  const home = await realpath(path).catch(() => null);
  const defaultPath = join(homedir(), '.codex');
  const defaultHome = await realpath(defaultPath).catch(() => defaultPath);
  if (!home || home === defaultHome || !(await stat(home)).isDirectory()) {
    throw new Error('Codex needs an existing home directory separate from the host’s default Codex home.');
  }
  return home;
}

function checkConfig(config: Obj) {
  for (const [key, value] of Object.entries(NATIVE_SETTINGS)) {
    const actual = key.split('.').reduce<unknown>((node, part) => obj(node)[part], config);
    if (
      key === 'mcp_servers'
        ? !actual || typeof actual !== 'object' || Array.isArray(actual) || Object.keys(actual).length !== 0
        : actual !== value
    ) {
      throw new Error(`Codex did not apply the required native setting ${key}; no prompt was sent.`);
    }
  }
}

const commandApproval = 'item/commandExecution/requestApproval';
const fileApproval = 'item/fileChange/requestApproval';
const isApproval = (method: string) => method === commandApproval || method === fileApproval;

function refusal(method: string): Obj | undefined {
  switch (method) {
    case commandApproval:
    case fileApproval:
      return { decision: 'decline' };
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: { denied: { rejection: 'This approval method is not supported.' } } };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'mcpServer/elicitation/request':
      return { action: 'decline' };
    case 'item/tool/call':
      return { success: false, contentItems: [] };
  }
}

function describeTool(item: Obj): Pick<Tool, 'name' | 'detail' | 'input'> | undefined {
  switch (item.type) {
    case 'commandExecution':
      return {
        name: 'Command',
        detail: str(item.command),
        input: JSON.stringify({ command: item.command, cwd: item.cwd }),
      };
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return {
        name: 'File changes',
        detail: changes.map((change) => str(obj(change).path)).join(', '),
        input: JSON.stringify(changes, null, 2),
      };
    }
    case 'webSearch':
      return { name: 'Web search', detail: str(item.query) };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return {
        name: 'Tool',
        detail: [item.server, item.tool].filter((part) => typeof part === 'string').join('/'),
        input: JSON.stringify(item.arguments),
      };
    case 'collabAgentToolCall':
      return { name: 'Agent', detail: str(item.tool), input: str(item.prompt) };
  }
}

function approvalDetails(method: string, params: Obj, patch: Obj | undefined) {
  if (method === commandApproval) {
    const { kind, command, cwd, networkApprovalContext, proposedNetworkPolicyAmendments, additionalPermissions } =
      params;
    // Stdin writes and requests for any extra permissions are not ordinary command approvals.
    if (
      (kind !== undefined && kind !== 'command') ||
      networkApprovalContext != null ||
      additionalPermissions != null ||
      (proposedNetworkPolicyAmendments != null &&
        (!Array.isArray(proposedNetworkPolicyAmendments) || proposedNetworkPolicyAmendments.length > 0)) ||
      !str(command) ||
      !str(cwd) ||
      (params.environmentId != null && params.environmentId !== 'local') ||
      (params.availableDecisions != null &&
        (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes('accept')))
    )
      return;
    return {
      name: 'a shell command',
      detail: `${str(command)}\nWorking directory: ${str(cwd)}`,
      input: JSON.stringify(
        { command, cwd, reason: params.reason, approval: 'Codex can run this command outside its sandbox.' },
        null,
        2,
      ),
    };
  }
  // The verified file item is emitted in item/started before Codex requests approval. The reverse request
  // only contains its ID. Never approve an unseen patch or a request to grant access to a whole directory.
  if (
    params.grantRoot != null ||
    !patch ||
    !Array.isArray(patch.changes) ||
    !patch.changes.length ||
    !patch.changes.every(
      (value) => str(obj(value).path) && str(obj(obj(value).kind).type) && typeof obj(value).diff === 'string',
    )
  )
    return;
  const details = describeTool(patch)!;
  return { ...details, name: 'a file patch' };
}

// An unreadable rollout is not proof it is missing. Keep the ID rather than splitting native history.
function hasRollout(path: string) {
  return stat(path).then(
    (entry) => !entry.isFile() || entry.size > 0,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

// Start a new stdio child for each turn. Keep the rollout path until the new native ID is established.
export function createCodexTurn(config: CodexConfig): CodexTurn {
  return async ({
    cwd,
    sessionId,
    pendingRollout,
    text,
    model,
    effort,
    access,
    signal,
    onSession,
    onItem,
    onApproval,
  }) => {
    if (signal.aborted) return 'interrupted';
    // After a crash only provisional IDs can be discarded, and only if Codex never wrote their history.
    if (pendingRollout && !(await hasRollout(pendingRollout))) {
      sessionId = null;
      onSession(null);
    }
    if (signal.aborted) return 'interrupted';
    const [home, folder] = await Promise.all([dedicatedHome(config.home), realpath(cwd)]);
    if (signal.aborted) return 'interrupted';

    const group = process.platform !== 'win32';
    if (config.binary && !isAbsolute(config.binary)) throw new Error('The Codex binary path must be absolute.');
    // Full access must not cause App Server to trust and load settings from the checkout.
    const trust = `projects={${JSON.stringify(folder)}={trust_level="untrusted"}}`;
    const child = spawn(config.binary ?? 'codex', [...ARGS, '-c', trust], {
      cwd: folder,
      env: nativeEnv(home),
      detached: group,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const waiters = new Map<
      RpcId,
      { method: string; resolve: (response: Obj) => void; reject: (error: Error) => void }
    >();
    const answers = new Map<RpcId, Tool>();
    const items = new Map<string, Message | Tool>();
    const finalized = new Set<string>();
    const patches = new Map<string, Obj>();
    const early: Obj[] = [];
    let stderr = '';
    let turnError = '';
    let serial = 0;
    let threadId: string | undefined;
    let newRollout: string | undefined;
    let turnId: string | undefined;
    let sentTurn = false;
    let turnSettled = false;
    let stopped = false;
    let terminal = false;
    let closed = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<void>((resolve) =>
      child.once('close', () => {
        closed = true;
        resolve();
      }),
    );
    let settle!: (outcome: Outcome) => void;
    const result = new Promise<Outcome>((resolve) => {
      settle = resolve;
    });

    function finish(outcome: Outcome) {
      if (terminal) return;
      terminal = true;
      clearTimeout(bootTimer);
      clearTimeout(stopTimer);
      settle(stopped ? 'interrupted' : outcome);
      for (const waiter of waiters.values()) waiter.reject(new Error('Codex turn ended.'));
      waiters.clear();
      answers.clear();
    }

    const stop = () => {
      if (stopped || terminal) return;
      stopped = true;
      if (!sentTurn) return finish('interrupted');
      stopTimer = setTimeout(() => finish('interrupted'), STOP_MS);
      for (const id of answers.keys()) send({ id, result: { decision: 'cancel' } });
      answers.clear();
      interrupt();
    };

    function send(message: Obj) {
      if (!terminal) child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function request(method: string, params: Obj) {
      if (terminal) return Promise.reject(new Error('Codex turn ended.'));
      const id = ++serial;
      return new Promise<Obj>((resolve, reject) => {
        waiters.set(id, { method, resolve, reject });
        send({ id, method, params });
      });
    }

    function interrupt() {
      if (threadId && turnId) {
        // The reply only acknowledges the request. Keep waiting for the terminal event or the stop deadline.
        void request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
    }

    function rejectRequest(id: RpcId, method: string) {
      const result = refusal(method);
      send(
        result
          ? { id, result }
          : { id, error: { code: -32601, message: 'This Codex server request is not supported.' } },
      );
    }

    async function approve(id: RpcId, method: string, params: Obj) {
      const itemId = str(params.itemId);
      const patch = patches.get(itemId);
      const details =
        access === 'ask' && !stopped && itemId && !finalized.has(itemId)
          ? approvalDetails(method, params, patch)
          : undefined;
      if (!details || (details.input?.length ?? 0) > MAX_TOOL_TEXT || details.detail.length > MAX_TOOL_TEXT)
        return rejectRequest(id, method);
      if (answers.has(id)) return;
      const item: Tool = {
        id: randomUUID(),
        at: nextAt(),
        kind: 'tool',
        ...details,
        done: false,
        failed: false,
        ask: 'pending',
      };
      answers.set(id, item);
      const answer = await onApproval(item).catch(() => null);
      if (terminal || stopped || !answers.delete(id)) return;
      const stillExact = !finalized.has(itemId) && (method !== fileApproval || patches.get(itemId) === patch);
      const decision =
        answer?.toolId === item.id && answer.decision === 'approve' && stillExact
          ? 'accept'
          : answer?.toolId === item.id && answer.decision === 'cancel'
            ? 'cancel'
            : 'decline';
      send({ id, result: { decision } });
      closeApproval(item, decision === 'accept');
    }

    function closeApproval(item: Tool, approved: boolean) {
      onItem(
        { ...item, ask: approved ? 'approved' : 'declined', done: true, failed: !approved, endAt: nextAt() },
        true,
      );
    }

    function emitItem(raw: Obj, done: boolean) {
      const itemId = str(raw.id);
      if (!itemId || finalized.has(itemId)) return;
      const prior = items.get(itemId);
      const base = { id: prior?.id ?? randomUUID(), at: prior?.at ?? nextAt() };
      if (raw.type === 'agentMessage') {
        if (!done || typeof raw.text !== 'string') return;
        const item: Message = { ...base, kind: 'message', by: 'codex', text: raw.text };
        items.set(itemId, item);
        finalized.add(itemId);
        onItem(item, true);
        return;
      }
      const details = describeTool(raw);
      if (!details) return;
      if (raw.type === 'fileChange' && !done) patches.set(itemId, raw);
      const item: Tool = {
        ...base,
        kind: 'tool',
        ...details,
        detail: details.detail.slice(0, 300),
        input: details.input?.slice(0, MAX_TOOL_TEXT),
        done,
        failed:
          raw.status === 'failed' ||
          raw.status === 'declined' ||
          raw.success === false ||
          (typeof raw.exitCode === 'number' && raw.exitCode !== 0),
        output:
          typeof raw.aggregatedOutput === 'string'
            ? raw.aggregatedOutput.slice(0, MAX_TOOL_TEXT)
            : prior?.kind === 'tool'
              ? prior.output
              : undefined,
        endAt: done ? nextAt() : undefined,
      };
      items.set(itemId, item);
      if (done) {
        finalized.add(itemId);
        patches.delete(itemId);
      }
      onItem(item, done);
    }

    function notification(method: string, params: Obj) {
      if (method === 'turn/completed') {
        turnSettled = true;
        const turn = obj(params.turn);
        if (!stopped) {
          if (Array.isArray(turn.items)) {
            for (const raw of turn.items.map(obj)) {
              if (raw.status !== 'inProgress') emitItem(raw, true);
            }
          }
          for (const item of answers.values()) closeApproval(item, false);
        }
        if (turn.status === 'completed' || turn.status === 'interrupted') return finish(turn.status);
        return finish(new Error(str(obj(turn.error).message) || turnError || 'Codex reported a failed turn.'));
      }
      if (stopped) return;
      if (method === 'error') {
        if (params.willRetry === false) turnError = str(obj(params.error).message);
        return;
      }
      if (method === 'item/started' || method === 'item/completed')
        return emitItem(obj(params.item), method === 'item/completed');
      const itemId = str(params.itemId);
      if (!itemId || finalized.has(itemId) || typeof params.delta !== 'string' || !params.delta) return;
      const prior = items.get(itemId);
      if (method === 'item/agentMessage/delta' && (!prior || prior.kind === 'message')) {
        const item: Message = {
          id: prior?.id ?? randomUUID(),
          at: prior?.at ?? nextAt(),
          kind: 'message',
          by: 'codex',
          text: (prior?.text ?? '') + params.delta,
        };
        items.set(itemId, item);
        onItem(item, false);
      } else if (
        (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') &&
        prior?.kind === 'tool'
      ) {
        const output = `${prior.output ?? ''}${params.delta}`.slice(0, MAX_TOOL_TEXT);
        if (output === prior.output) return;
        const item = { ...prior, output };
        items.set(itemId, item);
        onItem(item, false);
      }
    }

    function hear(message: Obj) {
      if (terminal) return;
      const { id } = message;
      const method = str(message.method);
      if (!method && rpcId(id)) {
        const waiter = waiters.get(id);
        if (!waiter) return;
        waiters.delete(id);
        if (message.error) {
          if (waiter.method === 'turn/start') turnSettled = true;
          waiter.reject(new Error(`Codex ${waiter.method}: ${str(obj(message.error).message) || 'request failed'}`));
        } else waiter.resolve(obj(message.result));
        return;
      }
      const params = obj(message.params);
      if (rpcId(id) && (!isApproval(method) || stopped || !sentTurn || params.threadId !== threadId))
        return rejectRequest(id, method);
      if (!sentTurn || params.threadId !== threadId) return;
      const resolved = method === 'serverRequest/resolved';
      const eventTurn = method === 'turn/completed' ? obj(params.turn).id : params.turnId;
      if (!resolved && !str(eventTurn)) {
        if (rpcId(id)) rejectRequest(id, method);
        return;
      }
      if (!turnId) {
        // Codex can publish events, including requests, before replying to turn/start.
        if (early.length >= 1_024) return finish(new Error('Codex sent too many events before identifying its turn.'));
        early.push(message);
        return;
      }
      if (resolved && rpcId(params.requestId)) {
        const item = answers.get(params.requestId);
        if (item && answers.delete(params.requestId) && !stopped) closeApproval(item, false);
        return;
      }
      if (eventTurn !== turnId) {
        if (rpcId(id)) rejectRequest(id, method);
        return;
      }
      if (rpcId(id)) void approve(id, method, params).catch((error: unknown) => finish(err(error)));
      else notification(method, params);
    }

    const bootTimer = setTimeout(() => finish(new Error('Codex did not start its turn in time.')), BOOT_MS);
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    child.on('error', (error) => finish(new Error(`Could not launch Codex: ${error.message}`)));
    child.stdin.on('error', (error) => finish(new Error(`Lost Codex's input: ${error.message}`)));
    child.stdout.on('error', (error) => finish(new Error(`Lost Codex's output: ${error.message}`)));
    child.once('close', (code, sig) =>
      finish(
        new Error(
          `Codex closed before finishing its turn (${sig ?? code ?? 'no exit status'}).${stderr.trim() ? `\n${stderr.trim()}` : ''}`,
        ),
      ),
    );
    lines.on('line', (line: string) => {
      if (!line.trim() || (terminal && (!turnId || turnSettled))) return;
      try {
        const message = obj(JSON.parse(line));
        if (!terminal) return hear(message);
        // Keep reading during cleanup, but only use a matching confirmation that the turn ended.
        const params = obj(message.params);
        if (message.method === 'turn/completed' && params.threadId === threadId && obj(params.turn).id === turnId) {
          turnSettled = true;
        }
      } catch (error) {
        finish(new Error(`Could not process a Codex event: ${err(error).message}`));
      }
    });
    lines.on('close', () => {
      // Let the final line and a turn/start reply in the same read finish routing first. The child can close stdout
      // without actually exiting, so waiting only for its exit could leave the thread stuck forever.
      queueMicrotask(() => {
        if (!terminal && !closed) finish(new Error('Codex closed its output before finishing its turn.'));
      });
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();

    async function start() {
      const initialized = await request('initialize', {
        clientInfo: { name: 'acocrew', version: '0.1.0' },
        // 0.160 strips additionalPermissions from command approval requests unless the client opts in.
        capabilities: { experimentalApi: true },
      });
      if (initialized.codexHome !== home) throw new Error('Codex did not select the dedicated home directory.');
      send({ method: 'initialized' });
      checkConfig(obj((await request('config/read', { cwd: folder, includeLayers: false })).config));
      const account = await request('account/read', { refreshToken: false });
      if (account.requiresOpenaiAuth !== true || obj(account.account).type !== 'chatgpt') {
        throw new Error('Sign in to ChatGPT in the dedicated Codex home before starting a Codex thread.');
      }
      const full = access === 'full';
      const approvalPolicy = full ? 'never' : 'on-request';
      const sandbox = full ? 'danger-full-access' : 'read-only';
      const sandboxPolicy = full ? { type: 'dangerFullAccess' } : { type: 'readOnly', networkAccess: false };
      const options = {
        cwd: folder,
        model,
        modelProvider: PROVIDER,
        approvalPolicy,
        approvalsReviewer: 'user',
        sandbox,
      };
      const opened =
        sessionId === null
          ? await request('thread/start', { ...options, ephemeral: false })
          : await request('thread/resume', { ...options, threadId: sessionId, excludeTurns: true });
      const thread = obj(opened.thread);
      if (opened.modelProvider !== PROVIDER || thread.modelProvider !== PROVIDER || opened.model !== model) {
        throw new Error('Codex did not open the requested native OpenAI model; no prompt was sent.');
      }
      if (
        opened.cwd !== folder ||
        opened.approvalPolicy !== approvalPolicy ||
        opened.approvalsReviewer !== 'user' ||
        obj(opened.sandbox).type !== sandboxPolicy.type ||
        (!full && obj(opened.sandbox).networkAccess === true)
      ) {
        throw new Error('Codex did not apply the requested working directory and access settings; no prompt was sent.');
      }
      threadId = str(thread.id);
      if (
        !threadId ||
        (sessionId !== null && threadId !== sessionId) ||
        thread.ephemeral !== false ||
        obj(thread.status).type !== 'idle'
      ) {
        throw new Error('Codex did not open the requested persistent, idle thread; no prompt was sent.');
      }
      if (stopped || terminal) return;
      if (sessionId === null) {
        const path = str(thread.path);
        if (!isAbsolute(path)) throw new Error('Codex did not return an absolute path for the new session.');
        newRollout = path;
      }
      onSession(threadId, newRollout);
      if (stopped || terminal) return;
      sentTurn = true;
      const started = await request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        effort: effort || null,
        approvalPolicy,
        sandboxPolicy,
      });
      if (terminal) return;
      turnId = str(obj(started.turn).id);
      if (!turnId) throw new Error('Codex did not return a turn ID.');
      clearTimeout(bootTimer);
      if (stopped) interrupt();
      for (const message of early.splice(0)) hear(message);
    }
    void start().catch((error: unknown) => finish(err(error)));

    const outcome = await result;
    signal.removeEventListener('abort', stop);
    child.stdin.end();
    // Give the protocol a chance to wind down, then kill only this turn's own process group. Waiting here keeps
    // the next turn (or worktree deletion) from racing App Server. Codex commands can have their own groups.
    const waitForExit = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        void exited.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    await waitForExit(150);
    if (!closed) {
      kill('SIGTERM');
      await waitForExit(250);
    }
    if (!closed) {
      kill('SIGKILL');
      await waitForExit(500);
    }
    if (!closed) {
      // A descendant could still hold a pipe open after the child exited. These pipes belong to this turn only.
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      await waitForExit(100);
    }
    lines.close();
    // A closed App Server pipe does not prove a command in another process group has stopped.
    if (!closed || (sentTurn && !turnSettled)) {
      const detail = outcome instanceof Error ? ` ${outcome.message}` : '';
      throw new CodexTeardownError(`Could not confirm that Codex and its commands stopped.${detail}`);
    }
    // App Server allocates the ID before writing its history. Leave it provisional if stat fails.
    if (threadId && newRollout) {
      const exists = await hasRollout(newRollout).catch(() => undefined);
      if (exists !== undefined) onSession(exists ? threadId : null);
    }
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}
