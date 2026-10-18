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
    expect(deepText(dom.node('detail'))).toContain('内建默认已生效');
    expect(deepText(dom.node('detail'))).not.toContain('尚未统一生效');
    expect(button('保存全局管家权限').disabled).toBe(true);
    expect(writes).toEqual([]);
    const search = dom.node('detail').querySelector('input');
    expect(deepText(dom.node('detail'))).toContain('支持 lush / lushw 完整命令');
    search.value = 'lushc'; search.oninput({});
    expect(dom.node('detail').querySelectorAll('.cli-command-link')).toHaveLength(0);
    search.value = 'lushw'; search.oninput({});
    expect(dom.node('detail').querySelectorAll('.cli-command-link').length).toBeGreaterThan(0);
    expect(dom.node('detail').querySelectorAll('.cli-command-link').every(node => node.dataset.command.startsWith('lushw '))).toBe(true);
    search.value = 'order'; search.oninput({});
    dom.node('detail').querySelector('[data-command="lush order"]').onclick();
    // The minimal DOM fixture does not parse descendant selectors or dotted
    // attribute values; inspect the rendered method rows before selecting.
    const row = dom.node('detail').querySelectorAll('.cli-permission-method').find(node => node.dataset.method === 'draft.add');
    const select = row.querySelector('select');
    select.value = 'confirmation'; select.onchange();
    expect(button('保存全局管家权限').disabled).toBe(false);
    const cancelled = button('保存全局管家权限').onclick();
    expect(deepText(dom.node('modal'))).toContain('当前内建默认已经生效');
    await dialogButton(dom, '取消').onclick(); await cancelled;
    expect(writes).toEqual([]);
    expect(select.value).toBe('confirmation');
    const saving = button('保存全局管家权限').onclick(); await dialogButton(dom, '确认保存更改').onclick(); await saving;
    expect(writes).toEqual(['/api/host/management/permissions']);
    expect(deepText(dom.node('detail'))).toContain('已保存设备全局管家权限');
    const saved = await (await fetch(url + '/api/host/management/permissions')).json();
    expect(saved.configured).toBe(true); expect(saved.scope).toBe('device');
    expect(saved.permissions).toEqual(Object.fromEntries(saved.methods.map(item => [item.method, item.method === 'draft.add' ? 'confirmation' : item.base_access])));
    expect(saved.permissions['worker.cancel']).toBe('automatic');
    expect(saved.methods.find(item => item.method === 'management.permission_set').allowed_access).toEqual(['confirmation', 'unavailable']);
    // The same shipped CLI catalogue now explains typed query parameters in the
    // existing advanced section; browsing never executes the examples.
    await button('返回搜索结果').onclick();
    search.value = 'worker list'; search.oninput({});
    dom.node('detail').querySelector('[data-command="lush worker list"]').onclick();
    const advanced = dom.node('detail').querySelector('details');
    expect(advanced.open).toBe(false);
    expect(deepText(advanced)).toContain('RPC 参数契约（类型、必填、默认值与枚举）');
    expect(deepText(advanced)).toContain('"type": "integer"');
    expect(deepText(advanced)).toContain('"maximum": 1000');
    expect(deepText(advanced)).toContain('RPC 参数示例（仅说明，不执行）');
    expect(deepText(advanced)).toContain('"after": 0');
    expect(writes).toEqual(['/api/host/management/permissions']);
  } finally { ui.disposeValetSettings?.(); dom?.restore(); await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
