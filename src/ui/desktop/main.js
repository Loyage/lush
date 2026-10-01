import * as electron from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktop } from './runtime.js';
import { createLocalHost } from './local-host.js';

const { app, dialog } = electron;
const HERE = path.dirname(fileURLToPath(import.meta.url));
app.setName('Lush');
app.setPath('userData', path.join(app.getPath('appData'), 'Lush', 'desktop'));
const root = app.isPackaged ? app.getAppPath() : path.resolve(HERE, '../../..');
const desktop = createDesktop({ electron, userData: app.getPath('userData'), localHost: createLocalHost({ root }) });
void desktop.start().catch(error => {
  dialog.showErrorBox('Lush 无法启动', error.message);
  app.quit();
});
