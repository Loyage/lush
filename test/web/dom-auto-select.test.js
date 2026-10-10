import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderAutoSelectBanner, applyAutoSelectCatalogue } from '../../src/ui/web/assets/auto-select-banner.js';
import { deviceAutomationStatus, onDeviceAutomation, refreshDeviceAutomation } from '../../src/ui/web/assets/workspace-automation.js';
let dom, model, requests, failRead, failWrite, dispose;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => {
  model = { version: 1, revision: 'r1', auto_select: { enabled: true }, completion_defaults: { enabled: false, level: 'merge' } };
  requests = []; failRead = failWrite = false;
  dom = installDom({ fetch: async (path, options) => {
    requests.push({ path: String(path), options });
    if (options?.method === 'POST') {
      if (failWrite) return json({ error: 'Host 不可达' }, 503);
      const body = JSON.parse(options.body); expect(body.expected_revision).toBe('r1');
      model = { ...model, ...body.patch, revision: 'r2' };
    } else if (failRead) throw Error('读取失败');
    return json(model);
  } });
  dispose = onDeviceAutomation(status => renderAutoSelectBanner(status.model, { offline: status.offline }));
});
afterEach(() => { dispose(); dom.restore(); });
const control = () => dom.node('auto-select-banner').querySelector('button');

test('both shells show one global policy; project snapshots do not repaint it', () => {
  renderAutoSelectBanner(null); expect(dom.node('auto-select-banner').hidden).toBe(true);
  applyAutoSelectCatalogue(model); expect(dom.node('auto-select-banner').hidden).toBe(false);
  expect(deepText(dom.node('auto-select-banner'))).toContain('全局自动选择已开启');
  renderAutoSelectBanner({ enabled: false, revision: 'project' });
  expect(dom.node('auto-select-banner').hidden).toBe(false);
  expect(control().classList.contains('agent-call')).toBe(false);
});

test('project offline does not prevent closing global policy through Host', async () => {
  dom.location.pathname = '/p/1111111111111111/'; applyAutoSelectCatalogue(model);
  const link = dom.node('auto-select-banner').querySelector('a');
  expect(link.href).toBe('/#notices-automatic'); expect(link.target).toBe('_blank');
  await control().onclick(); await settle();
  const post = requests.find(row => row.options?.method === 'POST');
  expect(post.path).toBe('/api/host/automation');
  expect(JSON.parse(post.options.body)).toEqual({ patch: { auto_select: { enabled: false } }, expected_revision: 'r1' });
  expect(dom.node('auto-select-banner').hidden).toBe(true);
});

test('offline known-enabled banner explains disabled close with a focusable help host', async () => {
  applyAutoSelectCatalogue(model); renderAutoSelectBanner(model, { offline: true });
  expect(control().disabled).toBe(true); const host = control().parentNode;
  expect(host.classList.contains('help-host')).toBe(true); expect(host.tabIndex).toBe(0);
  expect(host.getAttribute('data-help')).toContain('Host 当前不可达');
  await control().onclick(); expect(requests).toHaveLength(0);
});

test('successful close ACK and later read failure are separate facts', async () => {
  applyAutoSelectCatalogue(model); failRead = true;
  await control().onclick(); await settle();
  expect(deviceAutomationStatus().model.auto_select.enabled).toBe(false);
  expect(dom.node('auto-select-banner').hidden).toBe(true);
  expect(dom.node('error').textContent).toContain('已经确认关闭');
});

test('failed close preserves enabled policy and does not claim an ACK', async () => {
  applyAutoSelectCatalogue(model); failWrite = failRead = true;
  await control().onclick(); await settle();
  expect(dom.node('auto-select-banner').hidden).toBe(false); expect(control().disabled).toBe(true);
  expect(dom.node('error').textContent).toContain('关闭结果仍未确认');
});

test('a pending old root read cannot re-enable an acknowledged close', async () => {
  applyAutoSelectCatalogue(model);
  let release; const old = structuredClone(model);
  globalThis.fetch = async (_path, options) => {
    if (!options) return new Promise(resolve => release = () => resolve(json(old)));
    model = { ...model, revision: 'closed', auto_select: { enabled: false } }; return json(model);
  };
  const read = refreshDeviceAutomation(); await control().onclick(); release(); await read; await settle();
  expect(dom.node('auto-select-banner').hidden).toBe(true);
});
