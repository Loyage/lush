import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { env, temp } from '../helpers.js';
import { startTestWeb, fetch } from './auth-fixture.js';
import { openCliInterfaces } from '../../src/ui/web/assets/render-valet-settings.js';
import { registerPageLeaveGuard } from '../../src/ui/web/assets/page-leave-guard.js';
import { ui } from '../../src/ui/web/assets/state.js';

test('global CLI page reads and saves default Valet permissions through real Host HTTP without a project', async () => {
  const root = temp(), home = path.join(root, 'device');
  const web = startTestWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: home }) }), url = `http://127.0.0.1:${web.port}`;
  let dom;
  try {
    const html = await (await fetch(url + '/')).text();
    const asset = /<meta id="cli-catalog-asset" content="([^"]+)"/.exec(html)[1];
    const writes = [];
    dom = installDom({ fetch: (route, options) => {
      if (options?.method === 'POST') writes.push(String(route));
      return fetch(url + route, options);
    } });
    dom.node('cli-catalog-asset').setAttribute('content', asset);
    await openCliInterfaces({ registerPageLeaveGuard });
    const button = label => dom.node('detail').querySelectorAll('button').find(node => node.textContent === label);
    await button('读取全局权限').onclick();
    const saving = button('保存全局管家权限').onclick(); await dialogButton(dom, '确认全局生效').onclick(); await saving;
    expect(writes).toEqual(['/api/host/management/permissions']);
    expect(deepText(dom.node('detail'))).toContain('已保存设备全局管家权限');
    const saved = await (await fetch(url + '/api/host/management/permissions')).json();
    expect(saved.configured).toBe(true); expect(saved.scope).toBe('device');
    expect(saved.permissions).toEqual(Object.fromEntries(saved.methods.map(item => [item.method, item.base_access])));
  } finally { ui.disposeValetSettings?.(); dom?.restore(); await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
