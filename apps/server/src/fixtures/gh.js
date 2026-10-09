#!/usr/bin/env node
// A stand-in for the GitHub CLI (`gh`) that tests run as a real program. It knows the two commands the server
// uses, and prints what gh 2.93 does. Who is logged in is kept in `hosts.json` in the folder
// GH_CONFIG_DIR names (the real one keeps its own files there), in the shape `gh auth status --json hosts` prints.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = join(process.env.GH_CONFIG_DIR, 'hosts.json');
const status = JSON.parse(readFileSync(file, 'utf8'));
const [, command, ...flags] = process.argv.slice(2);
const flag = (name) => flags[flags.indexOf(name) + 1];

if (command === 'status') {
  console.log(JSON.stringify(status));
  process.exit(0);
}
for (const account of status.hosts[flag('--hostname')]) account.active = account.login === flag('--user');
writeFileSync(file, JSON.stringify(status));
