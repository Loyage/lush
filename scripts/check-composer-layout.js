// Real Firefox app shell, shared unified-editor fixture and assertions.
import { runInputBrowserCheck } from './check-input-history-ui.js';
await runInputBrowserCheck({ scope: 'layout', output: process.argv[2] || '/tmp/lush-composer-layout' });
