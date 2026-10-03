import * as electron from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktop } from './runtime.js';
import { createSSHManager } from './ssh.js';

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
let sshManager = null, sshError = null;
try {
  sshManager = createSSHManager({ userData: app.getPath('userData'),
    payloadDir: app.isPackaged ? path.join(process.resourcesPath, 'remote-payload') : path.join(root, 'node_modules/lush-remote-build/payload') });
} catch (error) {
  // Corrupt SSH metadata must not disable existing local/HTTPS workflows or be silently reset.
  sshError = `SSH 连接管理初始化失败：${error.message}。连接记录未被重置，本地与 Host 地址连接仍可使用。`;
}
const desktop = createDesktop({ electron, userData: app.getPath('userData'), localHost, sshManager, sshError });
void desktop.start().catch(error => {
  dialog.showErrorBox('Lush 无法启动', error.message);
  app.quit();
});
