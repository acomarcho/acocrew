// Records a real Claude session into a fixture the tests can replay.
//   cd apps/server && node src/fixtures/record.ts <scenario>
// Besides Claude's own messages the file gets marker lines, so the replay knows what the outside world did:
//   {"_user": true}                 the recorder sent the next user message here
//   {"_ask": {...}}                 Claude asked for permission (or asked a question) here
//   {"_quiet": true}                nothing happened for a while (Claude was waiting on background work)
import { query, type Options, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

type Scenario = {
  prompts: string[];
  ask?: boolean;
  decide?: (toolName: string, input: Record<string, unknown>) => PermissionResult;
};

const allow = (_: string, input: Record<string, unknown>): PermissionResult => ({
  behavior: 'allow',
  updatedInput: input,
});

const SCENARIOS: Record<string, Scenario> = {
  background: {
    prompts: [
      'Use the Bash tool with run_in_background set to true to run: sleep 6; echo finished. Then say "started" and end your turn. When you are told it finished, say "all done".',
    ],
  },
  subagent: {
    prompts: [
      'Use the Agent tool (not in the background) to have a subagent read math.js and README.md and report what each one is in one sentence. Then give me its report.',
    ],
  },
  'subagent-background': {
    prompts: [
      'Use the Agent tool with run_in_background set to true to have a subagent read math.js and report what it does in one sentence. Say "launched" and end your turn. When it finishes, give me its report.',
    ],
  },
  approve: {
    ask: true,
    decide: allow,
    prompts: ['Read README.md, then create a file called approved.txt containing the word yes. Then say done.'],
  },
  decline: {
    ask: true,
    decide: () => ({ behavior: 'deny', message: 'The user declined this action.' }),
    prompts: [
      'Create a file called declined.txt containing the word no. If you are not allowed, just say so in one sentence.',
    ],
  },
  question: {
    decide: (toolName, input) =>
      toolName === 'AskUserQuestion'
        ? { behavior: 'allow', updatedInput: { ...input, answers: { 'Which color do you prefer?': 'Blue' } } }
        : allow(toolName, input),
    prompts: [
      'Use the AskUserQuestion tool to ask me exactly this question: "Which color do you prefer?" with header "Color" and the options Red and Blue. Then tell me which one I picked.',
    ],
  },
  todos: {
    prompts: [
      'Make a to-do list with exactly two items using your task list tool: "Read math.js" and "Say hi". Then do them one by one, marking each as in progress and then completed. Finish with "hi".',
    ],
  },
};

const name = process.argv[2];
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`Pick one of: ${Object.keys(SCENARIOS).join(', ')}`);

const out: unknown[] = [];
const prompts = [...scenario.prompts];
let wake = () => {};
async function* input(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    const text = prompts.shift();
    if (!text) return void (await new Promise(() => {}));
    out.push({ _user: true });
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    await new Promise<void>((resolve) => (wake = resolve));
  }
}

const options: Options = {
  cwd: `${homedir()}/acocrew-sample-repo`,
  model: 'claude-haiku-4-5-20251001',
  includePartialMessages: true,
  permissionMode: 'default',
  canUseTool: async (toolName, toolInput, { suggestions, toolUseID }) => {
    const asked = scenario.ask || toolName === 'AskUserQuestion';
    const result = (asked && scenario.decide ? scenario.decide : allow)(toolName, toolInput);
    out.push({ _ask: { toolName, input: toolInput, toolUseID, suggestions }, _answered: result });
    return result;
  },
};

const running = query({ prompt: input(), options });
let tasks = 0;
let last = Date.now();
let quiet: ReturnType<typeof setTimeout> | undefined;
const finish = () => {
  // The first message of a session lists this machine's tools, skills and connectors. Keep only what a replay needs.
  const lines = out.map((m: any) =>
    m.type === 'system' && m.subtype === 'init'
      ? { type: m.type, subtype: m.subtype, session_id: m.session_id, uuid: m.uuid }
      : m,
  );
  writeFileSync(new URL(`./${name}.jsonl`, import.meta.url), lines.map((m) => JSON.stringify(m)).join('\n') + '\n');
  console.log(`wrote ${lines.length} lines`);
  process.exit(0);
};

for await (const msg of running) {
  if (Date.now() - last > 2000) out.push({ _quiet: true });
  last = Date.now();
  out.push(msg);
  clearTimeout(quiet);
  if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') tasks = msg.tasks.length;
  if (msg.type !== 'stream_event')
    console.log(
      msg.type,
      'subtype' in msg ? msg.subtype : '',
      'parent_tool_use_id' in msg && msg.parent_tool_use_id ? '(sub)' : '',
    );
  if (msg.type !== 'result') continue;
  if (prompts.length) wake();
  // Done once Claude is idle with nothing in the background for a few seconds.
  else if (tasks === 0) quiet = setTimeout(finish, 4000);
}
finish();
