#!/usr/bin/env bun
import { main } from '../src/cli/main.js';
const [command, ...args] = process.argv.slice(2);
const aliases = {
  start: ['daemon','start'], stop: ['daemon','stop'], 'daemon-start': ['daemon','start'],
  'daemon-stop': ['daemon','stop'], 'daemon-restart': ['daemon','restart'],
  workers: ['worker','list'], tree: ['worker','tree'],
  inspect: ['worker','inspect'], transcript: ['worker','transcript'], cancel: ['worker','cancel'], retry: ['worker','retry'],
  cleanup: ['worker','cleanup'], notices: ['notice','list'],
  answer: ['notice','answer'], message: ['worker','message'], wait: ['worker','wait'],
};
try { await main([...(aliases[command] || [command]), ...args]); }
catch (error) { console.error(`lush: ${error.message}`); process.exitCode = 1; }
