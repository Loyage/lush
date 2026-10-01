import * as electron from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktop } from './runtime.js';

const { app, dialog } = electron;
const HERE = path.dirname(fileURLToPath(import.meta.url));
app.setName('Lush');
app.setPath('userData', path.join(app.getPath('appData'), 'Lush', 'desktop'));
const root = app.isPackaged ? app.getAppPath() : path.resolve(HERE, '../../..');
// Windows is a remote UI client; do not load or ship the Unix-only local runtime.
let localHost = null;
if (process.platform !== 'win32') {
  const { createLocalHost } = await import('./local-host.js');
  localHost = createLocalHost({ root });
}
if (process.platform === 'win32') app.setAppUserModelId('dev.lush.desktop');
const desktop = createDesktop({ electron, userData: app.getPath('userData'), localHost });
void desktop.start().catch(error => {
  dialog.showErrorBox('Lush 无法启动', error.message);
  app.quit();
});
