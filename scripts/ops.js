#!/usr/bin/env bun
import { main } from '../src/cli/main.js';
const [command, ...args] = process.argv.slice(2);
const aliases = {
  start: ['daemon','start'], stop: ['daemon','stop'], 'daemon-start': ['daemon','start'],
  'daemon-stop': ['daemon','stop'], 'daemon-restart': ['daemon','restart'],
  intent: ['say'], intents: ['input','list'], drafts: ['draft','list'], tasks: ['task','list'], tree: ['task','tree'],
  ladder: ['task','ladder'], timeline: ['task','timeline'],
  inspect: ['task','inspect'], transcript: ['task','transcript'], usage: ['task','usage'], cancel: ['task','cancel'], retry: ['task','retry'],
  merge: ['task','merge'], cleanup: ['task','cleanup'], clear: ['task','clear'], notices: ['notice','list'],
  answer: ['notice','answer'], message: ['task','message'], wait: ['task','wait'],
};
try { await main([...(aliases[command] || [command]), ...args]); }
catch (error) { console.error(`lush: ${error.message}`); process.exitCode = 1; }
