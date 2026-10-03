import { SERVER_PORT } from '@acocrew/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { startServer } from './server.ts';

const home = realpathSync(homedir());
const db = openDb(join(home, '.acocrew', 'acocrew.db'));
const { port } = await startServer(SERVER_PORT, { db, query, home });
console.log(`acocrew server listening on http://127.0.0.1:${port}`);
