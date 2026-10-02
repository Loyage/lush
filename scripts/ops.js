#!/usr/bin/env bun
import { main } from '../src/cli/main.js';
const [command, ...args] = process.argv.slice(2);
const aliases = {
  start: ['daemon','start'], stop: ['daemon','stop'], 'daemon-start': ['daemon','start'],
  'daemon-stop': ['daemon','stop'], 'daemon-restart': ['daemon','restart'],
  intent: ['intent'], intents: ['intent','list'], drafts: ['draft','list'], workers: ['worker','list'], tree: ['worker','tree'],
  ladder: ['worker','ladder'], timeline: ['worker','timeline'],
  inspect: ['worker','inspect'], transcript: ['worker','transcript'], usage: ['worker','usage'], cancel: ['worker','cancel'], retry: ['worker','retry'],
  merge: ['worker','merge'], cleanup: ['worker','cleanup'], clear: ['worker','clear'], notices: ['notice','list'],
  answer: ['notice','answer'], message: ['worker','message'], wait: ['worker','wait'], specs: ['spec','list'],
  approve: ['plan','approve'], reject: ['plan','reject'], propose: ['plan','propose'],
};
try { await main([...(aliases[command] || [command]), ...args]); }
catch (error) { console.error(`lush: ${error.message}`); process.exitCode = 1; }
