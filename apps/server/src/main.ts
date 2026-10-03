import { SERVER_PORT } from '@acocrew/shared';
import { startServer } from './server.ts';

const { port } = await startServer(SERVER_PORT);
console.log(`acocrew server listening on http://127.0.0.1:${port}`);
