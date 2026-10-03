// Records what the real Claude says when asked to name a thread, into title.jsonl.
// Run: node src/fixtures/record-title.ts (uses this machine's Claude login).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync } from 'node:fs';
import { titleQuery } from '../title.ts';

const lines: unknown[] = [];
for await (const msg of query(titleQuery('make notes'))) {
  // The first message of a session lists this machine's tools, skills and connectors. Keep only what a replay needs.
  const init = msg.type === 'system' && msg.subtype === 'init';
  lines.push(init ? { type: msg.type, subtype: msg.subtype, session_id: msg.session_id, uuid: msg.uuid } : msg);
}
writeFileSync(new URL('./title.jsonl', import.meta.url), lines.map((m) => JSON.stringify(m)).join('\n') + '\n');
console.log(`wrote ${lines.length} lines`);
