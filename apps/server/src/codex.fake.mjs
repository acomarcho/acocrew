#!/usr/bin/env node
// A local child speaking the Codex 0.160.0 stdio protocol. No model or network calls.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = readFileSync('scenario', 'utf8');
const cwd = process.cwd();
const threadId = '019fed00-0000-7000-8000-000000000001';
const turnId = '019fed00-0000-7000-8000-000000000002';
const agent = {
  type: 'agentMessage',
  id: 'message-1',
  text: 'Hi there!',
  phase: 'final_answer',
  delivery: null,
  questions: [],
};
const command = {
  type: 'commandExecution',
  id: 'command-1',
  command: 'printf "hello\\n"',
  cwd,
  commandActions: [],
  status: 'inProgress',
};
const patch = {
  type: 'fileChange',
  id: 'patch-1',
  changes: [{ path: `${cwd}/test.txt`, kind: { type: 'add' }, diff: 'hello\n' }],
  status: 'inProgress',
};
const itemEvent = (item, done = false) => ({ item, [done ? 'completedAtMs' : 'startedAtMs']: done ? 2 : 1 });
const turn = (status, items = [], error = null) => ({ id: turnId, status, items, error });
const event = (method, params) => ({ method, params: { threadId, turnId, ...params } });
const record = (entry) => appendFileSync('wire.jsonl', `${JSON.stringify(entry)}\n`);
const send = (...lines) => process.stdout.write(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
const response = (id, result = {}) => ({ id, result });
const complete = (status, items, error) => ({
  method: 'turn/completed',
  params: { threadId, turn: turn(status, items, error) },
});

record({ pid: process.pid, argv: process.argv.slice(2), env: process.env });
const input = createInterface({ input: process.stdin });
if (scenario === 'stubborn' || scenario === 'eof') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 10_000);
}
if (scenario === 'boot-stop') setInterval(() => {}, 10_000);

const commandMethod = 'item/commandExecution/requestApproval';
const fileMethod = 'item/fileChange/requestApproval';
const commandRequest = {
  itemId: command.id,
  startedAtMs: 1,
  command: command.command,
  cwd,
  kind: 'command',
  environmentId: 'local',
};
const patchRequest = { itemId: patch.id, startedAtMs: 1 };
const sequence = [
  ['approve', commandMethod, commandRequest],
  ['always', commandMethod, { ...commandRequest, approvalId: 'another-approval' }],
  ['wrong-id', commandMethod, commandRequest],
  ['patch', fileMethod, patchRequest],
  ['grant-root', fileMethod, { ...patchRequest, grantRoot: cwd }],
  ['missing-patch', fileMethod, { ...patchRequest, itemId: 'missing' }],
  ['network', commandMethod, { ...commandRequest, networkApprovalContext: { host: 'example.com', protocol: 'https' } }],
  [
    'network-amendment',
    commandMethod,
    { ...commandRequest, proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }] },
  ],
  ['extra-permissions', commandMethod, { ...commandRequest, additionalPermissions: { network: { enabled: true } } }],
  ['stdin', commandMethod, { ...commandRequest, kind: 'writeStdin' }],
  ['old-turn', commandMethod, { ...commandRequest, turnId: 'old-turn' }],
  ['no-turn', commandMethod, { ...commandRequest, turnId: null }],
  [
    'permissions',
    'item/permissions/requestApproval',
    { itemId: 'p', startedAtMs: 1, permissions: { network: { enabled: true } } },
  ],
  ['question', 'item/tool/requestUserInput', { itemId: 'q', isBlocking: true, questions: [] }],
  [
    'elicitation',
    'mcpServer/elicitation/request',
    {
      serverName: 'example',
      request: { mode: 'url', message: 'Sign in', url: 'https://example.com', elicitationId: 'e' },
    },
  ],
  ['dynamic', 'item/tool/call', { callId: 't', tool: 'example', arguments: {} }],
  [
    'legacy',
    'execCommandApproval',
    { conversationId: threadId, callId: command.id, command: ['printf', 'hi'], cwd, parsedCmd: [] },
  ],
  ['auth', 'account/chatgptAuthTokens/refresh', { reason: 'unauthorized' }],
  ['unknown', 'new/unknownRequest', {}],
  ['cancel', commandMethod, commandRequest],
];
let step = 0;
function askNext() {
  const next = sequence[step++];
  if (!next) return send(complete('interrupted'));
  const [id, method, params] = next;
  send({ id, ...event(method, params) });
}

input.on('line', (line) => {
  const msg = JSON.parse(line);
  record(msg);
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      if (scenario !== 'boot-stop')
        send(
          response(id, {
            userAgent: 'acocrew/0.160.0',
            codexHome: process.env.CODEX_HOME,
            platformFamily: 'unix',
            platformOs: 'linux',
          }),
        );
      return;
    case 'initialized':
      return;
    case 'config/read': {
      const config = {};
      for (let i = 2; i < process.argv.slice(2).length; i += 2) {
        const raw = process.argv[i + 3];
        const at = raw.indexOf('=');
        const [key, field] = raw.slice(0, at).split('.');
        if (key === 'projects') continue;
        const value = JSON.parse(raw.slice(at + 1));
        if (field) (config[key] ??= {})[field] = value;
        else config[key] = value;
      }
      if (scenario === 'wrong-config') config.openai_base_url = 'https://example.invalid';
      if (scenario === 'mcp-config') config.mcp_servers = { inherited: { enabled: true } };
      return send(response(id, { config, origins: {} }));
    }
    case 'account/read':
      return send(
        response(id, {
          requiresOpenaiAuth: true,
          account: scenario === 'api-key' ? { type: 'apiKey' } : { type: 'chatgpt', email: null, planType: 'plus' },
        }),
      );
    case 'thread/start':
    case 'thread/resume': {
      if (scenario === 'resume-error') return send({ id, error: { code: -32600, message: 'no rollout found' } });
      const modelProvider = scenario === 'wrong-provider' ? 'proxy' : params.modelProvider;
      const sandbox =
        params.sandbox === 'read-only'
          ? { type: 'readOnly', networkAccess: scenario === 'wrong-sandbox' }
          : { type: 'dangerFullAccess' };
      const thread = {
        id: scenario === 'wrong-id' ? '019fed00-0000-7000-8000-000000000003' : threadId,
        sessionId: threadId,
        cliVersion: '0.160.0',
        source: 'vscode',
        createdAt: 1,
        updatedAt: 1,
        preview: '',
        projectId: null,
        modelProvider,
        model: params.model,
        cwd,
        ephemeral: false,
        turns: [],
        status: { type: 'idle' },
      };
      return send(
        response(id, {
          thread,
          modelProvider,
          model: params.model,
          cwd,
          sandbox,
          approvalPolicy: params.approvalPolicy,
          approvalsReviewer: 'user',
        }),
      );
    }
    case 'turn/start': {
      if (scenario === 'stubborn') return;
      const ack = response(id, { turn: turn('inProgress') });
      if (scenario === 'early-stop') return void setTimeout(() => send(ack), 150);
      if (scenario === 'late-approval' || scenario === 'stop-approval') {
        send(ack, { id: 'late', ...event(commandMethod, commandRequest) });
        if (scenario === 'late-approval')
          send(event('serverRequest/resolved', { requestId: 'late' }), complete('completed'));
        return;
      }
      if (scenario === 'eof') {
        send(ack);
        process.stdout.end();
        return;
      }
      if (scenario === 'bad-json') return process.stdout.write('not json\n');
      if (scenario === 'failed')
        return send(
          ack,
          event('error', { error: { message: 'provider said no' }, willRetry: false }),
          complete('failed'),
        );
      if (scenario === 'approvals') {
        send(event('item/started', itemEvent(patch)));
        send({ id: 'approve', ...event(commandMethod, commandRequest) }, ack);
        step++;
        return;
      }
      if (scenario === 'late-output') {
        send(ack, complete('completed'));
        const extra = JSON.stringify(event('item/agentMessage/delta', { itemId: agent.id, delta: 'x'.repeat(4_096) }));
        process.stdout.write(`${extra}\n`.repeat(512), () => record({ flushed: true }));
        return;
      }
      const finished = { ...command, status: 'completed', aggregatedOutput: 'hello\n', exitCode: 0 };
      const failedPatch = { ...patch, status: 'failed' };
      return send(
        event('item/agentMessage/delta', { itemId: agent.id, delta: 'not this thread', threadId: 'old-thread' }),
        event('item/agentMessage/delta', { itemId: agent.id, delta: 'Hi' }),
        ack,
        event('item/started', itemEvent({ ...agent, text: '' })),
        event('item/started', itemEvent(command)),
        event('item/commandExecution/outputDelta', { itemId: command.id, delta: 'hello\n' }),
        event('item/completed', itemEvent(finished, true)),
        event('item/agentMessage/delta', { itemId: agent.id, delta: ' there' }),
        event('item/completed', itemEvent(agent, true)),
        event('item/agentMessage/delta', { itemId: agent.id, delta: 'not another turn', turnId: 'old-turn' }),
        event('item/completed', itemEvent(failedPatch, true)),
        complete('completed', [agent]),
        event('item/agentMessage/delta', { itemId: agent.id, delta: 'not after completion' }),
      );
    }
    case 'turn/interrupt':
      return send(
        response(id),
        event('item/agentMessage/delta', { itemId: agent.id, delta: 'not after stop' }),
        complete('interrupted'),
      );
    default:
      if (scenario === 'approvals' && id === sequence[step - 1]?.[0]) askNext();
  }
});
