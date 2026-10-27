// Claude Code keeps each conversation in a file of its own, one JSON entry per line, and a thread keeps the same
// conversation when it moves between Claude's models and the proxy's. The proxy's models leave thinking that
// Anthropic did not sign, and Anthropic turns a whole conversation down over some of it (a block of nothing but a
// space). So before one of Claude's own models picks a conversation up, the unsigned thinking is taken out.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Block = { type: string; signature?: string };
const unsigned = (block: Block) => block.type === 'thinking' && !block.signature;

// Conversations sit in a folder named after the folder Claude worked in. The SDK does not say which, and a
// conversation id is unique, so every folder is looked in.
function fileOf(sessionId: string) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  if (!existsSync(projects)) return;
  return readdirSync(projects)
    .map((folder) => join(projects, folder, `${sessionId}.jsonl`))
    .find((file) => existsSync(file));
}

export function dropUnsignedThinking(sessionId: string) {
  const file = fileOf(sessionId);
  if (!file) return;
  const kept = readFileSync(file, 'utf8');
  const cleaned = kept
    .split('\n')
    .map((line) => {
      const entry = line ? JSON.parse(line) : undefined;
      const content: Block[] | undefined = entry?.message?.content;
      if (!Array.isArray(content) || !content.some(unsigned)) return line;
      entry.message.content = content.filter((block) => !unsigned(block));
      return JSON.stringify(entry);
    })
    .join('\n');
  if (cleaned !== kept) writeFileSync(file, cleaned);
}
