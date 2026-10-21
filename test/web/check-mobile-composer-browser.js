// Real Firefox narrow iframe and VisualViewport bridge; not a real iOS/Android device check.
import { runInputBrowserCheck } from '../../scripts/check-input-history-ui.js';
await runInputBrowserCheck({ scope: 'mobile', output: '/tmp/lush-mobile-composer' });
