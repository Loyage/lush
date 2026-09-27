#!/usr/bin/env bun
import { main } from '../src/cli/main.js';
const [command, ...args] = process.argv.slice(2);
const aliases = {
  start: ['daemon','start'], stop: ['daemon','stop'], 'daemon-start': ['daemon','start'],
  'daemon-stop': ['daemon','stop'], 'daemon-restart': ['daemon','restart'],
  intent: ['intent'], intents: ['intent','list'], drafts: ['draft','list'], aps: ['ap','list'], tree: ['ap','tree'],
  ladder: ['ap','ladder'], timeline: ['ap','timeline'],
  inspect: ['ap','inspect'], transcript: ['ap','transcript'], usage: ['ap','usage'], cancel: ['ap','cancel'], retry: ['ap','retry'],
  merge: ['ap','merge'], cleanup: ['ap','cleanup'], clear: ['ap','clear'], notices: ['notice','list'],
  answer: ['notice','answer'], message: ['ap','message'], wait: ['ap','wait'], specs: ['spec','list'],
  approve: ['plan','approve'], reject: ['plan','reject'], propose: ['plan','propose'],
};
try { await main([...(aliases[command] || [command]), ...args]); }
catch (error) { console.error(`lush: ${error.message}`); process.exitCode = 1; }
