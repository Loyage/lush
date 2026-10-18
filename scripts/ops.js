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
  progress: ['self','progress'],
};
// Source shortcuts select the same fixed public entry as the corresponding bin.
// Targeted message is project management; only progress binds to the current Worker.
// Development messages use explicit lushw parent/children relationships.
const executable = command === 'progress' ? 'lushw' : 'lush';
try { await main([...(aliases[command] || [command]), ...args], { executable }); }
catch (error) { console.error(`${executable}: ${error.message}`); process.exitCode = 1; }
